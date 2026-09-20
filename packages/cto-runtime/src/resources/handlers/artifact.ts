/**
 * `artifact://<id>` — output that was spilled rather than inlined.
 *
 * When a tool result is too large to be useful in context, the full text is
 * written to the run's artifact store and the model receives a preview plus this
 * handle. Re-reading through the handle is how it recovers the detail later,
 * optionally one line range at a time through the read tool's selector.
 *
 * Ids are per-run counters and are validated as numeric, so `artifact://0` is
 * unambiguous within the run and a malformed id fails with a message saying so
 * instead of resolving to something unintended.
 */

import type { ArtifactStore } from "../artifacts.js";
import type {
  InternalResource,
  ParsedResourceUrl,
  ProtocolHandler,
  ResolveContext,
} from "../types.js";
import { ResourceError } from "../types.js";
import { buildTextResource, notFound } from "./resource-helpers.js";

const NUMERIC_ID_RE = /^\d+$/;

export class ArtifactHandler implements ProtocolHandler {
  readonly scheme = "artifact";
  readonly immutable = true;
  readonly description =
    "Full output of a result that exceeded the inline size limit. artifact://<id>, optionally with a line range.";

  readonly #store: ArtifactStore;

  constructor(store: ArtifactStore) {
    this.#store = store;
  }

  async resolve(
    url: ParsedResourceUrl,
    _context: ResolveContext
  ): Promise<InternalResource> {
    const id = url.host;

    if (id === "") {
      throw new ResourceError(
        "artifact:// requires a numeric id, for example artifact://0",
        "The id is shown in the truncation notice for the result you want."
      );
    }

    if (!NUMERIC_ID_RE.test(id)) {
      throw new ResourceError(
        `artifact:// id must be numeric, got: ${id}`,
        "Use the id from the truncation notice, for example artifact://3."
      );
    }

    const found = await this.#store.read(Number.parseInt(id, 10));

    if (found === undefined) {
      throw notFound(
        "artifact",
        id,
        (await this.#store.list()).map(String),
        "Read a result's truncation notice for the id it was given."
      );
    }

    return buildTextResource(url.raw, found.path, found.content);
  }
}
