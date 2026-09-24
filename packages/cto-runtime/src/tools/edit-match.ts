// SPDX-License-Identifier: MIT
// Ported from spectra (MIT, the project owner's own codebase) —
// packages/code/src/tools/edit-match.ts.

/**
 * Whitespace-tolerant find-and-replace matching for the edit tool.
 *
 * The edit tool's oldString parameter can arrive with whitespace that doesn't
 * exactly match the file's bytes — common cases are tabs normalised to spaces
 * and \r\n normalised to \n somewhere in the parameter pipeline. Exact substring
 * matching then fails even though the visible content is identical.
 *
 * The approach runs a pipeline of replacers, each yielding candidate substrings
 * that are guaranteed to exist verbatim in the file. The driver re-locates each
 * candidate in the original content and splices the file's actual bytes — never
 * the caller's oldString — so the file's real indentation and line endings are
 * what get removed.
 */

/** A file's dominant line ending. */
export type LineEnding = "\n" | "\r\n";

/** CRLF (and lone CR) sequences, normalized down to LF. */
const CRLF_RE = /\r\n/g;
const LONE_CR_RE = /\r/g;

/** A backslash escape a model may have left literal in the search string. */
const UNESCAPE_RE = /\\(n|t|r|'|"|`|\\|\n|\$)/g;

/** A run of whitespace, collapsed to a single space. */
const WHITESPACE_RUN_RE = /\s+/g;

/** The separator between the words of a whitespace-normalized search. */
const WHITESPACE_SPLIT_RE = /\s+/;

/** Regex metacharacters, escaped before a search word becomes a pattern. */
const REGEX_META_RE = /[.*+?^${}()|[\]\\]/g;

/** A line's leading whitespace. */
const LEADING_INDENT_RE = /^(\s*)/;

/** Normalize CRLF (and lone CR) down to LF. */
export function normalizeLineEndings(text: string): string {
  return text.replace(CRLF_RE, "\n").replace(LONE_CR_RE, "\n");
}

/** Detect a file's dominant line ending by first occurrence. */
export function detectLineEnding(text: string): LineEnding {
  const crlfIdx = text.indexOf("\r\n");
  const lfIdx = text.indexOf("\n");
  if (lfIdx === -1) {
    return "\n";
  }
  if (crlfIdx === -1) {
    return "\n";
  }
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

/** Convert a (LF-normalised) string to the given line ending. */
export function convertToLineEnding(text: string, ending: LineEnding): string {
  if (ending === "\n") {
    return text;
  }
  return text.replaceAll("\n", "\r\n");
}

export interface MatchResult {
  /** Human-readable reason when ok is false. */
  error?: string;
  /** Byte offset of the matched span in the ORIGINAL file content. */
  index?: number;
  /** Length of the ACTUAL matched span in the file (not the caller's oldString). */
  length?: number;
  /** True when a unique match was located. */
  ok: boolean;
}

/**
 * A replacer yields candidate substrings that are guaranteed to exist verbatim
 * in `content`. Each candidate is re-located by the driver with indexOf so the
 * spliced span is always the file's real bytes.
 */
type Replacer = (
  content: string,
  find: string
) => Generator<string, void, unknown>;

/** A candidate span located by matching a search's first and last line. */
interface BlockCandidate {
  endLine: number;
  startLine: number;
}

/** Similarity threshold for block-anchor matching when only one candidate is found. */
const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.0;
/** Similarity threshold for block-anchor matching when multiple candidates are found. */
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.3;

/** Standard Levenshtein edit distance. */
function levenshtein(a: string, b: string): number {
  if (a === "" || b === "") {
    return Math.max(a.length, b.length);
  }
  // Flat (a.length + 1) x (b.length + 1) distance matrix, row-major.
  const width = b.length + 1;
  const rows = a.length + 1;
  const matrix: number[] = Array.from({ length: rows * width }, () => 0);
  for (let j = 0; j <= b.length; j += 1) {
    matrix[j] = j;
  }
  for (let i = 0; i <= a.length; i += 1) {
    matrix[i * width] = i;
  }

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      // Every index below is in range by construction; the `?? 0` only
      // satisfies the indexed-access check.
      const deletion = (matrix[(i - 1) * width + j] ?? 0) + 1;
      const insertion = (matrix[i * width + (j - 1)] ?? 0) + 1;
      const substitution = (matrix[(i - 1) * width + (j - 1)] ?? 0) + cost;
      matrix[i * width + j] = Math.min(deletion, insertion, substitution);
    }
  }
  return matrix[a.length * width + b.length] ?? 0;
}

