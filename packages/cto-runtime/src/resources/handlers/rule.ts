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

import { readFile } from "node:fs/promises";

import {
  type ContextDiagnostic,
  discoverInstructionFileCandidates,
  type InstructionFileCandidate,
  loadInstructionSource,
} from "../../context/instructions.js";
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
}

export class RuleHandler implements ProtocolHandler {
  readonly scheme = "rule";
  readonly immutable = true;
  readonly description =
    "Instruction files that apply to this workspace, addressed by name. Read rule:// on its own to list them.";

  readonly #cwd: string;
  readonly #home: string | undefined;

  constructor(cwd: string, options: RuleHandlerOptions = {}) {
    this.#cwd = cwd;
    this.#home = options.home;
  }

  async resolve(
    url: ParsedResourceUrl,
    _context: ResolveContext
  ): Promise<InternalResource> {
    const name = `${url.host}${url.pathname}`.replace(LEADING_SLASHES_RE, "");
    const candidates = this.#candidates();

    if (candidates.length === 0) {
      throw new ResourceError(
        "No instruction files apply to this workspace.",
        "This workspace does not define project rules."
      );
    }

    if (name === "") {
      return await this.#list(url, candidates);
    }

    // Discovery returns nearest-first, so the first match is the most local
    // definition of that rule, which is the one that governs here.
    const match = candidates.find((candidate) => candidate.relative === name);

    if (match === undefined) {
      throw notFound(
        "rule",
        name,
        candidates.map((candidate) => candidate.relative),
        "Read rule:// to list every applicable rule file."
      );
    }

    const diagnostics: ContextDiagnostic[] = [];
    const loaded = loadInstructionSource(match, { diagnostics });

    if (loaded === undefined) {
      throw new ResourceError(
        `Unable to read rule: ${name}`,
        diagnostics.map((entry) => entry.message).join("; ") ||
          "The file could not be read."
      );
    }

    return buildTextResource(
      url.raw,
      match.path,
      loaded.content,
      diagnostics.map((entry) => entry.message)
    );
  }

  async #list(
    url: ParsedResourceUrl,
    candidates: readonly InstructionFileCandidate[]
  ): Promise<InternalResource> {
    // Resolve every file so a rule that cannot be read is reported here rather
    // than discovered later as a failed read.
    const entries = await Promise.all(
      candidates.map(async (candidate) => ({
        candidate,
        readable: await canRead(candidate.path),
      }))
    );

    const content = [
      "# Project rules",
      "",
      ...entries.map(
        ({ candidate, readable }) =>
          `- ${readable ? `[${candidate.relative}](rule://${candidate.relative})` : `${candidate.relative} (unreadable)`} — ${candidate.scope}, ${candidate.source}`
      ),
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

async function canRead(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf-8");
    return true;
  } catch {
    return false;
  }
}
