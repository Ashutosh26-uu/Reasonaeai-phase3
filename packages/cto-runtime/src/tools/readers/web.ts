/**
 * The web reader: one http(s) target, rendered as text.
 *
 * The rendering rules are spectra's `web_fetch` — drop the page chrome, convert
 * HTML to markdown, pretty-print JSON — with the transport edges this tool needs
 * on top: a byte budget enforced while the body streams, one whole-request time
 * budget, and a refusal to let a URL reach the runtime's own network.
 *
 * A URL is the only target a caller can point anywhere, so the address checks
 * (literal and resolved) and the per-hop redirect validation are the reason this
 * is more than `fetch().then((response) => response.text())`. Spectra checked a
 * literal host in an `SsrfGuard` in front of the tool and then let `fetch`
 * follow redirects for it, which leaves a name that resolves into the private
 * network and every hop after the first unexamined; both are refused here,
 * because "fetch anything the caller names" is a request-forgery primitive
 * against the runtime's host and its cloud metadata service.
 *
 * Node's global `fetch` is the transport, so there is no HTTP dependency to
 * keep patched.
 */

import { lookup } from "node:dns/promises";

import { XMLParser } from "fast-xml-parser";
import TurndownService from "turndown";

import {
  type FormatReader,
  ReaderLimitError,
  type ReaderRequest,
  type ReaderResult,
  UnsupportedFormatError,
} from "./types.js";

/** The whole-request budget, matching spectra's 15-second web fetch. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Redirect hops followed before the chain is refused as a loop. */
const MAX_REDIRECTS = 20;

/** Identifies the runtime to servers that reject anonymous clients. */
const USER_AGENT = "reasonate-cto-runtime/0.1";

/** The text formats this reader can render. Anything else is refused, not dumped. */
const ACCEPT_HEADER =
  "text/html,application/xhtml+xml,application/xml,application/json,text/plain;q=0.9,*/*;q=0.1";

/** Statuses that continue a chain rather than ending it. */
const REDIRECT_STATUSES: readonly number[] = [301, 302, 303, 307, 308];

const BLANK_LINES_PATTERN = /\n{3,}/g;
const ENTITY_PATTERN = /&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/gi;
const IPV4_OCTET_PATTERN = /^\d{1,3}$/;
const IPV6_BRACKETS_PATTERN = /^\[|\]$/g;
const IPV6_ZONE_PATTERN = /%.*$/;
const MARKUP_PATTERN = /<[^>]*>/g;
const TITLE_PATTERN = /<title[^>]*>([\s\S]*?)<\/title>/i;
const TRAILING_DOT_PATTERN = /\.$/;
const WHITESPACE_PATTERN = /\s+/g;

/**
 * The five named entities and escaped apostrophe spectra's fetch decoded. The
 * conversion libraries produce real characters, so this only matters for text
 * read straight out of the markup, such as the title.
 */
const NAMED_ENTITIES: Record<string, string> = {
  "&#39;": "'",
  "&amp;": "&",
  "&gt;": ">",
  "&lt;": "<",
  "&nbsp;": " ",
  "&quot;": '"',
};

/** Host names that never name a public service, refused before any DNS lookup. */
const BLOCKED_HOST_NAMES: Record<string, string> = {
  localhost: "a loopback host name",
  "localhost.localdomain": "a loopback host name",
};

const BLOCKED_HOST_SUFFIXES: Record<string, string> = {
  ".internal": "an internal host name",
  ".local": "an mDNS host name",
  ".localhost": "a loopback host name",
};

/**
 * IPv6 prefixes whose trailing 32 bits are a mapped or translated IPv4 address.
 * Without this, `::ffff:127.0.0.1` and a NAT64 prefix would pass an
 * IPv4-shaped refusal and reach the same private host. One entry covers both
 * NAT64 prefixes, because the IPv4 address is the trailing 32 bits in each.
 */
const IPV4_EMBEDDED_PREFIXES: readonly string[] = ["::ffff:", "64:ff9b:"];

/**
 * IPv4 ranges that are never a public destination, written as dotted bounds so
 * the table stays reviewable. Loopback and link-local are here because a read
 * must not reach the runtime's own host or its cloud metadata service.
 */
