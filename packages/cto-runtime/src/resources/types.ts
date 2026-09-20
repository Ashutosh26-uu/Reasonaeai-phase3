/**
 * Contracts for the internal resource protocol.
 *
 * One read surface addresses every resource in a run: a sandbox file, a
 * repository document, a durable project record, a spilled tool output, or a
 * resource served by an MCP server. Each of those is a scheme, and each scheme
 * is one stateless handler behind the same interface. `read` is the only front
 * door, so a new kind of resource is a handler registration rather than a new
 * tool the model has to be told about.
 *
 * Deliberate deviation from the reference harness: there is no process-global
 * router singleton. That harness serves one user in one process, where a global
 * is harmless. This service is multi-tenant, so a global router would mean two
 * concurrent runs of different organizations dispatching through shared mutable
 * state. The registry is built per run and threaded explicitly.
 */

import type { RunScope } from "../run-scope.js";

/** Where a resource came from, for diagnostics. Never surfaced as model context. */
export interface ResourceOrigin {
  /** Absolute filesystem path backing this resource, when one exists. */
  sourcePath?: string | undefined;
}

/**
 * A resolved resource.
 *
 * `immutable` is stamped by the router from the handler's own declaration, so a
 * handler never sets it: whether a resource can be edited is a property of the
 * scheme, not of an individual read.
 */
export interface InternalResource {
  /** Resolved content, already rendered to text. */
  content: string;
  /** How the content should be interpreted downstream. */
  contentType: "text/markdown" | "application/json" | "text/plain";
  /**
   * True when the agent cannot edit this resource: sealed artifacts, canonical
   * documents served read-only, or records owned by durable project state.
   * Edit affordances such as content anchors are suppressed, because an anchor
   * promises an edit the scheme cannot honour.
   */
  immutable?: boolean | undefined;
  /**
   * True when the content is a listing rather than file content. A listing has
   * no local path to recurse, so a recursive search must refuse it instead of
   * mistaking directory names for the directory's contents.
   */
  isDirectory?: boolean | undefined;
  /** Non-fatal notes accumulated during resolution. */
  notes?: string[] | undefined;
  /** Content size in bytes, when the handler knows it. */
  size?: number | undefined;
  /** Backing path, when the resource is file-backed. */
  sourcePath?: string | undefined;
  /** Canonical URL that was resolved. Echoed back so the model can cite it. */
  url: string;
}

/**
 * Everything a handler needs to resolve a resource for one run.
 *
 * The scope is required, not optional. A handler that could fall back to
 * ambient state would be able to resolve a resource belonging to another
 * organization or project, so the caller must always prove which run it is
 * serving.
 */
export interface ResolveContext {
  /** Working directory of the sandbox or workspace the run is operating in. */
  cwd: string;
  /** Verified organization, project, build session, and run for this request. */
  scope: RunScope;
  /** Caller's abort signal, so a cancelled run stops resolving. */
  signal?: AbortSignal | undefined;
  /**
   * When set, handlers that would otherwise enumerate a large directory return
   * the directory shape with empty content. A recursive search needs to know a
   * target is a directory, not what is inside it.
   */
  skipDirectoryListing?: boolean | undefined;
}

/**
 * One stateless protocol handler, registered against a single scheme.
 *
 * Handlers hold no per-run state: anything a run-specific resolution needs
 * arrives through {@link ResolveContext}. Shared immutable state, such as a
 * parsed documentation index, may be cached on the instance because it is not
 * tenant-scoped.
 */
export interface ProtocolHandler {
  /** A one-line statement of what this scheme addresses, for diagnostics. */
  readonly description: string;
  /**
   * Whether resources from this scheme can be edited through the write path.
   * The router stamps this onto every resource it returns, so a handler cannot
   * accidentally advertise an editable resource for a read-only scheme.
   */
  readonly immutable: boolean;
  /**
   * Resolve a URL to its content.
   *
   * MUST throw a {@link ResourceError} with an actionable message when the
   * resource does not exist, rather than returning empty content. An empty
   * string is a legitimate value for an existing empty resource, and the two
   * must not be confused.
   */
  resolve: (
    url: ParsedResourceUrl,
    context: ResolveContext
  ) => Promise<InternalResource>;
  /** The scheme this handler serves, without `://`. Lowercase. */
  readonly scheme: string;
}

/** A parsed `scheme://host/path?query#fragment` resource URL. */
export interface ParsedResourceUrl {
  /** Fragment including the leading `#`, when present. */
  hash: string;
  /** Host segment, case preserved. */
  host: string;
  /** Path segment, leading slash retained. Traversal markers are not normalized. */
  pathname: string;
  /** The URL as given, before normalization. */
  raw: string;
  /** Lowercase scheme, without `://`. */
  scheme: string;
  /** Search string including the leading `?`, when present. */
  search: string;
}

/**
 * A failure that is safe and useful to show the model.
 *
 * `hint` carries the corrective action, so a failed read tells the model what
 * to try instead of only that it failed.
 */
/** Options for a resource failure. */
export interface ResourceErrorOptions {
  /** The underlying failure, preserved so the cause is not lost. */
  cause?: unknown;
  hint?: string | undefined;
}

export class ResourceError extends Error {
  readonly hint: string | undefined;

  /**
   * Accepts either a bare hint string, which is the common case, or an options
   * bag when a cause must be preserved.
   */
  constructor(message: string, options: string | ResourceErrorOptions = {}) {
    const normalized =
      typeof options === "string" ? { hint: options } : options;
    super(
      message,
      normalized.cause === undefined ? undefined : { cause: normalized.cause }
    );
    this.name = "ResourceError";
    this.hint = normalized.hint;
  }
}