/** Sum the byte offset of the start of line `lineIndex` (newline = 1 char). */
function lineStartOffset(lines: readonly string[], lineIndex: number): number {
  let offset = 0;
  for (let k = 0; k < lineIndex; k += 1) {
    offset += (lines[k] ?? "").length + 1;
  }
  return offset;
}

/** Span (start, end) for lines [startLine..endLine] inclusive, joined by \n. */
function lineSpanOffsets(
  lines: readonly string[],
  startLine: number,
  endLine: number
): { end: number; start: number } {
  const start = lineStartOffset(lines, startLine);
  let end = start;
  for (let k = startLine; k <= endLine; k += 1) {
    end += (lines[k] ?? "").length;
    if (k < endLine) {
      end += 1;
    }
  }
  return { end, start };
}

/** Strategy 0: exact substring. Yields the search string back verbatim. */
const SimpleReplacer: Replacer = function* (_content, find) {
  yield find;
};

/**
 * Strategy 1: compare line-by-line by trimmed content. Tolerates tabs-vs-spaces
 * and mixed indentation. Yields the file's actual span (original bytes).
 */
const LineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n");
  const searchLines = find.split("\n");

  if (searchLines.at(-1) === "") {
    searchLines.pop();
  }

  for (let i = 0; i <= originalLines.length - searchLines.length; i += 1) {
    let matches = true;
    for (let j = 0; j < searchLines.length; j += 1) {
      if (
        (originalLines[i + j] ?? "").trim() !== (searchLines[j] ?? "").trim()
      ) {
        matches = false;
        break;
      }
    }

    if (matches) {
      const { end, start } = lineSpanOffsets(
        originalLines,
        i,
        i + searchLines.length - 1
      );
      yield content.slice(start, end);
    }
  }
};

/** Candidate anchor spans where the first and last trimmed lines both match. */
function findBlockCandidates(
  originalLines: readonly string[],
  firstLineSearch: string,
  lastLineSearch: string
): BlockCandidate[] {
  const candidates: BlockCandidate[] = [];
  for (let i = 0; i < originalLines.length; i += 1) {
    if ((originalLines[i] ?? "").trim() !== firstLineSearch) {
      continue;
    }
    for (let j = i + 2; j < originalLines.length; j += 1) {
      if ((originalLines[j] ?? "").trim() === lastLineSearch) {
        candidates.push({ endLine: j, startLine: i });
        break;
      }
    }
  }
  return candidates;
}

/** Mean Levenshtein similarity across a candidate span's middle lines. */
function scoreMiddleLines(
  originalLines: readonly string[],
  searchLines: readonly string[],
  searchBlockSize: number,
  startLine: number,
  endLine: number
): number {
  const actualBlockSize = endLine - startLine + 1;
  const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2);
  if (linesToCheck <= 0) {
    return 1;
  }
  let similarity = 0;
  for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j += 1) {
    const originalLine = (originalLines[startLine + j] ?? "").trim();
    const searchLine = (searchLines[j] ?? "").trim();
    const maxLen = Math.max(originalLine.length, searchLine.length);
    if (maxLen === 0) {
      continue;
    }
    similarity += 1 - levenshtein(originalLine, searchLine) / maxLen;
  }
  return similarity / linesToCheck;
}

/**
 * Similarity for a lone candidate: each middle-line score is pre-divided by the
 * number of lines checked, and the scan stops as soon as the relaxed
 * single-candidate threshold is cleared.
 */