const IPV4_RANGES: readonly Ipv4Range[] = [
  {
    first: "0.0.0.0",
    last: "0.255.255.255",
    reason: "a non-routable this-network address",
  },
  { first: "10.0.0.0", last: "10.255.255.255", reason: "a private address" },
  {
    first: "100.64.0.0",
    last: "100.127.255.255",
    reason: "a carrier-grade NAT address",
  },
  { first: "127.0.0.0", last: "127.255.255.255", reason: "a loopback address" },
  {
    first: "169.254.0.0",
    last: "169.254.255.255",
    reason: "a link-local address",
  },
  { first: "172.16.0.0", last: "172.31.255.255", reason: "a private address" },
  {
    first: "192.0.0.0",
    last: "192.0.0.255",
    reason: "an IETF protocol assignment",
  },
  {
    first: "192.0.2.0",
    last: "192.0.2.255",
    reason: "a documentation-only address",
  },
  {
    first: "192.168.0.0",
    last: "192.168.255.255",
    reason: "a private address",
  },
  {
    first: "198.18.0.0",
    last: "198.19.255.255",
    reason: "a benchmarking address",
  },
  {
    first: "198.51.100.0",
    last: "198.51.100.255",
    reason: "a documentation-only address",
  },
  {
    first: "203.0.113.0",
    last: "203.0.113.255",
    reason: "a documentation-only address",
  },
  {
    first: "224.0.0.0",
    last: "239.255.255.255",
    reason: "a multicast address",
  },
  {
    first: "240.0.0.0",
    last: "255.255.255.255",
    reason: "a reserved address",
  },
];

/**
 * One parser for every XML response: the options never change and `parse` keeps
 * no state between calls.
 */
const XML_PARSER = new XMLParser({
  attributeNamePrefix: "@_",
  ignoreAttributes: false,
  textNodeName: "#text",
});

/**
 * Elements that are page furniture rather than the content of the page.
 *
 * Declared as literals rather than `string[]` because the markdown converter
 * accepts only known tag names, and widening them to `string` is what makes the
 * filter argument unassignable.
 */
const CHROME_ELEMENTS = [
  "aside",
  "base",
  "footer",
  "form",
  "head",
  "header",
  "iframe",
  "link",
  "meta",
  "nav",
  "noscript",
  "script",
  "style",
  "template",
  "title",
] as const;

/** Options for a reader instance. The default reader permits nothing private. */
export interface WebReaderOptions {
  /**
   * Hosts exempt from the private-address refusal, matched case-insensitively
   * against the URL host and against every address it resolves to. Empty by
   * default, so only the public internet is reachable; a caller that means to
   * read a known internal service names it here. Egress stays deny-by-default.
   */
  allowedHosts?: readonly string[] | undefined;
  /** Whole-request time budget in milliseconds. Defaults to 15 seconds. */
  timeoutMs?: number | undefined;
}

/** The resolved policy one reader instance reads under. */
interface WebReaderConfig {
  readonly allowedHosts: readonly string[];
  readonly timeoutMs: number;
}

/** One non-public IPv4 range, as dotted bounds. */
interface Ipv4Range {
  readonly first: string;
  readonly last: string;
  readonly reason: string;
}

/** The mutable progress of a body being read chunk by chunk. */
interface BodyReadState {
  readonly allowed: number;
  readonly decoder: TextDecoder;
  readonly parts: string[];
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  total: number;
}

/** A response, and where in the redirect chain it came from. */
interface FetchedResource {
  readonly redirects: number;
  readonly response: Response;
  readonly url: URL;
}

/** A body rendered as the text the caller sees. */
interface RenderedBody {
  readonly contentType: ReaderResult["contentType"];
  readonly text: string;
  readonly title: string | undefined;
}

const DEFAULT_CONFIG: WebReaderConfig = {
  allowedHosts: [],
  timeoutMs: REQUEST_TIMEOUT_MS,
};

/** The default reader: the public internet only. */
export const webReader: FormatReader = {
  extensions: [],
  matches: matchesWebTarget,
  name: "web",
  read: (request) => readWebTarget(request, DEFAULT_CONFIG),
};

/**
 * A reader that also permits the named hosts.
 *
 * This is the one override of the private-address refusal, and it is a list of
 * hosts rather than a flag so it can be audited: a caller that wants an internal
 * documentation host names that host, and every other hop is still checked.
 */
