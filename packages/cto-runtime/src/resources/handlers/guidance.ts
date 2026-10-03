import type { GuidanceEntry } from "../../guidance/catalog.js";
import type {
  InternalResource,
  ParsedResourceUrl,
  ProtocolHandler,
  ResolveContext,
} from "../types.js";
import { notFound } from "./resource-helpers.js";

const LEADING_SLASHES_RE = /^\/+/;

/** Immutable, explicitly named guidance; no model-controlled filesystem access. */
export class GuidanceHandler implements ProtocolHandler {
  readonly immutable = true;
  readonly scheme: string;
  readonly description: string;
  readonly #entries: readonly GuidanceEntry[];

  constructor(scheme: "rule" | "skill", entries: readonly GuidanceEntry[]) {
    this.scheme = scheme;
    this.#entries = entries;
    this.description =
      scheme === "rule"
        ? "Bundled policy already applied to this run. Read a named rule only to revisit it; enumeration is optional."
        : "Bundled task procedures. Choose a named skill from the prompt catalog when relevant.";
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
        `# Available ${this.scheme === "rule" ? "rules" : "skills"}`,
        ...(this.#entries.length === 0
          ? [
              "No entries are configured. Continue with the supplied instructions; do not retry discovery.",
            ]
          : this.#entries.map(
              (candidate) =>
                `- ${this.scheme}://${candidate.name} — ${candidate.description}`
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