function singleCandidateSimilarity(
  originalLines: readonly string[],
  searchLines: readonly string[],
  searchBlockSize: number,
  startLine: number,
  endLine: number
): number {
  const actualBlockSize = endLine - startLine + 1;
  const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2);
  if (linesToCheck <= 0) {
    return 1;
  }
  let similarity = 0;
  for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j += 1) {
    const originalLine = (originalLines[startLine + j] ?? "").trim();
    const searchLine = (searchLines[j] ?? "").trim();
    const maxLen = Math.max(originalLine.length, searchLine.length);
    if (maxLen === 0) {
      continue;
    }
    similarity +=
      (1 - levenshtein(originalLine, searchLine) / maxLen) / linesToCheck;
    if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
      break;
    }
  }
  return similarity;
}

/**
 * Strategy 2: anchor on the first and last trimmed line, then score middle lines
 * by Levenshtein similarity. Rescues matches where the model garbled inner lines.
 * Only applies to searches of 3+ lines.
 */
const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n");
  const searchLines = find.split("\n");

  if (searchLines.length < 3) {
    return;
  }

  if (searchLines.at(-1) === "") {
    searchLines.pop();
  }

  const firstLineSearch = (searchLines[0] ?? "").trim();
  const lastLineSearch = (searchLines.at(-1) ?? "").trim();
  const searchBlockSize = searchLines.length;
  const candidates = findBlockCandidates(
    originalLines,
    firstLineSearch,
    lastLineSearch
  );

  if (candidates.length === 0) {
    return;
  }

  // Single candidate: relaxed threshold (any non-negative similarity).
  if (candidates.length === 1) {
    const [candidate] = candidates;
    if (candidate === undefined) {
      return;
    }
    const similarity = singleCandidateSimilarity(
      originalLines,
      searchLines,
      searchBlockSize,
      candidate.startLine,
      candidate.endLine
    );
    if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
      const { end, start } = lineSpanOffsets(
        originalLines,
        candidate.startLine,
        candidate.endLine
      );
      yield content.slice(start, end);
    }
    return;
  }

  // Multiple candidates: pick the highest-scoring one if it clears the bar.
  let bestMatch: BlockCandidate | null = null;
  let maxSimilarity = -1;
  for (const candidate of candidates) {
    const similarity = scoreMiddleLines(
      originalLines,
      searchLines,
      searchBlockSize,
      candidate.startLine,
      candidate.endLine
    );
    if (similarity > maxSimilarity) {
      maxSimilarity = similarity;
      bestMatch = candidate;
    }
  }

  if (
    maxSimilarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD &&
    bestMatch !== null
  ) {
    const { end, start } = lineSpanOffsets(
      originalLines,
      bestMatch.startLine,
      bestMatch.endLine
    );
    yield content.slice(start, end);
  }
};

/**
 * `find`'s words joined by flexible whitespace, as a regex; `undefined` when the
 * search has no words or the derived pattern is invalid.
 */
function whitespaceWordPattern(find: string): RegExp | undefined {
  const words = find.trim().split(WHITESPACE_SPLIT_RE);
  if (words.length === 0) {
    return undefined;
  }
  const pattern = words
    .map((word) => word.replace(REGEX_META_RE, "\\$&"))
    .join("\\s+");
  try {
    return new RegExp(pattern);
  } catch {
    // Invalid regex pattern, skip.
    return undefined;
  }
}

/**
 * Strategy 3: collapse all whitespace runs to single spaces, then match. Handles
 * intra-line whitespace differences for single lines and multi-line blocks.
 */
const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const normalizeWhitespace = (text: string): string =>
    text.replace(WHITESPACE_RUN_RE, " ").trim();
  const normalizedFind = normalizeWhitespace(find);

  const lines = content.split("\n");
  for (const line of lines) {
    if (normalizeWhitespace(line) === normalizedFind) {
      yield line;
      continue;
    }
    if (!normalizeWhitespace(line).includes(normalizedFind)) {
      continue;
    }
    const pattern = whitespaceWordPattern(find);
    if (pattern === undefined) {
      continue;
    }
    const matched = line.match(pattern)?.[0];
    if (matched !== undefined) {
      yield matched;
    }
  }

  const findLines = find.split("\n");
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i += 1) {
      const block = lines.slice(i, i + findLines.length).join("\n");
      if (normalizeWhitespace(block) === normalizedFind) {
        yield block;
      }
    }
  }
};

