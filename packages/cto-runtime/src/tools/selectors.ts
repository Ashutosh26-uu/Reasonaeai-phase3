/**
 * The read-tool selector grammar.
 *
 * A read target is a path followed by an optional selector, and a selector is a
 * colon-separated chain of parts. Every part is either a line-range list
 * (`50`, `50-100`, `301-`, `50+10`), the `raw` flag, or the `conflicts` flag, so
 * `src/app.ts:50-60`, `src/app.ts:raw`, `src/app.ts:2-4:raw`, and
 * `src/app.ts:960-973,5-16` are all valid. The chain is order-insensitive
 * except that later ranges replace earlier ones.
 *
 * Ranges are 1-indexed and inclusive on both ends. `endLine` is `undefined`
 * only for an open-ended range, so a single line `50` is `{start: 50, end: 50}`
 * and `50-` is `{start: 50, end: undefined}`. That distinction matters: the
 * first names one line, the second names a line through end of file.
 */

/** An inclusive, 1-indexed line range. `endLine === undefined` means "to end of file". */
export interface LineRange {
  readonly endLine: number | undefined;
  readonly startLine: number;
}

/** Raised for a selector or path argument that cannot be interpreted. */
export class SelectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelectorError";
  }
}

/**
 * A single range chunk: `N`, `N-M`, `N+K`, or open-ended `N-`.
 *
 * `..` is accepted anywhere `-` is, as a forgiving alias for Python- and
 * Rust-style ranges, so `2724..2727` means `2724-2727` and `2724..` means
 * `2724-`. A leading `L` is also accepted, because models frequently copy the
 * `L` from a line-numbered gutter.
 */
const RANGE_CHUNK_SRC = String.raw`L?\d+(?:(?:[-+]|\.\.)L?\d+|-|\.\.)?`;
const RANGE_LIST_SRC = `${RANGE_CHUNK_SRC}(?:,${RANGE_CHUNK_SRC})*`;

/** A complete selector: a range list, a `-N` tail count, `raw`, or `conflicts`. */
const SELECTOR_RE = new RegExp(
  `^(?:${RANGE_LIST_SRC}|-\\d+|raw|conflicts)$`,
  "i"
);
/** A selector that is only a range list, so it yields line ranges. */
const RANGE_LIST_ONLY_RE = new RegExp(`^${RANGE_LIST_SRC}$`, "i");
/** A selector that is only the `raw` flag. */
const RAW_ONLY_RE = /^raw$/i;
/** A selector that is only the `conflicts` flag. */
const CONFLICTS_ONLY_RE = /^conflicts$/i;

const LINE_RANGE_CHUNK_RE = /^L?(\d+)(?:(\.\.|[-+])L?(\d+)?)?$/i;

/**
 * A tail selector: `-N`, meaning the last N lines.
 *
 * Kept separate from the range grammar because it names a count rather than a
 * position, and it resolves against a length only known once the file is read.
 * Without this, `:-60` would match no range at all and a read would silently
 * return the whole file instead of the tail the caller asked for.
 */
const TAIL_CHUNK_RE = /^-(\d+)$/;

const ASCII_DRIVE_LETTER_RE = /^[A-Za-z]$/;

/**
 * Parse one range chunk.
 *
 * Returns `null` when the chunk is not a range at all, so callers can
 * distinguish "this is not a range" from "this is a range with invalid bounds".
 * The latter throws, because silently ignoring `50-10` would read a range the
 * caller did not ask for.
 */
export function parseLineRangeChunk(sel: string): LineRange | null {
  const match: RegExpExecArray | null = LINE_RANGE_CHUNK_RE.exec(sel.trim());
  if (match === null) {
    return null;
  }

  const [, startText = "", separator, endText] = match;
  const startLine = Number.parseInt(startText, 10);

  if (startLine < 1) {
    throw new SelectorError(
      `Invalid line selector "${sel}": line numbers are 1-indexed, so 0 is not a line.`
    );
  }

  if (separator === undefined) {
    return { endLine: startLine, startLine };
  }

  // `N-` and `N..` are open-ended: read from N to the end of the file.
  if (endText === undefined) {
    return { endLine: undefined, startLine };
  }

  const endLine = Number.parseInt(endText, 10);

  if (separator === "+") {
    // `N+K` is a window of K lines starting at N, so it is inclusive of N.
    return { endLine: startLine + endLine - 1, startLine };
  }

  if (endLine < startLine) {
    throw new SelectorError(
      `Invalid line selector "${sel}": the end line ${endLine} precedes the start line ${startLine}.`
    );
  }

  return { endLine, startLine };
}

/**
 * Parse a comma-separated range list.
 *
 * Ranges come back ascending with overlapping and adjacent ranges merged, so a
 * consumer can stream the file in one forward pass per range. Returns `null`
 * when the text is not a range list.
 */
