/**
 * Instruction files: the project's own rules, loaded into the prompt.
 *
 * The agent must follow the conventions of the project it is editing, so those
 * conventions are read from disk rather than assumed. Files are discovered by
 * walking outward from the working directory, so a nested project's own rules
 * travel with it, and the nearest definition of a rule wins over an ancestor's.
 *
 * Two behaviours are load-bearing:
 *
 * 1. `@import` expansion. A rules file that references another file has that
 *    file inlined, so a project can keep rules in small focused files without
 *    the agent having to remember to open them. Expansion is depth-limited and
 *    cycle-safe.
 * 2. Content-hash deduplication. The same rules text reached through several
 *    discovery paths is included once, and the surviving copy is the most
 *    authoritative one: project scope over user scope, then the shallowest
 *    directory, then the highest-priority harness kind.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** How many levels of `@import` are followed before expansion stops. */
export const DEFAULT_MAX_IMPORT_DEPTH = 5;

/** Largest instruction file accepted, in characters. */
export const DEFAULT_MAX_FILE_CHARS = 1_000_000;

/** Where an instruction file was found, which decides its precedence. */
export type InstructionScope = "project" | "user";

/** The harness convention an instruction file belongs to. Lower number wins. */
export type InstructionSourceKind = "reasonate" | "agents" | "claude";

const SOURCE_PRIORITY: Record<InstructionSourceKind, number> = {
  agents: 1,
  claude: 2,
  reasonate: 0,
};

/** A discovered instruction file, before it is read. */
export interface InstructionFileCandidate {
  /** Directory distance from the working directory. Zero is the cwd itself. */
  depth: number;
  /** Absolute path. */
  path: string;
  /**
   * The path the convention matched, relative to the directory that provided
   * it, for example `AGENTS.md` or `.reasonate/rules.md`. This is the name
   * the file is addressed by, so it is part of the candidate rather than
   * re-derived later.
   */
  relative: string;
  /** Project files win over user files describing the same content. */
  scope: InstructionScope;
  /** Which convention named this file. */
  source: InstructionSourceKind;
}

/** A candidate whose content has been read and import-expanded. */
export interface InstructionSource extends InstructionFileCandidate {
  content: string;
  contentHash: string;
}

/** A problem encountered while loading instructions, reported rather than thrown. */
export interface ContextDiagnostic {
  message: string;
  path: string;
}

/**
 * The files each convention may provide, in the order they are tried within one
 * directory. A directory contributes at most one file per kind, so a project
 * with both `AGENTS.md` and `.reasonate/AGENTS.md` keeps the more specific one.
 */
const INSTRUCTION_FILE_NAMES: Record<InstructionSourceKind, readonly string[]> =
  {
    agents: ["AGENTS.md"],
    claude: ["CLAUDE.md"],
    reasonate: [".reasonate/AGENTS.md", ".reasonate/rules.md"],
  };

