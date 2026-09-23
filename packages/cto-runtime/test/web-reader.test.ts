/**
 * The web reader's observable contract: an HTML page becomes markdown with its
 * source and title named, the other text formats render, the byte and time
 * budgets bite, redirects are followed and validated, and no target outside the
 * public internet is ever connected to.
 *
 * Every fixture is a local `node:http` server. Nothing here touches the network,
 * which is also why the address rules are exercised with literal addresses: a
 * real public host would make the suite depend on DNS.
 */

import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRunResources } from "../src/resources/handlers/index.js";
import type { ResolveContext } from "../src/resources/types.js";
import type { RunScope } from "../src/run-scope.js";
import { readTarget } from "../src/tools/read.js";
import {
  DEFAULT_READER_LIMITS,
  ReaderLimitError,
  type ReaderRequest,
  UnsupportedFormatError,
} from "../src/tools/readers/types.js";
import {
  createWebReader,
  WebTargetRefusedError,
  webReader,
} from "../src/tools/readers/web.js";

const LOOPBACK = "127.0.0.1";

// Patterns stay at module level, as `useTopLevelRegex` requires.
const BULLET_ITEM_PATTERN = /-\s+first/;
const LIMIT_ERROR_PATTERN =
  /maxResourceBytes exceeded: \d+ bytes is over the 1024-byte limit/;
const TIMEOUT_ERROR_PATTERN = /timed out after 250ms/;
const TITLE_OCCURRENCES_PATTERN = /Fixture & Docs/g;
const EMBEDDED_IPV4_PATTERN = /is a private address \(through 10\.0\.0\.1\)/;

/**
 * `node:dns/promises` is mocked so the resolved-address rule can be exercised
 * without asking a real resolver, and so an accidental lookup fails loudly.
 */
const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));

vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

/**
 * The default reader refuses loopback, which is what a fixture server needs, so
 * the fixtures permit it by name — the same allowlist a caller would use for a
 * known internal host.
 */
const localReader = createWebReader({ allowedHosts: ["localhost", LOOPBACK] });

/** A reader with a budget short enough to exercise in a test. */
const impatientReader = createWebReader({
  allowedHosts: [LOOPBACK],
  timeoutMs: 250,
});

const servers: Array<() => Promise<void>> = [];

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

/** A request for one target, as the tool builds it. */
function webRequest(
  path: string,
  limits = DEFAULT_READER_LIMITS
): ReaderRequest {
  return { limits, path, selector: undefined };
}

/** The error a read is expected to raise, narrowed for the assertions. */
async function captured(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error(`the read failed with a non-Error: ${String(error)}`, {
      cause: error,
    });
  }

  throw new Error("the read was expected to fail, and did not");
}

/** Loopback state of a listening server, without a cast. */
function addressOf(server: Server): AddressInfo {
  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("the fixture server did not listen on a TCP port");
  }

  return address;
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  const closed = once(server, "close");
  server.close();

  return closed.then(() => undefined);
}

/** Start a fixture server and return its base URL. */
async function serve(handler: Handler): Promise<string> {
  const server = createServer(handler);
  const listening = once(server, "listening");
  server.listen(0, LOOPBACK);
  await listening;
  servers.push(() => closeServer(server));

  return `http://${LOOPBACK}:${addressOf(server).port}`;
}

/** Record transport calls, so "refused" can be shown to mean "never connected". */
function spyOnFetch(): string[] {
  const calls: string[] = [];
  const original = globalThis.fetch;

  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    return original(input, init);
  });

  return calls;
}

