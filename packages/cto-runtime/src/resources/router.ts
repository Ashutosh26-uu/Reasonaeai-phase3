/**
 * The resource router: one dispatch point from a resource URL to its handler.
 *
 * Handlers are stateless and keyed by scheme, so a handler holds no per-run
 * state and one instance serves every tenant. Anything run-specific reaches a
 * handler through {@link ResolveContext}, which always carries the verified
 * scope.
 *
 * There is intentionally no process-global instance. The reference harness is a
 * single-user CLI where a global registry is harmless; this service runs
 * concurrent tenants in one process, so the router is constructed per run and
 * injected. A global would let one run's registration or cached state answer
 * another run's read.
 */

import { parseResourceUrl, resourceScheme } from "./parse.js";
import type {
  InternalResource,
  ParsedResourceUrl,
  ProtocolHandler,
  ResolveContext,
} from "./types.js";
import { ResourceError } from "./types.js";

export class ResourceRouter {
  readonly #handlers = new Map<string, ProtocolHandler>();

  constructor(handlers: readonly ProtocolHandler[] = []) {
    for (const handler of handlers) {
      this.register(handler);
    }
  }

  /** Register a handler, replacing any handler already bound to its scheme. */
  register(handler: ProtocolHandler): void {
    this.#handlers.set(handler.scheme.toLowerCase(), handler);
  }

  /** The handler bound to a scheme, if any. */
  getHandler(scheme: string): ProtocolHandler | undefined {
    return this.#handlers.get(scheme.toLowerCase());
  }

  /** Every registered scheme, sorted, for diagnostics and prompt inventory. */
  schemes(): string[] {
    return [...this.#handlers.keys()].sort();
  }

  /**
   * Whether this router can resolve the input.
   *
   * Returns `false` for a filesystem path, which is how the read tool decides
   * between the filesystem front door and the resource front door.
   */
  canHandle(input: string): boolean {
    const scheme = resourceScheme(input);
    return scheme !== undefined && this.#handlers.has(scheme);
  }

  /** The one-line description of each registered scheme, for the prompt. */
  describeSchemes(): { scheme: string; description: string }[] {
    return [...this.#handlers.values()]
      .map((handler) => ({
        description: handler.description,
        scheme: handler.scheme,
      }))
      .sort((a, b) => a.scheme.localeCompare(b.scheme));
  }

  /**
   * Resolve a resource URL to its content.
   *
   * The `immutable` flag is applied here from the handler's declaration rather
   * than trusted from the returned resource, so a handler cannot make a
   * read-only scheme look editable.
   */
  async resolve(
    input: string,
    context: ResolveContext
  ): Promise<InternalResource> {
    return await this.resolveUrl(parseResourceUrl(input), context);
  }

  /** Resolve an already-parsed URL. */
  async resolveUrl(
    url: ParsedResourceUrl,
    context: ResolveContext
  ): Promise<InternalResource> {
    const handler = this.#handlers.get(url.scheme);

    if (handler === undefined) {
      const available = this.schemes();
      const supported =
        available.length === 0
          ? "none"
          : available.map((scheme) => `${scheme}://`).join(", ");

      throw new ResourceError(
        `Unknown resource scheme: ${url.scheme}://\nSupported: ${supported}`,
        "Read the bare scheme to list the resources it serves."
      );
    }

    const resource = await handler.resolve(url, context);

    return {
      ...resource,
      immutable: resource.immutable ?? handler.immutable,
    };
  }
}