/**
 * Strategy 4: strip the minimum common leading indent from both sides, then match.
 * Lets a search block match regardless of how far it was shifted left or right.
 */
const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const removeIndentation = (text: string): string => {
    const textLines = text.split("\n");
    const nonEmptyLines = textLines.filter((line) => line.trim().length > 0);
    if (nonEmptyLines.length === 0) {
      return text;
    }

    const minIndent = Math.min(
      ...nonEmptyLines.map((line) => {
        const indent = line.match(LEADING_INDENT_RE)?.[1];
        return indent === undefined ? 0 : indent.length;
      })
    );

    return textLines
      .map((line) => (line.trim().length === 0 ? line : line.slice(minIndent)))
      .join("\n");
  };

  const normalizedFind = removeIndentation(find);
  const contentLines = content.split("\n");
  const findLines = find.split("\n");

  for (let i = 0; i <= contentLines.length - findLines.length; i += 1) {
    const block = contentLines.slice(i, i + findLines.length).join("\n");
    if (removeIndentation(block) === normalizedFind) {
      yield block;
    }
  }
};

/**
 * Strategy 5: unescape literal \n / \t / \\ sequences a model may have emitted,
 * then match. Handles the case where escapes weren't interpreted by the pipeline.
 */
const EscapeNormalizedReplacer: Replacer = function* (content, find) {
  const unescapeString = (text: string): string =>
    text.replace(UNESCAPE_RE, (matched, capturedChar: string) => {
      switch (capturedChar) {
        case "n":
          return "\n";
        case "t":
          return "\t";
        case "r":
          return "\r";
        case "'":
          return "'";
        case '"':
          return '"';
        case "`":
          return "`";
        case "\\":
          return "\\";
        case "\n":
          return "\n";
        case "$":
          return "$";
        default:
          return matched;
      }
    });

  const unescapedFind = unescapeString(find);

  if (content.includes(unescapedFind)) {
    yield unescapedFind;
  }

  const lines = content.split("\n");
  const findLines = unescapedFind.split("\n");

  for (let i = 0; i <= lines.length - findLines.length; i += 1) {
    const block = lines.slice(i, i + findLines.length).join("\n");
    if (unescapeString(block) === unescapedFind) {
      yield block;
    }
  }
};

/**
 * Strategy 6: if the search has surrounding whitespace, try matching just the
 * trimmed core, or a file block whose trim() equals the trimmed search.
 */
const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmedFind = find.trim();
  if (trimmedFind === find) {
    return;
  }

  if (content.includes(trimmedFind)) {
    yield trimmedFind;
  }

  const lines = content.split("\n");
  const findLines = find.split("\n");
  for (let i = 0; i <= lines.length - findLines.length; i += 1) {
    const block = lines.slice(i, i + findLines.length).join("\n");
    if (block.trim() === trimmedFind) {
      yield block;
    }
  }
};

/**
 * True when >=50% of a block's non-empty middle lines match the search's when
 * trimmed; a block with no non-empty middle lines counts as a match.
 */
function middleLinesMatch(
  blockLines: readonly string[],
  findLines: readonly string[]
): boolean {
  let matchingLines = 0;
  let totalNonEmptyLines = 0;
  for (let k = 1; k < blockLines.length - 1; k += 1) {
    const blockLine = (blockLines[k] ?? "").trim();
    const searchLine = (findLines[k] ?? "").trim();
    if (blockLine.length > 0 || searchLine.length > 0) {
      totalNonEmptyLines += 1;
      if (blockLine === searchLine) {
        matchingLines += 1;
      }
    }
  }
  return totalNonEmptyLines === 0 || matchingLines / totalNonEmptyLines >= 0.5;
}

/**
 * Strategy 7: anchor on the first and last trimmed line of a 3+ line search,
 * then accept if >=50% of non-empty middle lines match when trimmed.
 */