beforeEach(() => {
  lookupMock.mockReset();
  lookupMock.mockRejectedValue(new Error("no resolver in tests"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((close) => close()));
});

describe("dispatching", () => {
  it("claims http and https targets and nothing else", () => {
    expect(
      webReader.matches({
        path: "https://example.com/docs",
        selector: undefined,
      })
    ).toBe(true);
    expect(
      webReader.matches({ path: "http://example.com/", selector: undefined })
    ).toBe(true);
    expect(
      webReader.matches({ path: "file:///etc/passwd", selector: undefined })
    ).toBe(false);
    expect(webReader.matches({ path: "src/app.ts", selector: undefined })).toBe(
      false
    );
    expect(webReader.matches({ path: "127.0.0.1", selector: undefined })).toBe(
      false
    );
  });

  it("reports its output as immutable, since a fetched page cannot be edited", async () => {
    const base = await serve((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("hello");
    });

    const result = await localReader.read(webRequest(`${base}/text`));

    expect(result.immutable).toBe(true);
  });
});

describe("rendering a response", () => {
  it("converts HTML to markdown and names the source and title", async () => {
    const base = await serve((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(
        [
          "<!doctype html><html><head><title>Fixture &amp; Docs</title></head><body>",
          "<nav>Site navigation</nav>",
          "<main><h1>Release notes</h1>",
          "<p>Hello <strong>world</strong>.</p>",
          "<ul><li>first</li><li>second</li></ul>",
          "<script>window.tracker = 1</script></main>",
          "<footer>Copyright</footer></body></html>",
        ].join("")
      );
    });

    const result = await localReader.read(webRequest(`${base}/docs`));

    expect(result.contentType).toBe("text/markdown");
    expect(result.text).toContain("# Release notes");
    expect(result.text).toContain("**world**");
    expect(result.text).toMatch(BULLET_ITEM_PATTERN);
    expect(result.text).toContain(`Source: ${base}/docs`);
    expect(result.text).toContain("Title: Fixture & Docs");
    // The title belongs to the envelope, not repeated in the body.
    expect(result.text.match(TITLE_OCCURRENCES_PATTERN)).toHaveLength(1);
    // Page chrome is not content: spectra's reader dropped it, and so does this.
    expect(result.text).not.toContain("Site navigation");
    expect(result.text).not.toContain("Copyright");
    expect(result.text).not.toContain("window.tracker");
  });

  it("pretty-prints a JSON response", async () => {
    const base = await serve((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ count: 2, items: ["a", "b"] }));
    });

    const result = await localReader.read(webRequest(`${base}/api`));

    expect(result.contentType).toBe("application/json");
    expect(result.text).toContain('"count": 2');
    expect(result.text).toContain(`Source: ${base}/api`);
  });

  it("parses an XML response instead of returning its markup", async () => {
    const base = await serve((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/rss+xml" });
      response.end(
        '<rss version="2.0"><channel><title>Feed</title><item><title>One</title></item></channel></rss>'
      );
    });

    const result = await localReader.read(webRequest(`${base}/feed`));

    expect(result.text).toContain('"rss"');
    expect(result.text).toContain("One");
  });

  it("passes plain text through unchanged", async () => {
    const base = await serve((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("plain body\n");
    });

    const result = await localReader.read(webRequest(`${base}/notes.txt`));

    expect(result.contentType).toBe("text/plain");
    expect(result.text).toContain("plain body");
  });

  it("refuses a media type it cannot render as text", async () => {
    const base = await serve((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/pdf" });
      response.end(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]));
    });

    const error = await captured(localReader.read(webRequest(`${base}/file`)));

    expect(error).toBeInstanceOf(UnsupportedFormatError);
    expect(error.message).toContain("application/pdf is not a text format");
  });

  it("fails on an error status rather than returning the error page", async () => {
    const base = await serve((_request, response) => {
      response.writeHead(404, { "Content-Type": "text/html" });
      response.end("<h1>Not here</h1>");
    });

    const error = await captured(localReader.read(webRequest(`${base}/gone`)));

    expect(error.message).toContain("HTTP 404");
    expect(error.message).not.toContain("Not here");
  });

  it("reads a named host that the caller explicitly allowed", async () => {
    const base = await serve((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("named host");
    });
    const { port } = new URL(base);

    const result = await localReader.read(
      webRequest(`http://localhost:${port}/named`)
    );

    expect(result.text).toContain("named host");
    expect(result.text).toContain(`Source: http://localhost:${port}/named`);
  });
});

describe("bounding a response", () => {
  it("stops at the byte allowance while the body is still streaming", async () => {
    const base = await serve((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.write("x".repeat(4096));
      // Deliberately never ends: a reader that buffered the body would have to
      // wait for its own timeout instead of refusing at the limit.
    });

    const error = await captured(
      localReader.read(
        webRequest(`${base}/big`, {
          ...DEFAULT_READER_LIMITS,
          maxResourceBytes: 1024,
        })
      )
    );

    expect(error).toBeInstanceOf(ReaderLimitError);
    expect(error.message).toMatch(LIMIT_ERROR_PATTERN);
  });

  it("gives up on a stalled response and says it was the time budget", async () => {
    const base = await serve((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.write("partial");
      // Never ends: only the reader's own budget can end this read.
    });

    const error = await captured(
      impatientReader.read(webRequest(`${base}/stall`))
    );

    expect(error.message).toMatch(TIMEOUT_ERROR_PATTERN);
  });
});

