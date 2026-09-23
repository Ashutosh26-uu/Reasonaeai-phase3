// SPDX-License-Identifier: MIT
// Ported from spectra (MIT, the project owner's own codebase) —
// packages/code/src/tools/edit.ts.

/**
 * The edit tool: one exact replacement, or one complete native hashline patch.
 *
 * Two modes share one entry point. Exact replacement takes `path`, `oldString`,
 * and `newString` and splices a whitespace-tolerant match; hashline mode takes
 * a `patch` alone and hands it to the {@link Patcher}, which validates section
 * tags, enforces seen-line provenance, and confines every write to the working
 * directory.
 *
 * The spectra original wrapped both mode bodies in one terminal-UI tool
 * `execute`. Here the body is a pure async {@link applyEditRequest} that
 * returns a discriminated outcome, plus a `createTool` wrapper that throws on
 * failure. Node's async `fs` APIs replace the sync ones, and the terminal-UI
 * display name plus the text/error result helpers are dropped.
 */

import { realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import type { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import type { WorkspaceFilesystem as MastraWorkspaceFilesystem } from "@mastra/core/workspace";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";

import { applyEdit } from "./edit-match.js";
import {
  type Filesystem,
  NodeFilesystem,
  type WriteResult,
} from "./hashline/fs.js";
import { Patch } from "./hashline/input.js";
import { Patcher } from "./hashline/patcher.js";
import type { BlockResolver } from "./hashline/types.js";
import { ReadSnapshotStore } from "./read-snapshots.js";
import { WorkspaceHashlineFilesystem } from "./workspace-filesystem.js";

/** Options for {@link applyEditRequest} and {@link createEditTool}. */
export interface EditToolOptions {
  /** Base for the file path, and for patch paths. Defaults to `process.cwd()`. */
  cwd?: string | undefined;
  /**
   * Hashline storage. Production callers pass a workspace-backed adapter;
   * Node storage remains available only for isolated unit tests and migrations.
   */
  filesystem?: Filesystem | undefined;
  /** Store the patcher resolves section tags against, and edits record into. */
  snapshots?: ReadSnapshotStore | undefined;
}

/** Arguments for {@link applyEditRequest}. Exactly one mode is used. */
export interface EditRequestArgs {
  /** The replacement text, with `path` and `oldString`. */
  newString?: string | undefined;
  /** The exact text to find, with `path` and `newString`. */
  oldString?: string | undefined;
  /** A native hashline patch; not combined with the other fields. */
  patch?: string | undefined;
  /** The file to edit, with `oldString` and `newString`. */
  path?: string | undefined;
}

/**
 * Outcome of {@link applyEditRequest}: the report text — a unified diff, or one
 * line per patch section — or the reason nothing was written.
 */
export type ApplyEditRequestResult =
  | { cause?: unknown; error: string; ok: false }
  | { ok: true; output: string };

/** A quoted string literal, escapes included, on one line. */
const STRING_LITERAL_RE = /(["'`])(?:\\.|(?!\1)[^\\])*?\1/g;

/** An opening bracket of any kind. */
const OPENING_BRACKET_RE = /[({[]/g;

/** A closing bracket of any kind. */
const CLOSING_BRACKET_RE = /[)}\]]/g;

/** A line's leading whitespace. */
const LEADING_INDENT_RE = /^(\s*)/;

/** A search string's line separator, which may be CRLF. */
const LINE_SPLIT_RE = /\r?\n/;

const editParameters = z
  .object({
    newString: z.string().optional().describe("The replacement text"),
    oldString: z
      .string()
      .optional()
      .describe("The exact text to find and replace"),
    patch: z
      .string()
      .optional()
      .describe(
        "Native hashline patch with [path#TAG] sections produced by read"
      ),
    path: z
      .string()
      .optional()
      .describe("Absolute or relative path to the file to edit"),
  })
  .superRefine((value, context) => {
    if (value.patch) {
      if (value.path || value.oldString || value.newString) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "patch cannot be combined with path, oldString, or newString",
        });
      }
      return;
    }
    if (
      !value.path ||
      value.oldString === undefined ||
      value.newString === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provide patch or path, oldString, and newString",
      });
    }
  });

/** Leading-whitespace width of `line`. */
function indentationWidth(line: string): number {
  return line.match(LEADING_INDENT_RE)?.[1]?.length ?? 0;
}