const ContextAwareReplacer: Replacer = function* (content, find) {
  const findLines = find.split("\n");
  if (findLines.length < 3) {
    return;
  }

  if (findLines.at(-1) === "") {
    findLines.pop();
  }

  const contentLines = content.split("\n");
  const firstLine = (findLines[0] ?? "").trim();
  const lastLine = (findLines.at(-1) ?? "").trim();

  for (let i = 0; i < contentLines.length; i += 1) {
    if ((contentLines[i] ?? "").trim() !== firstLine) {
      continue;
    }

    for (let j = i + 2; j < contentLines.length; j += 1) {
      if ((contentLines[j] ?? "").trim() !== lastLine) {
        continue;
      }
      const blockLines = contentLines.slice(i, j + 1);
      if (
        blockLines.length === findLines.length &&
        middleLinesMatch(blockLines, findLines)
      ) {
        yield blockLines.join("\n");
      }
      break;
    }
  }
};

/** Strategy 8: yields every exact occurrence so the driver can replace them all. */
const MultiOccurrenceReplacer: Replacer = function* (content, find) {
  let startIndex = 0;
  for (;;) {
    const index = content.indexOf(find, startIndex);
    if (index === -1) {
      break;
    }
    yield find;
    startIndex = index + find.length;
  }
};

const REPLACERS: Replacer[] = [
  SimpleReplacer,
  LineTrimmedReplacer,
  BlockAnchorReplacer,
  WhitespaceNormalizedReplacer,
  IndentationFlexibleReplacer,
  EscapeNormalizedReplacer,
  TrimmedBoundaryReplacer,
  ContextAwareReplacer,
  MultiOccurrenceReplacer,
];

/**
 * Locate the byte span of `oldString` in `content` using a tolerant pipeline.
 *
 * The first strategy that yields a UNIQUE candidate wins. If a strategy yields
 * only ambiguous candidates, later strategies are tried. Returns offsets into
 * the ORIGINAL content (never the caller's oldString), so splicing removes the
 * file's actual bytes.
 */
export function findEditMatch(content: string, oldString: string): MatchResult {
  let notFound = true;

  for (const replacer of REPLACERS) {
    for (const search of replacer(content, oldString)) {
      const index = content.indexOf(search);
      if (index === -1) {
        continue;
      }
      notFound = false;
      const lastIndex = content.lastIndexOf(search);
      if (index !== lastIndex) {
        continue;
      }
      return { index, length: search.length, ok: true };
    }
  }

  if (notFound) {
    return {
      error:
        "Could not find the specified text in the file. It must match including whitespace and indentation. Try reading the file first and copying the exact bytes.",
      ok: false,
    };
  }
  return {
    error:
      "Found multiple matches for the specified text. Include more surrounding context to make the match unique.",
    ok: false,
  };
}

/**
 * Convenience: locate the match and return the spliced result.
 *
 * Throws on failure (no match / ambiguous). The caller is expected to normalise
 * line endings on `newString` before calling — or use {@link applyEdit} which
 * does it for you.
 */
export function replaceOnce(
  content: string,
  oldString: string,
  newString: string
): string {
  const match = findEditMatch(content, oldString);
  if (!match.ok || match.index === undefined || match.length === undefined) {
    throw new Error(match.error ?? "edit match failed");
  }
  return (
    content.slice(0, match.index) +
    newString +
    content.slice(match.index + match.length)
  );
}

/**
 * Locate the match, splice the replacement, and preserve the file's line ending
 * in the inserted text. This is the high-level helper the edit tool uses.
 *
 * Returns `{ content: newFileContents, error?: string }`. On failure `content`
 * is undefined and `error` describes why.
 */
export function applyEdit(
  content: string,
  oldString: string,
  newString: string
): { content?: string; error?: string } {
  const ending = detectLineEnding(content);
  const normalizedOld = convertToLineEnding(
    normalizeLineEndings(oldString),
    ending
  );
  const normalizedNew = convertToLineEnding(
    normalizeLineEndings(newString),
    ending
  );

  const match = findEditMatch(content, normalizedOld);
  if (!match.ok || match.index === undefined || match.length === undefined) {
    return match.error === undefined ? {} : { error: match.error };
  }

  const next =
    content.slice(0, match.index) +
    normalizedNew +
    content.slice(match.index + match.length);

  if (next === content) {
    return {
      error: "No changes made - the replacement didn't modify the file.",
    };
  }

  return { content: next };
}
