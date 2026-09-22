// SPDX-License-Identifier: MIT
// Ported from spectra (MIT, the project owner's own codebase) —
// packages/code/src/tools/write.ts.

/**
 * The write tool: create or overwrite one file and report the unified diff.
 *
 * The spectra original resolved the path against `process.cwd()`, created the
 * parent directory when missing, wrote the whole content, and returned the
 * `diff` patch as a text result. Here the same work is a pure async
 * {@link writeFileContent} — Node's async `fs` APIs instead of the sync ones —
 * plus a `createTool` wrapper. The terminal-UI display name and the text/error
 * result helpers are dropped.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { createTool } from "@mastra/core/tools";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";

/** The path to write and the full content to put there. */
export interface WriteFileContentInput {
  content: string;
  path: string;
}

/** Options for {@link writeFileContent} and {@link createWriteTool}. */
export interface WriteToolOptions {
  /** Base for a relative `path`. Defaults to the process working directory. */
  cwd?: string | undefined;
}

/** What one write did. */
export interface WriteFileResult {
  /** True when nothing existed at `path` before this write. */
  created: boolean;
  /** Unified diff from the previous content to the new content. */
  patch: string;
  /** Absolute path that was written. */
  path: string;
}

const writeParameters = z.object({
  content: z.string().describe("The full content to write to the file"),
  path: z.string().describe("Absolute or relative path to the file to write"),
});

/**
 * True when `target` exists. A path the process cannot stat is treated as
 * absent, which is what the original's `existsSync` check did.
 */
async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    // Not present, or not reachable: either way there is nothing to preserve.
    return false;
  }
}

/**
 * Write `input.content` to `input.path`, creating the parent directory and the
 * file itself when they are missing, and return the unified diff of the change.
 */
export async function writeFileContent(
  input: WriteFileContentInput,
  options: WriteToolOptions = {}
): Promise<WriteFileResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const { content, path: filePath } = input;
  const resolved = resolve(cwd, filePath);
  const parentDir = dirname(resolved);
  if (!(await pathExists(parentDir))) {
    await mkdir(parentDir, { recursive: true });
  }
  const existed = await pathExists(resolved);
  const oldContent = existed ? await readFile(resolved, "utf8") : "";
  await writeFile(resolved, content, "utf8");

  const fileName = basename(resolved);
  const patch = createTwoFilesPatch(
    oldContent ? `a/${fileName}` : "/dev/null",
    `b/${fileName}`,
    oldContent,
    content,
    undefined,
    undefined,
    { context: 3 }
  );

  return { created: !existed, patch, path: resolved };
}

/** Build the `write` tool: one file per call, diff reported back. */
export function createWriteTool(options: WriteToolOptions = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  return createTool({
    description: `Write content to a file, creating it if it doesn't exist.
If the file exists, it will be overwritten.
For small changes to existing files, prefer the edit tool.
Creates parent directories automatically if they don't exist.`,
    execute: async (args) => await writeFileContent(args, { cwd }),
    id: "write",
    inputSchema: writeParameters,
    outputSchema: z.object({
      created: z.boolean(),
      patch: z.string(),
      path: z.string(),
    }),
  });
}