const BOM_RE = /^\uFEFF/;
const IMPORT_DIRECTIVE_RE = /^@(?:import[ \t]+)?(.+?)[ \t]*$/gm;
const QUOTED_PATH_RE = /^(['"])(.*)\1$/;

const INSTRUCTION_KINDS = Object.keys(
  INSTRUCTION_FILE_NAMES
) as InstructionSourceKind[];

/** The instruction file a directory provides for one convention, if any. */
function findInstructionFileIn(
  dir: string,
  kind: InstructionSourceKind
): { path: string; relative: string } | undefined {
  for (const relative of INSTRUCTION_FILE_NAMES[kind]) {
    const candidate = join(dir, relative);
    if (existsSync(candidate)) {
      return { path: candidate, relative };
    }
  }
  return undefined;
}

/** Every instruction file one directory provides, at most one per convention. */
function collectFromDirectory(
  dir: string,
  scope: InstructionScope,
  depth: number
): InstructionFileCandidate[] {
  const found: InstructionFileCandidate[] = [];

  for (const kind of INSTRUCTION_KINDS) {
    const match = findInstructionFileIn(dir, kind);
    if (match !== undefined) {
      found.push({
        depth,
        path: match.path,
        relative: match.relative,
        scope,
        source: kind,
      });
    }
  }

  return found;
}

/**
 * Discover instruction files from the working directory outward.
 *
 * The walk stops at the filesystem root, so a deeply nested working directory
 * still sees every enclosing project's rules. User-level files are consulted
 * only when the walk did not already reach the home directory, so the same file
 * is not offered twice under two scopes.
 */
export function discoverInstructionFileCandidates(
  cwd: string,
  options: { home?: string } = {}
): InstructionFileCandidate[] {
  const home = options.home ?? homedir();
  const candidates: InstructionFileCandidate[] = [];

  let current = resolve(cwd);
  let depth = 0;

  for (;;) {
    candidates.push(...collectFromDirectory(current, "project", depth));

    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
    depth += 1;
  }

  const reachedHome = candidates.some((candidate) =>
    candidate.path.startsWith(home)
  );
  if (!reachedHome) {
    candidates.push(
      ...collectFromDirectory(home, "user", Number.MAX_SAFE_INTEGER)
    );
  }

  return candidates;
}

/**
 * Read and import-expand one instruction file.
 *
 * Returns `undefined` when the file cannot be read or exceeds the size cap; the
 * reason is recorded as a diagnostic rather than thrown, because one unreadable
 * rules file must not stop a run.
 */
export function loadInstructionSource(
  candidate: InstructionFileCandidate,
  options: {
    maxImportDepth?: number;
    maxFileChars?: number;
    diagnostics?: ContextDiagnostic[];
  } = {}
): InstructionSource | undefined {
  const diagnostics = options.diagnostics ?? [];
  const maxFileChars = options.maxFileChars ?? DEFAULT_MAX_FILE_CHARS;

  const content = readAndExpand(
    candidate.path,
    options.maxImportDepth ?? DEFAULT_MAX_IMPORT_DEPTH,
    maxFileChars,
    diagnostics,
    new Set([resolve(candidate.path)]),
    0
  );

  if (content === undefined) {
    return undefined;
  }

  return { ...candidate, content, contentHash: hashContent(content) };
}

/**
 * Read a file and inline its `@import` directives.
 *
 * A directive is a line of the form `@path` or `@import path`, optionally
 * quoted. An absolute path, a missing file, an over-deep import, or a cycle
 * leaves the directive text in place and records a diagnostic, so the agent sees
 * that something was not expanded instead of silently losing a rule.
 */
function readAndExpand(
  path: string,
  maxImportDepth: number,
  maxFileChars: number,
  diagnostics: ContextDiagnostic[],
  visited: ReadonlySet<string>,
  depth: number
): string | undefined {
  let content: string;
  try {
    content = readFileSync(path, "utf-8").replace(BOM_RE, "");
  } catch (error) {
    diagnostics.push({
      message: `Unable to read instruction file: ${
        error instanceof Error ? error.message : String(error)
      }`,
      path,
    });
    return undefined;
  }

  if (content.length > maxFileChars) {
    diagnostics.push({
      message: `Instruction file exceeds ${maxFileChars} characters`,
      path,
    });
    return undefined;
  }

  return content.replace(
    IMPORT_DIRECTIVE_RE,
    (directive: string, rawPath: string) => {
      const importPath = rawPath.trim().replace(QUOTED_PATH_RE, "$2");

      if (importPath === "" || isAbsolute(importPath)) {
        diagnostics.push({
          message: `Instruction import must be a non-empty relative path: ${directive}`,
          path,
        });
        return directive;
      }

      if (depth >= maxImportDepth) {
        diagnostics.push({
          message: `Instruction import depth exceeded ${maxImportDepth}: ${directive}`,
          path,
        });
        return directive;
      }

      const importedPath = resolve(dirname(path), importPath);

      if (visited.has(importedPath)) {
        diagnostics.push({
          message: `Instruction import cycle detected: ${importedPath}`,
          path,
        });
        return directive;
      }

      const nestedVisited = new Set(visited);
      nestedVisited.add(importedPath);

      return (
        readAndExpand(
          importedPath,
          maxImportDepth,
          maxFileChars,
          diagnostics,
          nestedVisited,
          depth + 1
        ) ?? directive
      );
    }
  );
}

/**
 * Drop duplicates that share content, keeping the most authoritative copy.
 *
 * Identity is the content hash, not the path: a rules file copied into two
 * harness conventions is one set of rules, and sending it twice spends context
 * to tell the agent nothing new.
 */
export function selectInstructionSources(
  sources: readonly InstructionSource[]
): InstructionSource[] {
  const preferred = new Map<string, InstructionSource>();

  for (const source of sources) {
    const current = preferred.get(source.contentHash);
    if (current === undefined || compareSourcePreference(source, current) < 0) {
      preferred.set(source.contentHash, source);
    }
  }

  const retained = new Set(preferred.values());
  return sources.filter((source) => retained.has(source));
}

/** Negative when `left` is more authoritative than `right`. */
function compareSourcePreference(
  left: InstructionSource,
  right: InstructionSource
): number {
  if (left.scope !== right.scope) {
    return left.scope === "project" ? -1 : 1;
  }
  if (left.depth !== right.depth) {
    return left.depth - right.depth;
  }
  return SOURCE_PRIORITY[left.source] - SOURCE_PRIORITY[right.source];
}

/** Render one instruction file as a delimited prompt block. */
export function renderInstructionSource(source: InstructionSource): string {
  return `<context-file path="${escapeAttribute(source.path)}" scope="${source.scope}" depth="${
    source.depth === Number.MAX_SAFE_INTEGER ? "user" : source.depth
  }" source="${source.source}">\n${source.content}\n</context-file>`;
}

/** Escape a value for use inside an XML-style attribute. */
export function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape a value for use inside element text. */
export function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Stable content hash used for deduplication and the prompt fingerprint. */
export function hashContent(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