const blockResolver: BlockResolver = ({ line, text }) => {
  const lines = text.split("\n");
  const start = line - 1;
  const anchorLine = lines[start];
  if (start < 0 || anchorLine === undefined || anchorLine.trim().length === 0) {
    return null;
  }
  const indentation = indentationWidth(anchorLine);
  let depth = 0;
  for (let index = start; index < lines.length; index += 1) {
    const current = lines[index] ?? "";
    const source = current.replace(STRING_LITERAL_RE, "");
    depth +=
      (source.match(OPENING_BRACKET_RE) ?? []).length -
      (source.match(CLOSING_BRACKET_RE) ?? []).length;
    if (
      index > start &&
      depth <= 0 &&
      (indentation === 0 || indentationWidth(current) <= indentation)
    ) {
      return { end: index + 1, start: line };
    }
  }
  for (let index = start + 1; index < lines.length; index += 1) {
    const current = lines[index] ?? "";
    const currentIndentation = indentationWidth(current);
    if (current.trim().length > 0 && currentIndentation <= indentation) {
      return { end: index, start: line };
    }
  }
  return null;
};

/**
 * The working-directory jail. Canonical paths are real paths, so the snapshot
 * store keys on the same file the model read; and a section whose authored path
 * is missing may only be redirected to a tagged file inside `cwd`.
 */
class NodeWorkspaceFilesystem extends NodeFilesystem {
  readonly #cwd: string;

  constructor(cwd: string) {
    super();
    this.#cwd = cwd;
  }