export function createWebReader(options: WebReaderOptions = {}): FormatReader {
  const config: WebReaderConfig = {
    allowedHosts: (options.allowedHosts ?? []).map(normalizeHost),
    timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
  };

  return { ...webReader, read: (request) => readWebTarget(request, config) };
}

/** Raised when a target is refused before any connection is attempted. */
export class WebTargetRefusedError extends Error {
  /** The URL that was refused, so a caller can report which target it meant. */
  readonly target: string;

  constructor(target: string, reason: string) {
    super(`Refusing to fetch ${target}: ${reason}`);
    this.name = "WebTargetRefusedError";
    this.target = target;
  }
}

/** Whether the target is an absolute http or https URL. */
function matchesWebTarget(
  request: Pick<ReaderRequest, "path" | "selector">
): boolean {
  const url = parseUrl(request.path);
  return (
    url !== undefined && (url.protocol === "http:" || url.protocol === "https:")
  );
}

/** Read one URL as markdown, plain text, or JSON. */
async function readWebTarget(
  request: ReaderRequest,
  config: WebReaderConfig
): Promise<ReaderResult> {
  const { limits, path } = request;
  const requested = parseUrl(path);

  if (requested === undefined) {
    throw new UnsupportedFormatError(`${path} is not a URL`);
  }

  // Node unrefs this timer, so a refusal that happens before the fetch does not
  // hold the process open for the rest of the budget.
  const signal = AbortSignal.timeout(config.timeoutMs);

  try {
    const { redirects, response, url } = await fetchUrl(
      requested,
      config,
      signal,
      0
    );

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `HTTP ${response.status} ${response.statusText} for ${url.href}`
      );
    }

    const mediaType = mediaTypeOf(response.headers.get("content-type"));
    const rendered = renderBody(
      await readBody(response, limits.maxResourceBytes),
      mediaType,
      url
    );

    return {
      contentType: rendered.contentType,
      immutable: true,
      notes: buildNotes(response.status, redirects, requested),
      text: `${formatSource(url, rendered.title)}\n\n${rendered.text}`,
    };
  } catch (error) {
    throw translateFailure(error, requested, config.timeoutMs);
  }
}

/**
 * Fetch a target, following redirects by hand so that the address rules apply
 * to every hop. An automatic follow would let a public host bounce the runtime
 * into its own network — the exact hop the checks exist to stop.
 */
async function fetchUrl(
  target: URL,
  config: WebReaderConfig,
  signal: AbortSignal,
  redirects: number
): Promise<FetchedResource> {
  await assertFetchable(target, config);

  const response = await fetch(target, {
    headers: { Accept: ACCEPT_HEADER, "User-Agent": USER_AGENT },
    redirect: "manual",
    signal,
  });

  if (!REDIRECT_STATUSES.includes(response.status)) {
    return { redirects, response, url: target };
  }

  const location = response.headers.get("location");
  await response.body?.cancel();

  if (location === null) {
    throw new Error(
      `HTTP ${response.status} from ${target.href} carried no Location header`
    );
  }
  if (redirects >= MAX_REDIRECTS) {
    throw new Error(
      `Refusing to follow more than ${MAX_REDIRECTS} redirects starting at ${target.href}`
    );
  }

  return fetchUrl(
    redirectTarget(location, target),
    config,
    signal,
    redirects + 1
  );
}

/**
 * Refuse a hop that is not a public http(s) destination, before any connection.
 *
 * The literal host is checked first, so `localhost` and `127.0.0.1` cost no DNS
 * lookup; a name is then resolved and *every* address it answers with is
 * checked, so a DNS name pointing at loopback is refused rather than trusted.
 */
async function assertFetchable(
  target: URL,
  config: WebReaderConfig
): Promise<void> {
  const { href, password, protocol, username } = target;

  if (protocol !== "http:" && protocol !== "https:") {
    throw new UnsupportedFormatError(
      `Refusing to read ${href}: only http and https URLs are supported`
    );
  }
  if (username !== "" || password !== "") {
    throw new WebTargetRefusedError(href, "it embeds credentials");
  }

  const host = normalizeHost(target.hostname);
  if (config.allowedHosts.includes(host)) {
    return;
  }

  const literal = blockedTargetReason(host);
  if (literal !== undefined) {
    throw new WebTargetRefusedError(href, `${host} is ${literal}`);
  }

  const addresses = await resolveHost(host, href);
  for (const address of addresses) {
    if (config.allowedHosts.includes(address)) {
      continue;
    }
    const resolved = blockedTargetReason(address);
    if (resolved !== undefined) {
      throw new WebTargetRefusedError(
        href,
        `it resolves to ${address}, ${resolved}`
      );
    }
  }
}