describe("redirects", () => {
  it("follows a redirect and reports where the content came from", async () => {
    const base = await serve((request, response) => {
      if (request.url === "/start") {
        response.writeHead(302, { Location: "/page" });
        response.end();
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(
        "<html><head><title>Landed</title></head><body><p>final text</p></body></html>"
      );
    });

    const result = await localReader.read(webRequest(`${base}/start`));

    expect(result.text).toContain("final text");
    expect(result.text).toContain(`Source: ${base}/page`);
    expect(result.notes?.join(" ")).toContain(
      `followed 1 redirect(s) from ${base}/start`
    );
  });

  it("refuses a redirect that lands on a private address", async () => {
    const base = await serve((_request, response) => {
      response.writeHead(302, {
        Location: "http://169.254.169.254/latest/meta-data/",
      });
      response.end();
    });
    const calls = spyOnFetch();

    await expect(localReader.read(webRequest(`${base}/hop`))).rejects.toThrow(
      WebTargetRefusedError
    );

    // The first hop is a permitted fixture host; the metadata address never is.
    expect(calls).toEqual([`${base}/hop`]);
  });

  it("refuses a redirect to a scheme it will not read", async () => {
    const base = await serve((_request, response) => {
      response.writeHead(302, { Location: "file:///etc/passwd" });
      response.end();
    });
    const calls = spyOnFetch();

    await expect(
      localReader.read(webRequest(`${base}/escape`))
    ).rejects.toThrow(UnsupportedFormatError);
    expect(calls).toEqual([`${base}/escape`]);
  });
});

describe("refusing targets outside the public internet", () => {
  const refusedTargets = [
    "http://127.0.0.1:1/",
    "http://localhost:1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/",
    "http://192.168.1.1/",
  ];

  it("refuses loopback, link-local and private targets without connecting", async () => {
    const calls = spyOnFetch();

    await Promise.all(
      refusedTargets.map((target) =>
        expect(webReader.read(webRequest(target))).rejects.toThrow(
          WebTargetRefusedError
        )
      )
    );

    expect(calls).toEqual([]);
    // A literal needs no resolver to be recognised as private.
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("refuses a non-http scheme", async () => {
    const calls = spyOnFetch();

    await expect(
      webReader.read(webRequest("file:///etc/passwd"))
    ).rejects.toThrow(UnsupportedFormatError);
    expect(calls).toEqual([]);
  });

  it("refuses every private and reserved range, IPv4 and IPv6", async () => {
    const calls = spyOnFetch();

    await Promise.all(
      [
        "http://172.16.5.4/",
        "http://100.64.1.1/",
        "http://0.0.0.0/",
        "http://metadata.google.internal/",
        "http://[::1]/",
        "http://[::7f00:1]/",
        "http://[::ffff:127.0.0.1]/",
        "http://[fd12:3456::1]/",
        "http://[fe80::1]/",
        "http://[fec0::1]/",
        "http://[f::1]/",
        "http://[ff02::1]/",
        "http://[2001:db8::1]/",
      ].map((target) =>
        expect(webReader.read(webRequest(target))).rejects.toThrow(
          WebTargetRefusedError
        )
      )
    );

    expect(calls).toEqual([]);
  });

  it("decodes an IPv4 address embedded in a mapping or NAT64 prefix", async () => {
    const calls = spyOnFetch();

    await Promise.all(
      ["http://[::ffff:a00:1]/", "http://[64:ff9b::a00:1]/"].map((target) =>
        expect(webReader.read(webRequest(target))).rejects.toThrow(
          EMBEDDED_IPV4_PATTERN
        )
      )
    );

    expect(calls).toEqual([]);
  });

  it("refuses a name that resolves into a private network", async () => {
    lookupMock.mockResolvedValue([{ address: "10.1.2.3", family: 4 }]);
    const calls = spyOnFetch();

    await expect(
      webReader.read(webRequest("http://docs.example.com/guide"))
    ).rejects.toThrow(WebTargetRefusedError);

    expect(lookupMock).toHaveBeenCalledWith("docs.example.com", { all: true });
    expect(calls).toEqual([]);
  });

  it("refuses a target whose resolved address is only partly public", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "::ffff:10.0.0.5", family: 6 },
    ]);
    const calls = spyOnFetch();

    await expect(
      webReader.read(webRequest("http://mixed.example.com/"))
    ).rejects.toThrow(WebTargetRefusedError);

    expect(calls).toEqual([]);
  });

  it("refuses a URL that tries to smuggle credentials", async () => {
    const calls = spyOnFetch();

    await expect(
      webReader.read(webRequest("http://user:secret@example.com/"))
    ).rejects.toThrow(WebTargetRefusedError);

    expect(calls).toEqual([]);
  });
});

describe("dispatch through the read tool", () => {
  const scope = {
    buildSessionId: "bs_1",
    organizationId: "org_1",
    projectId: "proj_1",
    runId: "run_1",
  } as RunScope;

  it("answers a URL target with the reader's markdown", async () => {
    const base = await serve((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(
        "<html><head><title>Through the tool</title></head><body><p>reached</p></body></html>"
      );
    });
    const root = await mkdtemp(join(tmpdir(), "reasonate-web-"));
    const { router } = createRunResources({ cwd: process.cwd(), root, scope });
    const context: ResolveContext = { cwd: process.cwd(), scope };

    const result = await readTarget(`${base}/page`, context, router, {
      readers: [localReader],
    });

    expect(result.kind).toBe("resource");
    expect(result.target).toBe(`${base}/page`);
    expect(result.text).toContain("reached");
    expect(result.text).toContain(`Source: ${base}/page`);
    expect(result.text).toContain("Title: Through the tool");
  });
});
