/**
 * Parser for internal resource URLs.
 *
 * `new URL()` treats a colon in the authority as a port separator, which breaks
 * namespaced hosts such as `skill://plugin:name`. Every consumer of these URLs
 * must use this parser rather than calling `new URL()` directly, so that a
 * namespaced host resolves the same way everywhere.
 *
 * The parser is deliberately regex-first: the scheme, host, and path are taken
 * from the raw text before `URL` normalization, so traversal markers and
 * percent-encoded hosts survive to the handler that knows what they mean.
 */

import type { ParsedResourceUrl } from "./types.js";
import { ResourceError } from "./types.js";

const SCHEME_HOST_RE = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i;
const PATHNAME_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i;

interface SchemeAndHost {
  host: string;
  scheme: string;
}

/**
 * Split the scheme and authority off the front of a URL-like string.
 *
 * Returns `undefined` when the input has no `scheme://` prefix, which is how a
 * filesystem path is told apart from a resource URL.
 */
function splitSchemeAndHost(input: string): SchemeAndHost | undefined {
  const match: RegExpExecArray | null = SCHEME_HOST_RE.exec(input);
  if (match === null) {
    return undefined;
  }

  const [, scheme = "", host = ""] = match;
  return { host, scheme: scheme.toLowerCase() };
}

/** True when the input is shaped like a resource URL rather than a filesystem path. */
export function isResourceUrl(input: string): boolean {
  return splitSchemeAndHost(input.trim()) !== undefined;
}

/** The scheme of a resource URL, lowercased, or `undefined` when it is not one. */
export function resourceScheme(input: string): string | undefined {
  return splitSchemeAndHost(input.trim())?.scheme;
}

/**
 * Parse a resource URL.
 *
 * Throws a {@link ResourceError} when the input has no scheme, so a caller
 * cannot accidentally treat a malformed URL as a relative path and read
 * something unintended.
 */
export function parseResourceUrl(input: string): ParsedResourceUrl {
  const raw = input.trim();
  const parts = splitSchemeAndHost(raw);

  if (parts === undefined) {
    throw new ResourceError(
      `Not a resource URL: ${raw}`,
      "A resource URL starts with a scheme, for example skill://name or artifact://id."
    );
  }

  // Split off the fragment first, then the query, so a `?` inside a fragment
  // does not become a query.
  const hashIndex = raw.indexOf("#");
  const hash = hashIndex === -1 ? "" : raw.slice(hashIndex);
  const beforeHash = hashIndex === -1 ? raw : raw.slice(0, hashIndex);

  const queryIndex = beforeHash.indexOf("?");
  const search = queryIndex === -1 ? "" : beforeHash.slice(queryIndex);

  // Prefer the raw pathname from the regex: `URL` normalization resolves `..`
  // and percent-decodes, and a handler that walks a remote path needs to see
  // the path as written.
  const pathMatch: RegExpExecArray | null = PATHNAME_RE.exec(raw);
  let pathname = pathMatch === null ? "" : (pathMatch[1] ?? "");

  if (queryIndex !== -1) {
    const queryInPath = pathname.indexOf("?");
    if (queryInPath !== -1) {
      pathname = pathname.slice(0, queryInPath);
    }
  }

  const { scheme, host: rawHost } = parts;

  let host = rawHost;
  try {
    host = decodeURIComponent(rawHost);
  } catch {
    // A malformed escape sequence is not a hard failure: the handler reports an
    // unknown resource, which is more useful to the model than a decoder error.
    host = rawHost;
  }

  return { hash, host, pathname, raw, scheme, search };
}