/** Every address a name resolves to, or a failure that keeps the resolver's cause. */
async function resolveHost(
  host: string,
  target: string
): Promise<readonly string[]> {
  try {
    const records = await lookup(host, { all: true });

    if (records.length === 0) {
      throw new Error("the resolver returned no addresses");
    }

    return records.map((record) => record.address);
  } catch (error) {
    throw new Error(`Could not resolve ${host} for ${target}`, {
      cause: error,
    });
  }
}

/** The absolute URL a Location header names, relative to the response's URL. */
function redirectTarget(location: string, base: URL): URL {
  try {
    return new URL(location, base);
  } catch (error) {
    throw new Error(
      `A redirect from ${base.href} pointed at an unparseable location: ${location}`,
      { cause: error }
    );
  }
}

/**
 * Read the body in chunks, refusing the moment the allowance is spent instead of
 * buffering the whole response first. Chunks are decoded as they arrive so the
 * bytes are never held twice, and a multi-byte character split across a chunk
 * boundary still decodes.
 */
async function readBody(response: Response, allowed: number): Promise<string> {
  const { body } = response;

  if (body === null) {
    return "";
  }

  const state: BodyReadState = {
    allowed,
    decoder: new TextDecoder("utf-8"),
    parts: [],
    reader: body.getReader(),
    total: 0,
  };

  await pumpBody(state);
  state.parts.push(state.decoder.decode());

  return state.parts.join("");
}

/**
 * One chunk, then the next. Reading a stream is inherently sequential, so this
 * recurses rather than awaiting inside a loop.
 */
async function pumpBody(state: BodyReadState): Promise<void> {
  const { done, value } = await state.reader.read();

  // `done` and `value` are correlated by the stream contract, but destructuring
  // drops the correlation, so the undefined case is handled here.
  if (done === true || value === undefined) {
    return;
  }

  state.total += value.byteLength;
  if (state.total > state.allowed) {
    await state.reader.cancel();
    throw new ReaderLimitError("maxResourceBytes", state.total, state.allowed);
  }

  state.parts.push(state.decoder.decode(value, { stream: true }));

  return pumpBody(state);
}

/** Render a body as text, refusing a media type that is not text. */
function renderBody(raw: string, mediaType: string, url: URL): RenderedBody {
  if (mediaType === "text/html" || mediaType === "application/xhtml+xml") {
    return {
      contentType: "text/markdown",
      text: htmlToMarkdown(raw),
      title: extractTitle(raw),
    };
  }

  if (mediaType === "application/json" || mediaType.endsWith("+json")) {
    return {
      contentType: "application/json",
      text: parseJson(raw, url),
      title: undefined,
    };
  }

  if (
    mediaType === "application/xml" ||
    mediaType === "text/xml" ||
    mediaType.endsWith("+xml")
  ) {
    return {
      contentType: "application/json",
      text: parseXml(raw, url),
      title: undefined,
    };
  }

  if (mediaType === "" || mediaType.startsWith("text/")) {
    return { contentType: "text/plain", text: raw.trim(), title: undefined };
  }

  // A PDF or an image is not text, and a decoded byte dump presented as content
  // is worse than a refusal: the caller cannot tell content from noise.
  throw new UnsupportedFormatError(
    `Refusing to read ${url.href}: ${mediaType} is not a text format`
  );
}

/** HTML as markdown, with the page chrome dropped, as spectra's reader did. */
function htmlToMarkdown(html: string): string {
  const service = new TurndownService({
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    headingStyle: "atx",
  });
  service.remove([...CHROME_ELEMENTS]);

  return service.turndown(html).replace(BLANK_LINES_PATTERN, "\n\n").trim();
}

