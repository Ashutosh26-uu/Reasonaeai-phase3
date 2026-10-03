/**
 * `rule://` — the project's instruction files, addressable by name.
 *
 * The same files the prompt loads are also readable individually. That matters
 * because the prompt includes them once at the start of a run, and an agent that
 * needs to re-check a specific rule hours later should not have to rely on
 * recalling it from context, or on the harness having kept it in the window.
 *
 * Content is import-expanded exactly as the prompt renders it, so what the agent
 * reads here and what it was given at the start are the same text.
 */

import {
  type ContextDiagnostic,
  discoverInstructionFileCandidates,
  type InstructionFileCandidate,
  type InstructionSource,
  loadInstructionSource,
} from "../../context/instructions.js";
import { BUNDLED_RULES } from "../../guidance/catalog.js";
import type {
  InternalResource,
  ParsedResourceUrl,
  ProtocolHandler,
  ResolveContext,
} from "../types.js";
import { ResourceError } from "../types.js";
import { buildTextResource, notFound } from "./resource-helpers.js";

const LEADING_SLASHES_RE = /^\/+/;

export interface RuleHandlerOptions {
  /** Overrides the home directory used for user-level rules. */
  home?: string | undefined;
  /** Verified workspace snapshot. Empty means no project rules; never inspect host files. */
  sources?: readonly InstructionSource[] | undefined;
}

export class RuleHandler implements ProtocolHandler {
  readonly scheme = "rule";
  readonly immutable = true;
  readonly description =
    "Bundled policy and loaded project instructions, already included in the prompt. Revisit a named rule only when needed; enumeration is optional.";

  readonly #cwd: string;
  readonly #home: string | undefined;
  readonly #sources: readonly InstructionSource[] | undefined;

  constructor(cwd: string, options: RuleHandlerOptions = {}) {
    this.#cwd = cwd;
    this.#home = options.home;
    this.#sources = options.sources;
  }

  resolve(
    url: ParsedResourceUrl,
    _context: ResolveContext
  ): Promise<InternalResource> {
    const name = `${url.host}${url.pathname}`.replace(LEADING_SLASHES_RE, "");
    const bundled = BUNDLED_RULES.find((rule) => rule.name === name);
    if (bundled) {
      return Promise.resolve({
        content: bundled.content,
        contentType: "text/markdown",
        immutable: true,
        size: Buffer.byteLength(bundled.content, "utf8"),
        url: url.raw,
      });
    }
    const candidates = this.#sources ?? this.#candidates();

    if (name === "") {
      return Promise.resolve(this.#list(url, candidates));
    }

    // Discovery returns nearest-first, so the first match is the most local
    // definition of that rule, which is the one that governs here.
    const match = candidates.find((candidate) => candidate.relative === name);

    if (match === undefined) {
      throw notFound(
        "rule",
        name,
        [
          ...BUNDLED_RULES.map((rule) => rule.name),
          ...candidates.map((candidate) => candidate.relative),
        ],
        "Use a named rule from the supplied catalog. The policy is already in your instructions."
      );
    }

    const diagnostics: ContextDiagnostic[] = [];
    const loaded =
      "content" in match
        ? match
        : loadInstructionSource(match, { diagnostics });

    if (loaded === undefined) {
      throw new ResourceError(
        `Unable to read rule: ${name}`,
        diagnostics.map((entry) => entry.message).join("; ") ||
          "The file could not be read."
      );
    }

    return Promise.resolve(
      buildTextResource(
        url.raw,
        match.path,
        loaded.content,
        diagnostics.map((entry) => entry.message)
      )
    );
  }

  #list(
    url: ParsedResourceUrl,
    candidates: readonly InstructionFileCandidate[]
  ): InternalResource {
    const content = [
      "# Applied rules",
      "Bundled policy is already applied. This listing is optional; continue with your task instead of rereading every rule.",
      "",
      ...BUNDLED_RULES.map(
        (rule) => `- rule://${rule.name} — ${rule.description}`
      ),
      ...(candidates.length === 0
        ? ["No project-specific instruction files are configured."]
        : candidates.map(
            (candidate) =>
              `- rule://${candidate.relative} — ${candidate.scope}, ${candidate.source}`
          )),
      "",
    ].join("\n");

    return {
      content,
      contentType: "text/markdown",
      immutable: true,
      size: Buffer.byteLength(content, "utf-8"),
      url: url.raw,
    };
  }

  #candidates(): InstructionFileCandidate[] {
    return discoverInstructionFileCandidates(this.#cwd, {
      ...(this.#home === undefined ? {} : { home: this.#home }),
    });
  }
}
