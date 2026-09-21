/**
 * The read tool: one front door over every readable target.
 *
 * A single tool addresses sandbox files, directories, and every registered
 * resource scheme. That is deliberate: a model with one read surface does not
 * have to be told which of a dozen tools reaches a skill, an artifact, or a
 * project rule, and a new kind of resource does not require a new tool.
 *
 * Output is shaped so the model can act on it without re-reading:
 *
 * - Gutter numbers reflect the file's real numbering, not the excerpt's, so an
 *   edit can cite exact lines from a partial view.
 * - Truncation is always announced. Silent truncation is the failure this guards
 *   against: the model would believe it saw the whole file.
 * - When output is spilled, the notice carries the handle that pages it back, so
 *   nothing becomes unreachable by being large.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import type { ResourceRouter } from "../resources/router.js";
import type { ResolveContext } from "../resources/types.js";
import { ResourceError } from "../resources/types.js";
import {
  type LineRange,
  selectorIsConflicts,
  selectorIsRaw,
  selectorLineRanges,
  selectorTailCount,
  splitPathAndSel,
} from "./selectors.js";

/** Largest number of child directories listed for one directory. */
const DIRECTORY_CHILD_LIMIT = 12;

/** How many levels below the requested directory the listing expands. */
const DIRECTORY_MAX_DEPTH = 2;

/** Largest text output returned inline, in bytes, before it is spilled. */
const DEFAULT_MAX_INLINE_BYTES = 60_000;

/** Largest number of lines returned inline, before the tail is elided. */
const DEFAULT_MAX_INLINE_LINES = 2000;

const UNICODE_SPACE_RE = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const AT_PREFIX_RE = /^@(?=[^@])/;
const FILE_URL_RE = /^file:\/\/(?:\/)?/i;
const ESCAPED_SEPARATOR_RE = /\\(?=[\\ ])/g;
const TRAILING_SLASHES_RE = /[/\\]+$/;
const LINE_BREAK_RE = /\r\n|\n|\r/;

/** Where a read's content came from, so a caller can present it differently. */
export type ReadKind = "file" | "directory" | "resource" | "range";

/** A truncation that happened, so the caller reports it rather than hiding it. */
export interface Truncation {
  /** The handle that recovers the full text, when it was spilled. */
  artifactUrl?: string | undefined;
  /** Lines omitted from the end. */
  omittedLines?: number | undefined;
  reason: "lines" | "bytes";
}

export interface ReadResult {
  kind: ReadKind;
  /** The line ranges actually shown, for a ranged read. */
  shownRanges?: LineRange[] | undefined;
  /** Absolute path or canonical URL that was read. */
  target: string;
  /** The text to show the model. */
  text: string;
  truncation?: Truncation | undefined;
}

export interface ReadOptions {
  maxInlineBytes?: number | undefined;
  maxInlineLines?: number | undefined;
  /** Writes spilled text and returns its artifact id. Omit to disable spilling. */
  spill?: ((content: string, extension: string) => Promise<number>) | undefined;
}

/**
 * Normalize a path argument before it is resolved.
 *
 * Models produce paths out of surrounding prose, so the common noise is removed:
 * a leading `@`, a `file://` prefix, escaped and non-breaking spaces, and
 * matching surrounding quotes. Each is a real near-miss that would otherwise
 * become "file not found" for a file that plainly exists.
 */
export function normalizePathArgument(input: string): string {
  let value = input.trim();

  if (value.startsWith('"') && value.endsWith('"') && value.length > 1) {
    value = value.slice(1, -1);
  }

  value = value
    .replace(FILE_URL_RE, "")
    .replace(AT_PREFIX_RE, "")
    .replace(UNICODE_SPACE_RE, " ")
    .replace(ESCAPED_SEPARATOR_RE, "");

  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homedir(), value.slice(2));
  }

  // A trailing separator names the same target, but confuses extension and
  // basename handling downstream, so it is removed here.
  if (value.length > 1 && TRAILING_SLASHES_RE.test(value)) {
    value = value.replace(TRAILING_SLASHES_RE, "");
  }

  return value;
}

/** Resolve a read target to an absolute path, tolerating an absolute input. */
export function resolveReadPath(pathArgument: string, cwd: string): string {
  const normalized = normalizePathArgument(pathArgument);
  return isAbsolute(normalized)
    ? resolve(normalized)
    : resolve(cwd, normalized);
}

/** Width of the line-number gutter. */
export function gutterWidth(highestLineNumber: number): number {
  return Math.max(4, String(highestLineNumber).length);
}

