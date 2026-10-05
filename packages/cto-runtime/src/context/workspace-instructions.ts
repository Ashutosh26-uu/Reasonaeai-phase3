import { posix } from "node:path";
import type { WorkspaceFilesystem } from "@mastra/core/workspace";
import {
  hashContent,
  type InstructionSource,
  type InstructionSourceKind,
  selectInstructionSources,
} from "./instructions.js";

const CANDIDATES: readonly {
  relative: string;
  source: InstructionSourceKind;
}[] = [
  { relative: ".reasonate/AGENTS.md", source: "reasonate" },
  { relative: ".reasonate/rules.md", source: "reasonate" },
  { relative: "AGENTS.md", source: "agents" },
  { relative: "CLAUDE.md", source: "claude" },
];
const IMPORT_RE = /^@(?:import[ \t]+)?(.+?)[ \t]*$/gm;
const QUOTED_RE = /^(['"])(.*)\1$/;
const MAX_CHARS = 64_000;
const MAX_TOTAL_CHARS = 256_000;
const MAX_DEPTH = 5;
const BOM_RE = /^\uFEFF/;

/** Loads project instructions through the same tenant-scoped filesystem as tools, never host/home discovery. */
export async function loadWorkspaceInstructions(
  filesystem: WorkspaceFilesystem,
  root: string
): Promise<InstructionSource[]> {
  const workspaceRoot = posix.normalize(root);
  let remaining = MAX_TOTAL_CHARS;
  const expand = async (
    path: string,
    visited: ReadonlySet<string>
  ): Promise<string> => {
    if (visited.has(path) || visited.size > MAX_DEPTH) {
      throw new Error(
        `Project instruction import cycle/depth limit at ${path}.`
      );
    }
    const relativePath = posix.relative(workspaceRoot, path);
    // Reject large files before reading; four bytes cover one UTF-8 code point.
    if ((await filesystem.stat(relativePath)).size > MAX_CHARS * 4) {
      throw new Error("Project instructions exceed the bounded context size.");
    }
    const value = await filesystem.readFile(relativePath, { encoding: "utf8" });
    const text = (
      typeof value === "string" ? value : value.toString("utf8")
    ).replace(BOM_RE, "");
    remaining -= text.length;
    if (text.length > MAX_CHARS || remaining < 0) {
      throw new Error("Project instructions exceed the bounded context size.");
    }
    const nextVisited = new Set([...visited, path]);
    let offset = 0;
    const parts: string[] = [];
    for (const match of text.matchAll(IMPORT_RE)) {
      const relative = (match[1] ?? "").trim().replace(QUOTED_RE, "$2");
      const imported = posix.resolve(posix.dirname(path), relative);
      const fromRoot = posix.relative(workspaceRoot, imported);
      if (
        !relative ||
        posix.isAbsolute(relative) ||
        relative.includes("\\") ||
        fromRoot === ".." ||
        fromRoot.startsWith("../")
      ) {
        throw new Error(
          `Project instruction import escapes the verified workspace: ${path}.`
        );
      }
      parts.push(text.slice(offset, match.index));
      // biome-ignore lint/performance/noAwaitInLoops: imports share a bounded budget and must expand in source order
      parts.push(await expand(imported, nextVisited));
      offset = match.index + match[0].length;
    }
    parts.push(text.slice(offset));
    return parts.join("");
  };

  const sources: InstructionSource[] = [];
  for (const candidate of CANDIDATES) {
    const path = posix.join(workspaceRoot, candidate.relative);
    // biome-ignore lint/performance/noAwaitInLoops: preserve instruction precedence and the shared import size budget
    if (await filesystem.exists(candidate.relative)) {
      const content = await expand(path, new Set());
      sources.push({
        ...candidate,
        content,
        contentHash: hashContent(content),
        depth: 0,
        path,
        scope: "project",
      });
    }
  }
  return selectInstructionSources(sources);
}
