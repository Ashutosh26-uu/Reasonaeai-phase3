/**
 * `agent://<id>` — what a delegated worker produced.
 *
 * A worker's result is written to the run's agent-output store and addressed by
 * the label the orchestrator gave it, so the parent can revisit a worker's full
 * output long after the summary left its context. That is what makes delegation
 * cheap: the orchestrator does not have to keep every worker's entire output in
 * context to keep the ability to check it.
 *
 * An output that is JSON can be addressed down to one field, either as a URL
 * path (`agent://reviewer_0/.findings`) or as a query (`agent://reviewer_0?q=.findings`).
 * Both forms are accepted because a model will reach for either, and silently
 * ignoring one of them would look like an empty result rather than a mistake.
 */

import type { AgentOutputStore } from "../artifacts.js";
import {
  applyPathSegments,
  formatExtracted,
  PathLookupError,
  parsePathSegments,
} from "../json-path.js";
import type {
  InternalResource,
  ParsedResourceUrl,
  ProtocolHandler,
  ResolveContext,
} from "../types.js";
import { ResourceError } from "../types.js";
import { buildTextResource, notFound } from "./resource-helpers.js";

/** Read `q` from a raw search string, tolerating the leading `?`. */
function queryParameter(search: string): string | undefined {
  if (search === "") {
    return undefined;
  }
  const value = new URLSearchParams(search).get("q");
  return value === null || value === "" ? undefined : value;
}

export class AgentOutputHandler implements ProtocolHandler {
  readonly scheme = "agent";
  readonly immutable = true;
  readonly description =
    "Output produced by a delegated worker, addressed by its label. agent://<id>, with optional /.path or ?q= to extract one field of a JSON result.";

  readonly #store: AgentOutputStore;

  constructor(store: AgentOutputStore) {
    this.#store = store;
  }

  async resolve(
    url: ParsedResourceUrl,
    _context: ResolveContext
  ): Promise<InternalResource> {
    const id = url.host;

    if (id === "") {
      throw new ResourceError(
        "agent:// requires an output id, for example agent://scout_0",
        "Use the label shown when the worker was started."
      );
    }

    const hasPathExtraction = url.pathname !== "" && url.pathname !== "/";
    const query = queryParameter(url.search);

    if (hasPathExtraction && query !== undefined) {
      throw new ResourceError(
        "agent:// cannot combine a path with ?q=",
        "Use either agent://<id>/.field or agent://<id>?q=.field."
      );
    }

    const found = await this.#store.read(id);

    if (found === undefined) {
      throw notFound(
        "agent output",
        id,
        await this.#store.list(),
        "Worker outputs are addressed by the label they were started with."
      );
    }

    if (!(hasPathExtraction || query !== undefined)) {
      return buildTextResource(url.raw, found.path, found.content);
    }

    const extraction = hasPathExtraction ? url.pathname : (query as string);

    let parsed: unknown;
    try {
      parsed = JSON.parse(found.content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ResourceError(`Output ${id} is not valid JSON: ${message}`, {
        cause: error,
        hint: "Read the whole output with agent://<id> and no extraction path.",
      });
    }

    const segments = parsePathSegments(extraction);

    let extracted: unknown;
    try {
      extracted =
        segments.length === 0 ? parsed : applyPathSegments(parsed, segments);
    } catch (error) {
      if (error instanceof PathLookupError) {
        throw new ResourceError(
          `Cannot extract "${extraction}" from ${id}: ${error.message}`,
          {
            cause: error,
            hint: `Read agent://${id}?q=keys to list the top-level fields.`,
          }
        );
      }
      throw error;
    }

    const content =
      segments.length === 0
        ? formatExtracted(parsed)
        : formatExtracted(extracted);

    return {
      content,
      contentType: "application/json",
      notes: [`Extracted: ${extraction}`],
      size: Buffer.byteLength(content, "utf-8"),
      sourcePath: found.path,
      url: url.raw,
    };
  }
}