/** The `<title>` of a page, when it has one. */
function extractTitle(html: string): string | undefined {
  const match: RegExpExecArray | null = TITLE_PATTERN.exec(html);
  const raw = match === null ? undefined : match[1];

  if (raw === undefined) {
    return undefined;
  }

  const title = raw
    .replace(MARKUP_PATTERN, "")
    .replace(ENTITY_PATTERN, (entity) => NAMED_ENTITIES[entity] ?? entity)
    .replace(WHITESPACE_PATTERN, " ")
    .trim();

  return title === "" ? undefined : title;
}

/** A JSON body, pretty-printed the way spectra returned it. */
function parseJson(raw: string, url: URL): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    return JSON.stringify(parsed, null, 2);
  } catch (error) {
    throw new Error(
      `The response from ${url.href} declared JSON but could not be parsed`,
      { cause: error }
    );
  }
}

/** An XML body, as the tree fast-xml-parser reads, pretty-printed as JSON. */
function parseXml(raw: string, url: URL): string {
  try {
    return JSON.stringify(XML_PARSER.parse(raw), null, 2);
  } catch (error) {
    throw new Error(
      `The response from ${url.href} declared XML but could not be parsed`,
      { cause: error }
    );
  }
}

/** The media type of a Content-Type header, without its parameters. */
function mediaTypeOf(header: string | null): string {
  const [declared = ""] = (header ?? "").split(";");
  return declared.trim().toLowerCase();
}

/** The header that names where the text came from. */
function formatSource(url: URL, title: string | undefined): string {
  const lines = [`Source: ${url.href}`];

  if (title !== undefined) {
    lines.push(`Title: ${title}`);
  }

  return lines.join("\n");
}

/** Facts worth showing beside the content, including a redirect that moved it. */
function buildNotes(
  status: number,
  redirects: number,
  requested: URL
): string[] {
  const notes = [`HTTP ${status}`];

  if (redirects > 0) {
    notes.push(`followed ${redirects} redirect(s) from ${requested.href}`);
  }

  return notes;
}

/** An absolute URL, or `undefined` when the text is not one. */
function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/** A host name or literal with the URL syntax trimmed off, for comparison. */
function normalizeHost(host: string): string {
  return host
    .toLowerCase()
    .replace(IPV6_BRACKETS_PATTERN, "")
    .replace(TRAILING_DOT_PATTERN, "");
}

/** Why a host name must not be fetched, or `undefined` when it is not refused. */
function blockedHostReason(host: string): string | undefined {
  const exact = BLOCKED_HOST_NAMES[host];

  if (exact !== undefined) {
    return exact;
  }

  return Object.entries(BLOCKED_HOST_SUFFIXES).find(([suffix]) =>
    host.endsWith(suffix)
  )?.[1];
}

/** Why a host name or address literal must not be fetched, or `undefined`. */
function blockedTargetReason(host: string): string | undefined {
  // Only IPv6 spells a literal with a colon, so the colon picks the family.
  if (host.includes(":")) {
    return blockedIpv6Reason(host);
  }

  const literal = blockedIpv4Reason(host);

  if (literal !== undefined) {
    return literal;
  }

  return blockedHostReason(host);
}

/** Why `address` is not a public IPv4 destination, or `undefined` when it is. */
function blockedIpv4Reason(address: string): string | undefined {
  const rank = ipv4Rank(address);

  if (rank === undefined) {
    return undefined;
  }

  for (const { first, last, reason } of IPV4_RANGES) {
    const lower = ipv4Rank(first);
    const upper = ipv4Rank(last);

    if (
      lower !== undefined &&
      upper !== undefined &&
      rank >= lower &&
      rank <= upper
    ) {
      return reason;
    }
  }

  return undefined;
}