/** Split file text into lines, excluding a trailing empty line. */
export function splitLines(content: string): string[] {
  const lines = content.split(LINE_BREAK_RE);
  if (lines.length > 1 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Render an excerpt with a gutter.
 *
 * A gap between two disjoint ranges is marked with its boundary line numbers, so
 * the model can tell that content was skipped between them rather than reading
 * the excerpt as continuous.
 */
export function renderLines(
  lines: readonly string[],
  ranges: readonly LineRange[] | undefined,
  totalLines: number
): { text: string; shownRanges: LineRange[] } {
  const selected: LineRange[] =
    ranges !== undefined && ranges.length > 0
      ? [...ranges]
      : [{ endLine: totalLines === 0 ? 1 : totalLines, startLine: 1 }];

  const width = gutterWidth(
    Math.max(
      totalLines,
      ...selected.map((range) => range.endLine ?? totalLines)
    )
  );

  const rendered: string[] = [];

  for (const [index, range] of selected.entries()) {
    const previous = index === 0 ? undefined : selected[index - 1];
    if (previous !== undefined) {
      const gapStart = (previous.endLine ?? totalLines) + 1;
      const gapEnd = range.startLine - 1;
      if (gapEnd >= gapStart) {
        rendered.push(`---- omitted lines ${gapStart}-${gapEnd} ----`);
      }
    }

    const end = Math.min(range.endLine ?? totalLines, totalLines);

    for (let line = range.startLine; line <= end; line += 1) {
      rendered.push(
        `${String(line).padStart(width, " ")}| ${lines[line - 1] ?? ""}`
      );
    }
  }

  return { shownRanges: selected, text: rendered.join("\n") };
}

/**
 * Format a directory listing.
 *
 * Child directories are capped because a directory holding thousands of entries
 * would crowd out the file the agent needs. The marker states the real
 * remainder, so the cap is visible instead of looking complete.
 */
export function formatDirectoryListing(
  entries: readonly { name: string; isDirectory: boolean }[],
  childLimit = DIRECTORY_CHILD_LIMIT
): string {
  const directories = entries.filter((entry) => entry.isDirectory);
  const files = entries.filter((entry) => !entry.isDirectory);

  const shownDirectories = directories.slice(0, childLimit);
  const hiddenDirectories = directories.length - shownDirectories.length;

  const lines: string[] = [
    ...shownDirectories.map((entry) => `${entry.name}/`),
    ...(hiddenDirectories > 0
      ? [`… ${hiddenDirectories} more directories`]
      : []),
    ...files.map((entry) => entry.name),
  ];

  return lines.length === 0 ? "(empty directory)" : lines.join("\n");
}

async function readDirectory(
  directoryPath: string,
  maxDepth: number
): Promise<string> {
  const dirents = await readdir(directoryPath, { withFileTypes: true });

  dirents.sort((left, right) => {
    const directoryOrder =
      Number(right.isDirectory()) - Number(left.isDirectory());
    return directoryOrder || left.name.localeCompare(right.name);
  });

  const top = formatDirectoryListing(
    dirents.map((entry) => ({
      isDirectory: entry.isDirectory(),
      name: entry.name,
    }))
  );

  if (maxDepth <= 0) {
    return top;
  }

  // A directory listing alone does not say where the code lives. Expanding the
  // first levels saves the round trips a model would otherwise spend descending,
  // while the depth bound stops a large tree from crowding out the top level.
  const subdirectories = dirents
    .filter((entry) => entry.isDirectory())
    .slice(0, DIRECTORY_CHILD_LIMIT);

  const expanded = await Promise.all(
    subdirectories.map(async (entry) => {
      const childPath = join(directoryPath, entry.name);
      const childDirents = await readdir(childPath, {
        withFileTypes: true,
      }).catch(() => []);
      if (childDirents.length === 0) {
        return "";
      }
      childDirents.sort((left, right) => {
        const directoryOrder =
          Number(right.isDirectory()) - Number(left.isDirectory());
        return directoryOrder || left.name.localeCompare(right.name);
      });
      const lines = formatDirectoryListing(
        childDirents.map((child) => ({
          isDirectory: child.isDirectory(),
          name: child.name,
        }))
      );
      return `${entry.name}/\n${indent(lines)}`;
    })
  );

  const withChildren = expanded.filter((section) => section !== "");
  if (withChildren.length === 0) {
    return top;
  }

  return `${top}\n\n${withChildren.join("\n\n")}`;
}

/** Indent a nested listing so the directory it belongs to stays identifiable. */
function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

/**
 * Bound the output, spilling the overflow.
 *
 * Line limiting runs first so the elision happens on a line boundary and the
 * remaining text stays readable. Byte limiting then guards the case of a few
 * extremely long lines.
 */
async function boundOutput(
  text: string,
  spillText: string,
  target: string,
  options: ReadOptions
): Promise<{ text: string; truncation?: Truncation | undefined }> {
  const maxLines = options.maxInlineLines ?? DEFAULT_MAX_INLINE_LINES;
  const lines = text.split("\n");

  let bounded = text;
  let omittedLines: number | undefined;

  if (lines.length > maxLines) {
    omittedLines = lines.length - maxLines;
    bounded = `${lines.slice(0, maxLines).join("\n")}\n---- ${omittedLines} more lines ----\n`;
  }

  const maxBytes = options.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES;
  const byteLength = Buffer.byteLength(bounded, "utf-8");

  if (byteLength > maxBytes) {
    const artifactUrl =
      options.spill === undefined
        ? undefined
        : `artifact://${await options.spill(spillText, extensionOf(target))}`;

    const kept: string[] = [];
    let used = 0;
    for (const line of bounded.split("\n")) {
      const lineBytes = Buffer.byteLength(line, "utf-8") + 1;
      if (used + lineBytes > maxBytes) {
        break;
      }
      kept.push(line);
      used += lineBytes;
    }

    const notice = [
      "",
      `---- output truncated: ${byteLength} bytes exceed the ${maxBytes}-byte inline limit ----`,
      artifactUrl === undefined
        ? "Read a narrower line range to see the rest."
        : `Read the full output with ${artifactUrl}, optionally with a line range such as ${artifactUrl}:1-200.`,
    ].join("\n");

    return {
      text: `${kept.join("\n")}\n${notice}`,
      truncation: { artifactUrl, omittedLines, reason: "bytes" },
    };
  }

  if (omittedLines === undefined) {
    return { text: bounded };
  }

  return { text: bounded, truncation: { omittedLines, reason: "lines" } };
}

function extensionOf(target: string): string {
  const name = basename(target);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "txt";
}

/** Describe the unresolved conflict regions in a file. */
function summarizeConflicts(lines: readonly string[]): string {
  const markers = lines
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(
      ({ line }) => line.startsWith("<<<<<<<") || line.startsWith(">>>>>>>")
    );

  if (markers.length === 0) {
    return "No unresolved merge conflicts in this file.";
  }

  const header = `${markers.length} conflict marker line(s):`;
  const body = markers
    .map(({ line, number }) => `${number}: ${line}`)
    .join("\n");
  return `${header}\n${body}`;
}

/**
 * Resolve a selector to concrete ranges.
 *
 * A tail count can only be resolved here, where the file's length is known, so
 * `:-60` becomes the last sixty lines of this file rather than being passed
 * through as an unresolved token.
 */
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

  const startLine = Math.max(1, totalLines - tail + 1);
  return [{ endLine: totalLines, startLine }];
}

async function readFileTarget(
  absolutePath: string,
  selector: string | undefined,
  options: ReadOptions
): Promise<ReadResult> {
  const content = await readFile(absolutePath, "utf-8");
  const lines = splitLines(content);

  if (selectorIsConflicts(selector)) {
    return {
      kind: "file",
      target: absolutePath,
      text: summarizeConflicts(lines),
    };
  }

  if (selectorIsRaw(selector)) {
    // Verbatim: the caller wants the bytes, not a numbered view.
    const bounded = await boundOutput(content, content, absolutePath, options);
    return {
      kind: "file",
      target: absolutePath,
      text: bounded.text,
      truncation: bounded.truncation,
    };
  }

  const ranges = resolveRanges(selector, lines.length);
  const rendered = renderLines(lines, ranges, lines.length);
  const bounded = await boundOutput(
    rendered.text,
    content,
    absolutePath,
    options
  );

  return {
    kind: ranges === undefined ? "file" : "range",
    target: absolutePath,
    text: bounded.text,
    ...(ranges === undefined ? {} : { shownRanges: rendered.shownRanges }),
    truncation: bounded.truncation,
  };
}

/**
 * Read any target: a resource URL, a directory, or a file.
 *
 * Resource URLs go to the router so the resource layer stays the one place that
 * knows about schemes. A directory returns a listing, which is also how a caller
 * discovers what exists before reading it.
 */
export async function readTarget(
  target: string,
  context: ResolveContext,
  router: ResourceRouter,
  options: ReadOptions = {}
): Promise<ReadResult> {
  const trimmed = target.trim();

  if (trimmed === "") {
    throw new ResourceError(
      "A read target is required.",
      "Pass a path, a directory, or a resource URL."
    );
  }

  if (router.canHandle(trimmed)) {
    const resource = await router.resolve(trimmed, context);
    const bounded = await boundOutput(
      resource.content,
      resource.content,
      resource.url,
      options
    );

    return {
      kind: resource.isDirectory === true ? "directory" : "resource",
      target: resource.url,
      text: bounded.text,
      truncation: bounded.truncation,
    };
  }

  const { path: pathPart, sel } = splitPathAndSel(trimmed);
  const absolutePath = resolveReadPath(pathPart, context.cwd);

  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(absolutePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ResourceError(`Cannot read ${pathPart}: ${message}`, {
      cause: error,
      hint: "Check the path, or read the containing directory to see what exists.",
    });
  }

  if (info.isDirectory()) {
    if (sel !== undefined) {
      throw new ResourceError(
        `A selector cannot be applied to a directory: ${trimmed}`,
        "Read the directory first, then read a file inside it."
      );
    }
    return {
      kind: "directory",
      target: absolutePath,
      text: await readDirectory(absolutePath, DIRECTORY_MAX_DEPTH),
    };
  }

  if (!info.isFile()) {
    throw new ResourceError(
      `Not a regular file or directory: ${pathPart}`,
      "Read the containing directory to see what exists."
    );
  }

  return await readFileTarget(absolutePath, sel, options);
}

export {
  DEFAULT_MAX_INLINE_BYTES,
  DEFAULT_MAX_INLINE_LINES,
  DIRECTORY_CHILD_LIMIT,
  DIRECTORY_MAX_DEPTH,
};
