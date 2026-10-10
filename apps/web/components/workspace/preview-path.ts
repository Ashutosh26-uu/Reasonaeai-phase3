const MAX_PATH_LENGTH = 2048;
const MAX_HISTORY_ENTRIES = 100;
const SCHEME = /^[a-z][a-z\d+.-]*:/i;
const ENCODED_SEPARATOR = /%(?:2f|5c)/i;
const PATH_BOUNDARY = /[?#]/;
const TRAILING_SLASHES = /\/+$/;
const LEADING_SLASHES = /^\/+/;

function hasUnsafeCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 32 || code === 127 || code === 92) {
      return true;
    }
  }
  return false;
}

/** Routes are project paths, never browser URLs or filesystem transport. */
export function parsePreviewPath(input: string): string | null {
  const route = input.trim();
  if (
    route.length === 0 ||
    route.length > MAX_PATH_LENGTH ||
    SCHEME.test(route) ||
    route.startsWith("//") ||
    hasUnsafeCharacters(route)
  ) {
    return null;
  }
  const path = route.split(PATH_BOUNDARY, 1)[0] ?? "";
  let decoded = path;
  // Reject nested encoding too: downstream URL/proxy layers may decode again.
  for (let depth = 0; depth < 5; depth += 1) {
    if (
      hasUnsafeCharacters(decoded) ||
      ENCODED_SEPARATOR.test(decoded) ||
      decoded.split("/").some((segment) => segment === "." || segment === "..")
    ) {
      return null;
    }
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        return route.startsWith("/") ? route : `/${route}`;
      }
      decoded = next;
    } catch {
      return null;
    }
  }
  return null;
}

/** Show the selected app's sandbox address while requests use the preview gateway. */
export function formatSandboxPreviewAddress(
  port: number,
  route: string
): string {
  const path = parsePreviewPath(route) ?? "/";
  return `http://localhost:${port}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Accept only a project path or the selected app's own loopback URL. */
export function parseSandboxPreviewAddress(
  input: string,
  appPort: number
): string | null {
  const trimmed = input.trim();
  if (!SCHEME.test(trimmed)) {
    return parsePreviewPath(trimmed);
  }
  try {
    const address = new URL(trimmed);
    if (
      address.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]", "::1"].includes(
        address.hostname.toLowerCase()
      ) ||
      Number(address.port) !== appPort ||
      address.username ||
      address.password
    ) {
      return null;
    }
    return parsePreviewPath(
      `${address.pathname}${address.search}${address.hash}`
    );
  } catch {
    return null;
  }
}

/** The server-issued root stays private to transport and cannot be edited. */
export function previewRoot(
  url: string,
  previewId: string,
  appOrigin: string
): string | null {
  try {
    const root = new URL(url, appOrigin);
    if (
      !["http:", "https:"].includes(root.protocol) ||
      root.username ||
      root.password ||
      root.pathname !== `/v1/previews/${encodeURIComponent(previewId)}/` ||
      root.search ||
      root.hash ||
      url.startsWith("//") ||
      hasUnsafeCharacters(url)
    ) {
      return null;
    }
    return root.href;
  } catch {
    return null;
  }
}

export function previewTransportUrl(
  root: string,
  route: string
): string | null {
  const path = parsePreviewPath(route);
  if (path === null) {
    return null;
  }
  try {
    const base = new URL(root);
    const target = new URL(`${base.pathname}${path.slice(1)}`, base.origin);
    if (
      target.origin !== base.origin ||
      !target.pathname.startsWith(base.pathname)
    ) {
      return null;
    }
    return target.href;
  } catch {
    return null;
  }
}

/** Only an observed browser location inside this exact preview is accepted. */
export function observedPreviewPath(root: string, href: string): string | null {
  try {
    const base = new URL(root);
    const location = new URL(href);
    const rootAlias =
      location.pathname === base.pathname.replace(TRAILING_SLASHES, "");
    if (
      location.origin !== base.origin ||
      location.username ||
      location.password ||
      !(rootAlias || location.pathname.startsWith(base.pathname))
    ) {
      return null;
    }
    return parsePreviewPath(
      `/${rootAlias ? "" : location.pathname.slice(base.pathname.length)}${location.search}${location.hash}`
    );
  } catch {
    return null;
  }
}

export interface PreviewHistory {
  index: number;
  paths: string[];
}

export function recordPreviewPath(
  history: PreviewHistory,
  path: string
): PreviewHistory {
  const parsed = parsePreviewPath(path);
  if (parsed === null || parsed === history.paths[history.index]) {
    return history;
  }
  const paths = [...history.paths.slice(0, history.index + 1), parsed].slice(
    -MAX_HISTORY_ENTRIES
  );
  return { index: paths.length - 1, paths };
}

export function movePreviewHistory(
  history: PreviewHistory,
  delta: -1 | 1
): PreviewHistory {
  const index = history.index + delta;
  return index < 0 || index >= history.paths.length
    ? history
    : { ...history, index };
}

export function workspaceFilePath(path: string): string {
  return path.startsWith("/workspace/")
    ? path
    : `/workspace/${path.replace(LEADING_SLASHES, "")}`;
}