  override canonicalPath(filePath: string): string {
    let canonical: string;
    const candidate = isAbsolute(filePath)
      ? filePath
      : resolve(this.#cwd, filePath);
    try {
      canonical = realpathSync.native(candidate);
    } catch {
      canonical = resolve(candidate);
    }
    const relativeToCwd = relative(this.#cwd, canonical);
    if (
      relativeToCwd === ".." ||
      relativeToCwd.startsWith(`..${sep}`) ||
      isAbsolute(relativeToCwd)
    ) {
      throw new Error("The path escapes the working directory.");
    }
    return canonical;
  }

  override async readText(filePath: string): Promise<string> {
    return await super.readText(this.canonicalPath(filePath));
  }

  override async readBinary(filePath: string): Promise<Uint8Array> {
    return await super.readBinary(this.canonicalPath(filePath));
  }

  override async writeText(
    filePath: string,
    content: string
  ): Promise<WriteResult> {
    return await super.writeText(this.canonicalPath(filePath), content);
  }

  override async delete(filePath: string): Promise<void> {
    await super.delete(this.canonicalPath(filePath));
  }

  override async move(
    from: string,
    to: string,
    content?: string
  ): Promise<void> {
    await super.move(this.canonicalPath(from), this.canonicalPath(to), content);
  }

  override allowTagPathRecovery(
    _authoredPath: string,
    resolvedPath: string
  ): boolean {
    const relativeToCwd = relative(this.#cwd, resolvedPath);
    return (
      relativeToCwd === "" ||
      (!relativeToCwd.startsWith(`..${sep}`) &&
        relativeToCwd !== ".." &&
        !isAbsolute(relativeToCwd))
    );
  }
}

/**
 * Apply one edit request. Patch mode reports one line per section; exact
 * replacement mode refuses a missing file, refuses an unmatched or ambiguous
 * `oldString`, and writes only after the splice succeeded.
 */
export async function applyEditRequest(
  args: EditRequestArgs,
  options: EditToolOptions = {}
): Promise<ApplyEditRequestResult> {
  const cwd = options.filesystem
    ? (options.cwd ?? "/")
    : resolve(options.cwd ?? process.cwd());
  const filesystem = options.filesystem ?? new NodeWorkspaceFilesystem(cwd);
  const snapshots = options.snapshots ?? new ReadSnapshotStore();
  const { newString, oldString, patch, path: filePath } = args;
  try {
    if (patch) {
      const patcher = new Patcher({
        blockResolver,
        fs: filesystem,
        snapshots: snapshots.store,
      });
      const result = await patcher.apply(Patch.parse(patch, { cwd }));
      const lines = result.sections.map((section) => {
        const at = section.firstChangedLine
          ? ` at line ${section.firstChangedLine}`
          : "";
        return `${section.header}\n${section.op}${at}`;
      });
      return { ok: true, output: lines.join("\n") };
    }
    if (
      filePath === undefined ||
      oldString === undefined ||
      newString === undefined
    ) {
      return {
        error: "provide patch or path, oldString, and newString",
        ok: false,
      };
    }
    const resolved = filesystem.canonicalPath(resolve(cwd, filePath));
    if (!(await filesystem.exists(resolved))) {
      return { error: `File not found: ${resolved}`, ok: false };
    }
    const content = await filesystem.readText(resolved);
    const edited = applyEdit(content, oldString, newString);
    // `applyEdit` returns either the new text or the reason it refused.
    if (edited.error || edited.content === undefined) {
      const reason =
        edited.error ??
        "No changes made - the replacement didn't modify the file.";
      return {
        error: `${reason} [${relative(cwd, resolved)}]`,
        ok: false,
      };
    }
    const newContent = edited.content;
    await filesystem.writeText(resolved, newContent);
    await snapshots.record(
      resolved,
      newContent,
      newContent.split(LINE_SPLIT_RE).map((_, index) => index + 1)
    );
    const fileName = basename(resolved);
    const output = createTwoFilesPatch(
      `a/${fileName}`,
      `b/${fileName}`,
      content,
      newContent,
      undefined,
      undefined,
      { context: 3 }
    );
    return { ok: true, output };
  } catch (error) {
    return {
      cause: error,
      error: error instanceof Error ? error.message : String(error),
      ok: false,
    };
  }
}

/** Build the `edit` tool: one exact replacement, or one hashline patch. */
export function createEditTool(options: EditToolOptions = {}) {
  const cwd = options.filesystem
    ? (options.cwd ?? "/")
    : resolve(options.cwd ?? process.cwd());
  const snapshots = options.snapshots ?? new ReadSnapshotStore();
  return createTool({
    description: `Edit an existing file with an exact replacement, or apply a complete native hashline patch returned by read.
Exact replacement: provide path, oldString, and newString. Matching is whitespace-tolerant.
Hashline: provide patch only. Every edited section must use the current [path#TAG] header emitted by read. The patcher supports validated multi-section edits, create/delete/move operations, stale-version recovery, and seen-line enforcement. Patch paths and recovered destinations are restricted to the working directory.
Always read before modifying code.`,
    execute: async (args) => {
      const outcome = await applyEditRequest(args, {
        cwd,
        ...(options.filesystem === undefined
          ? {}
          : { filesystem: options.filesystem }),
        snapshots,
      });
      if (!outcome.ok) {
        throw new Error(
          outcome.error,
          outcome.cause === undefined ? undefined : { cause: outcome.cause }
        );
      }
      return outcome.output;
    },
    id: "edit",
    inputSchema: editParameters,
    outputSchema: z.string(),
  });
}

/**
 * Build the production edit tool. The filesystem is resolved from the current
 * verified request context, preventing a model argument from selecting either
 * another run's workspace or a host path.
 */
export function createWorkspaceEditTool(input: {
  resolveFilesystem: (
    requestContext: RequestContext
  ) => Promise<MastraWorkspaceFilesystem>;
  resolveSnapshots: (
    requestContext: RequestContext
  ) => Promise<ReadSnapshotStore>;
  root?: string | undefined;
}) {
  return createTool({
    description:
      "Edit an existing project file with an exact replacement, or apply a complete native hashline patch returned by read. Every target remains in the verified project workspace; hashline sections require current anchors and reject stale or fabricated anchors.",
    execute: async (args, context) => {
      const filesystem = new WorkspaceHashlineFilesystem({
        filesystem: await input.resolveFilesystem(context.requestContext),
        ...(input.root === undefined ? {} : { root: input.root }),
      });
      const snapshots = await input.resolveSnapshots(context.requestContext);
      const outcome = await applyEditRequest(args, {
        cwd: input.root ?? "/",
        filesystem,
        snapshots,
      });
      if (!outcome.ok) {
        throw new Error(
          outcome.error,
          outcome.cause === undefined ? undefined : { cause: outcome.cause }
        );
      }
      return outcome.output;
    },
    id: "edit",
    inputSchema: editParameters,
    outputSchema: z.string(),
  });
}
