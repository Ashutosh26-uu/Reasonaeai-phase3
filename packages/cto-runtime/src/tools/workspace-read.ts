import { posix } from "node:path";

import type { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import type { WorkspaceFilesystem } from "@mastra/core/workspace";
import { z } from "zod";
import type { ResourceRouter } from "../resources/router.js";
import type { ResolveContext } from "../resources/types.js";
import { ResourceError } from "../resources/types.js";
import { formatHashlineHeader, formatNumberedLine } from "./hashline/format.js";
import { assertTextContent, splitLines } from "./read.js";
import type { ReadSnapshotStore } from "./read-snapshots.js";
import {
  type LineRange,
  selectorIsConflicts,
  selectorIsRaw,
  selectorLineRanges,
  selectorTailCount,
  splitPathAndSel,
} from "./selectors.js";

const MAX_INLINE_BYTES = 60_000;
const MAX_INLINE_LINES = 2000;
const AT_PREFIX_RE = /^@(?=[^@])/;
const FILE_URL_RE = /^file:\/\/(?:\/)?/i;
const URI_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

export interface WorkspaceReadToolOptions {
  resolveFilesystem: (
    requestContext: RequestContext
  ) => Promise<WorkspaceFilesystem>;
  resolveResourceContext?: (
    requestContext: RequestContext
  ) => Promise<ResolveContext>;
  resolveRouter?: (requestContext: RequestContext) => Promise<ResourceRouter>;
  resolveSnapshots: (
    requestContext: RequestContext
  ) => Promise<ReadSnapshotStore>;
  root?: string | undefined;
}

function resolveRanges(
  selector: string | undefined,
  totalLines: number
): [LineRange, ...LineRange[]] | undefined {
  const ranges = selectorLineRanges(selector);
  if (ranges !== undefined) {
    return ranges;
  }

  const tail = selectorTailCount(selector);
  if (tail === undefined) {
    return undefined;
  }

  return [
    { endLine: totalLines, startLine: Math.max(1, totalLines - tail + 1) },
  ];
}

function workspacePath(pathArgument: string, root: string): string {
  const trimmed = pathArgument
    .trim()
    .replace(AT_PREFIX_RE, "")
    .replace(FILE_URL_RE, "")
    .replaceAll("\\", "/");
  if (trimmed.length === 0 || trimmed.includes("\0")) {
    throw new Error("A non-empty workspace path is required.");
  }
  if (trimmed === "~" || trimmed.startsWith("~/")) {
    throw new Error("Home-directory paths are not available in the workspace.");
  }

  const target = trimmed.startsWith("/")
    ? posix.normalize(trimmed)
    : posix.resolve(root, trimmed);
  const relative = posix.relative(root, target);
  if (relative === ".." || relative.startsWith("../")) {
    throw new Error("The path escapes the verified project workspace.");
  }
  return target;
}

function relativePath(path: string, root: string): string {
  const relative = posix.relative(root, path);
  return relative === "" ? "." : relative;
}

function conflictSummary(lines: readonly string[]): string {
  const matches = lines
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(
      ({ line }) => line.startsWith("<<<<<<<") || line.startsWith(">>>>>>>")
    );
  if (matches.length === 0) {
    return "No unresolved merge conflicts in this file.";
  }
  return `${matches.length} conflict marker line(s):\n${matches
    .map(({ line, number }) => `${number}: ${line}`)
    .join("\n")}`;
}

function selectedLineNumbers(
  ranges: readonly LineRange[] | undefined,
  total: number
): number[] {
  const selected = ranges ?? [{ endLine: total, startLine: 1 }];
  const numbers: number[] = [];
  for (const range of selected) {
    const end = Math.min(range.endLine ?? total, total);
    for (let number = range.startLine; number <= end; number += 1) {
      numbers.push(number);
    }
  }
  return numbers;
}

function renderBoundedLines(
  lines: readonly string[],
  numbers: readonly number[]
) {
  const shown: number[] = [];
  const output: string[] = [];
  let bytes = 0;

  for (const number of numbers) {
    if (shown.length === MAX_INLINE_LINES) {
      break;
    }
    const row = formatNumberedLine(number, lines[number - 1] ?? "");
    const rowBytes = Buffer.byteLength(row, "utf8") + 1;
    if (bytes + rowBytes > MAX_INLINE_BYTES) {
      break;
    }
    bytes += rowBytes;
    shown.push(number);
    output.push(row);
  }

  const omitted = numbers.length - shown.length;
  if (omitted > 0) {
    output.push(
      `---- ${omitted} selected line(s) omitted; read a narrower range to continue ----`
    );
  }

  return { shown, text: output.join("\n") };
}

async function listDirectory(
  filesystem: WorkspaceFilesystem,
  path: string
): Promise<string> {
  const entries = await filesystem.readdir(path, {
    recursive: false,
  });
  if (entries.length === 0) {
    return "(empty directory)";
  }
  return entries
    .slice()
    .sort((left, right) => {
      const directoryOrder =
        Number(right.type === "directory") - Number(left.type === "directory");
      return directoryOrder || left.name.localeCompare(right.name);
    })
    .map((entry) => `${entry.name}${entry.type === "directory" ? "/" : ""}`)
    .join("\n");
}

async function readRegisteredResource(
  target: string,
  requestContext: RequestContext,
  input: WorkspaceReadToolOptions
): Promise<string | undefined> {
  if (!(input.resolveRouter && input.resolveResourceContext)) {
    return undefined;
  }
  const router = await input.resolveRouter(requestContext);
  if (!router.canHandle(target)) {
    return undefined;
  }
  const resource = await router.resolve(
    target,
    await input.resolveResourceContext(requestContext)
  );
  return resource.content;
}

async function readWorkspaceFile(
  target: string,
  requestContext: RequestContext,
  input: WorkspaceReadToolOptions,
  root: string
): Promise<string> {
  const { path: pathArgument, sel } = splitPathAndSel(target);
  const path = workspacePath(pathArgument, root);
  const filesystem = await input.resolveFilesystem(requestContext);
  const metadata = await filesystem.stat(path);

  if (metadata.type === "directory") {
    if (sel !== undefined) {
      throw new ResourceError(
        "A selector cannot be applied to a directory.",
        "Read the directory first, then select lines from a file inside it."
      );
    }
    return await listDirectory(filesystem, path);
  }

  const content = await filesystem.readFile(path, { encoding: "utf8" });
  const text = typeof content === "string" ? content : content.toString("utf8");
  assertTextContent(path, Buffer.from(text, "utf8"));
  const lines = splitLines(text);

  if (selectorIsConflicts(sel)) {
    return conflictSummary(lines);
  }
  if (selectorIsRaw(sel)) {
    return text;
  }

  const numbers = selectedLineNumbers(
    resolveRanges(sel, lines.length),
    lines.length
  );
  const rendered = renderBoundedLines(lines, numbers);
  const snapshot = await input.resolveSnapshots(requestContext);
  const tag = await snapshot.record(path, text, rendered.shown);
  if (tag === undefined) {
    return `${rendered.text}\n---- no edit anchor: file exceeds the snapshot limit ----`;
  }
  return `${formatHashlineHeader(relativePath(path, root), tag)}\n${rendered.text}`;
}

/**
 * The Mastra-native unified read surface. It resolves the filesystem from the
 * verified request context on each invocation, never from a model path or the
 * API host. Registered resource URIs use the same front door and retain their
 * own authorization-aware resolver.
 */
export function createWorkspaceReadTool(input: WorkspaceReadToolOptions) {
  const root = posix.normalize(input.root ?? "/");
  return createTool({
    description:
      "Read a project file, directory, or registered resource URL. File reads emit hashline anchors for the edit tool; use an optional :line-range, :raw, or :conflicts selector. Every filesystem path is confined to the verified project workspace.",
    execute: async ({ target }, context) => {
      const trimmed = target.trim();
      if (trimmed.length === 0) {
        throw new ResourceError("A read target is required.");
      }
      const resource = await readRegisteredResource(
        trimmed,
        context.requestContext,
        input
      );
      if (resource !== undefined) {
        return resource;
      }
      if (URI_RE.test(trimmed)) {
        throw new ResourceError(
          `No registered resource handler can read ${trimmed}.`,
          "Use a project path, or a URI scheme granted to this run."
        );
      }
      return await readWorkspaceFile(
        trimmed,
        context.requestContext,
        input,
        root
      );
    },
    id: "read",
    inputSchema: z.strictObject({
      target: z.string().min(1).max(8192),
    }),
    outputSchema: z.string(),
  });
}