/** Why `address` is not a public IPv6 destination, or `undefined` when it is. */
function blockedIpv6Reason(address: string): string | undefined {
  const normalized = address.toLowerCase().replace(IPV6_ZONE_PATTERN, "");

  if (normalized === "::" || normalized === "0:0:0:0:0:0:0:0") {
    return "the unspecified address";
  }
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return "the loopback address";
  }

  const embedded = embeddedIpv4(normalized);
  if (embedded !== undefined) {
    const reason = blockedIpv4Reason(embedded);
    return reason === undefined ? undefined : `${reason} (through ${embedded})`;
  }

  // The first hextet alone separates the named blocks: unique-local is the /7 at
  // fc00, link-local the /10 at fe80, multicast the /8 at ff00. A "::"-prefixed
  // address parses to nothing, and a "0:"-prefixed one to zero; both are the
  // reserved zero prefix that also holds the deprecated IPv4-compatible forms.
  const [headGroup = "", secondGroup = ""] = normalized.split(":");
  const head = Number.parseInt(headGroup, 16);
  const second = Number.parseInt(secondGroup, 16);

  if (Number.isNaN(head) || head === 0) {
    return "the reserved zero-prefix range";
  }
  if (head === 0x20_01 && second === 0x0d_b8) {
    return "a documentation-only address";
  }
  if (head >= 0xfc_00 && head <= 0xfd_ff) {
    return "a unique-local address";
  }
  if (head >= 0xfe_80 && head <= 0xfe_bf) {
    return "a link-local address";
  }
  if (head >= 0xff_00) {
    return "a multicast address";
  }

  // Everything outside 2000::/3 is special-purpose rather than global unicast,
  // so a block that is not named above still does not get the benefit of the
  // doubt: site-local, benchmarking, and unallocated space are all refused here.
  if (head < 0x20_00 || head > 0x3f_ff) {
    return "an address outside the global-unicast range";
  }

  return undefined;
}

/** The IPv4 address a mapping or translation prefix carries, when there is one. */
function embeddedIpv4(address: string): string | undefined {
  const prefix = IPV4_EMBEDDED_PREFIXES.find((candidate) =>
    address.startsWith(candidate)
  );

  if (prefix === undefined) {
    return undefined;
  }

  const tail = address.slice(prefix.length);

  if (tail.includes(".")) {
    return tail;
  }

  const groups = tail.split(":").filter((group) => group.length > 0);

  if (groups.length < 2) {
    return undefined;
  }

  const [high = "", low = ""] = groups.slice(-2);
  const highValue = Number.parseInt(high, 16);
  const lowValue = Number.parseInt(low, 16);

  if (!(Number.isInteger(highValue) && Number.isInteger(lowValue))) {
    return undefined;
  }

  return `${Math.floor(highValue / 256)}.${highValue % 256}.${Math.floor(lowValue / 256)}.${lowValue % 256}`;
}

/**
 * The rank of a dotted quad, so ranges compare in one step. Arithmetic rather
 * than bitwise shifts: `noBitwiseOperators` is on, and a reader that has to be
 * read with a hex calculator in hand is worse than one that is slightly slower.
 */
function ipv4Rank(address: string): number | undefined {
  const octets = parseIpv4(address);

  if (octets === undefined) {
    return undefined;
  }

  const [first = 0, second = 0, third = 0, fourth = 0] = octets;

  return first * 16_777_216 + second * 65_536 + third * 256 + fourth;
}

/** The four octets of a dotted quad, or `undefined` for anything else. */
function parseIpv4(address: string): readonly number[] | undefined {
  const parts = address.split(".");

  if (
    parts.length !== 4 ||
    !parts.every((part) => IPV4_OCTET_PATTERN.test(part))
  ) {
    return undefined;
  }

  const octets = parts.map((part) => Number.parseInt(part, 10));

  return octets.every((octet) => octet <= 255) ? octets : undefined;
}

/** Map a transport failure to an actionable error, keeping the original cause. */
function translateFailure(error: unknown, url: URL, timeoutMs: number): Error {
  if (
    error instanceof ReaderLimitError ||
    error instanceof UnsupportedFormatError ||
    error instanceof WebTargetRefusedError
  ) {
    return error;
  }

  const name = errorName(error);

  // `AbortSignal.timeout` rejects with a DOMException that is not an Error, so
  // the name is what identifies this reader's own budget firing.
  if (name === "TimeoutError" || name === "AbortError") {
    const budget =
      timeoutMs % 1000 === 0 ? `${timeoutMs / 1000} seconds` : `${timeoutMs}ms`;

    return new Error(`Request timed out after ${budget} for ${url.href}`);
  }

  return new Error(`Failed to fetch ${url.href}: ${describeFailure(error)}`, {
    cause: error,
  });
}

/** The `name` of a thrown value, for the DOMException-shaped aborts fetch uses. */
function errorName(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("name" in error)) {
    return undefined;
  }

  const { name } = error;

  return typeof name === "string" ? name : undefined;
}

/** A thrown value's message, for an error that is not an `Error` instance. */
function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }

  return errorName(error) ?? "unknown error";
}
