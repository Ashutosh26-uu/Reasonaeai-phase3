import type { GuidanceEntry } from "../../guidance/types.js";
import type {
  InternalResource,
  ParsedResourceUrl,
  ProtocolHandler,
  ResolveContext,
} from "../types.js";
import { notFound } from "./resource-helpers.js";

const LEADING_SLASHES_RE = /^\/+/;

/**
 * `skill://` — the bundled task procedures, addressed by name.
 *
 * A skill's body is deliberately absent from the system prompt: the prompt
 * advertises the catalog, and the body is fetched here when the task matches.
 * Naming a skill that does not exist fails with the available names rather than
 * returning an empty document, because a silently empty skill would look like a
 * skill that advised nothing.
 */
export class SkillHandler implements ProtocolHandler {
  readonly scheme = "skill";
  readonly immutable = true;
  readonly description =
    "Bundled task procedures. Read a named skill from the prompt catalog when the task matches; an empty name lists them.";

  readonly #entries: readonly GuidanceEntry[];

  constructor(entries: readonly GuidanceEntry[]) {
    this.#entries = entries;
  }

  resolve(
    url: ParsedResourceUrl,
    _context: ResolveContext
  ): Promise<InternalResource> {
    const name = `${url.host}${url.pathname}`.replace(LEADING_SLASHES_RE, "");
    const entry = this.#entries.find((candidate) => candidate.name === name);
    if (name !== "" && !entry) {
      throw notFound(
        this.scheme,
        name,
        this.#entries.map((candidate) => candidate.name)
      );
    }
    const content =
      entry?.content ??
      [
        "# Available skills",
        ...(this.#entries.length === 0
          ? [
              "No entries are configured. Continue with the supplied instructions; do not retry discovery.",
            ]
          : this.#entries.map(
              (candidate) =>
                `- skill://${candidate.name} — ${candidate.description}`
            )),
      ].join("\n");
    return Promise.resolve({
      content,
      contentType: "text/markdown",
      immutable: true,
      size: Buffer.byteLength(content, "utf8"),
      url: url.raw,
    });
  }
}