export function parseLineRanges(
  sel: string
): [LineRange, ...LineRange[]] | null {
  const trimmed = sel.trim();
  if (trimmed === "") {
    return null;
  }

  const chunks = trimmed.split(",");
  const parsed: LineRange[] = [];

  for (const chunk of chunks) {
    const range = parseLineRangeChunk(chunk);
    if (range === null) {
      return null;
    }
    parsed.push(range);
  }

  if (parsed.length === 0) {
    return null;
  }

  const sorted = [...parsed].sort((a, b) => a.startLine - b.startLine);
  const merged: LineRange[] = [];

  for (const range of sorted) {
    const previous = merged.at(-1);

    if (previous === undefined) {
      merged.push(range);
      continue;
    }

    // An open-ended previous range already covers every later start.
    if (previous.endLine === undefined) {
      continue;
    }

    // Merge when this range starts at or before the line after the previous
    // range's end, which folds both overlap and adjacency into one case.
    if (range.startLine <= previous.endLine + 1) {
      merged[merged.length - 1] = {
        endLine:
          range.endLine === undefined
            ? undefined
            : Math.max(previous.endLine, range.endLine),
        startLine: previous.startLine,
      };
      continue;
    }

    merged.push(range);
  }

  const [first, ...rest] = merged;
  if (first === undefined) {
    return null;
  }

  return [first, ...rest];
}

/**
 * Split a selector chain into its parts.
 *
 * Each part must independently be a valid selector, so `1-5:raw` yields
 * `["1-5", "raw"]` while `weird:thing` yields nothing and is left to be treated
 * as part of the path.
 */
export function splitSelectorChain(sel: string): string[] | null {
  const parts = sel.split(":");
  if (parts.length === 0) {
    return null;
  }

  for (const part of parts) {
    if (!SELECTOR_RE.test(part)) {
      return null;
    }
  }

  return parts;
}

/** The line ranges named by a selector chain, or `undefined` when it names none. */
export function selectorLineRanges(
  sel: string | undefined
): [LineRange, ...LineRange[]] | undefined {
  if (sel === undefined) {
    return undefined;
  }

  for (const part of sel.split(":")) {
    if (RANGE_LIST_ONLY_RE.test(part)) {
      const ranges = parseLineRanges(part);
      if (ranges !== null) {
        return ranges;
      }
    }
  }

  return undefined;
}

/** The number of trailing lines a `-N` selector names, or `undefined`. */
export function selectorTailCount(sel: string | undefined): number | undefined {
  if (sel === undefined) {
    return undefined;
  }

  for (const part of sel.split(":")) {
    const match: RegExpExecArray | null = TAIL_CHUNK_RE.exec(part);
    if (match !== null) {
      const count = Number.parseInt(match[1] as string, 10);
      if (count > 0) {
        return count;
      }
    }
  }

  return undefined;
}

/** True when the selector chain carries the `raw` flag. */
export function selectorIsRaw(sel: string | undefined): boolean {
  return sel?.split(":").some((part) => RAW_ONLY_RE.test(part)) ?? false;
}

/** True when the selector chain carries the `conflicts` flag. */
export function selectorIsConflicts(sel: string | undefined): boolean {
  return sel?.split(":").some((part) => CONFLICTS_ONLY_RE.test(part)) ?? false;
}

/** True when the 1-indexed line number falls inside any of the ranges. */
export function isLineInRanges(
  lineNumber: number,
  ranges: readonly LineRange[]
): boolean {
  for (const range of ranges) {
    if (lineNumber < range.startLine) {
      continue;
    }
    if (range.endLine === undefined || lineNumber <= range.endLine) {
      return true;
    }
  }
  return false;
}

/**
 * Split a raw read target into its path and selector.
 *
 * Peels trailing `:part` segments that are individually valid selectors. A
 * Windows drive letter is never treated as a selector: `C:\src\app.ts` keeps
 * its `C:` because the `C` is a single ASCII letter and no range chunk starts
 * that way.
 */
export function splitPathAndSel(rawPath: string): {
  path: string;
  sel: string | undefined;
} {
  const trimmed = rawPath.trim();

  let candidate = trimmed;
  const peeled: string[] = [];

  for (;;) {
    const colonIndex = candidate.lastIndexOf(":");
    if (colonIndex <= 0) {
      break;
    }

    const part = candidate.slice(colonIndex + 1);

    // A bare drive letter is a path root, not a selector. `C:` and `C:\x` both
    // keep their colon.
    if (
      part.length === 0 ||
      (ASCII_DRIVE_LETTER_RE.test(part) &&
        isDrivePosition(candidate, colonIndex))
    ) {
      break;
    }

    if (!SELECTOR_RE.test(part)) {
      break;
    }

    peeled.unshift(part);
    candidate = candidate.slice(0, colonIndex);
  }

  if (peeled.length === 0) {
    return { path: trimmed, sel: undefined };
  }

  return { path: candidate, sel: peeled.join(":") };
}

/** True when the colon at `index` terminates a Windows drive prefix. */
function isDrivePosition(candidate: string, index: number): boolean {
  if (index !== 1) {
    return false;
  }
  const next = candidate[index + 1];
  return next === "\\" || next === "/" || next === undefined;
}
