// SPDX-License-Identifier: MIT
// Ported from spectra (MIT, the project owner's own codebase) —
// packages/code/src/tools/hashline/diff-preview.ts.

/**
 * Re-number a unified diff that uses the `+<lineNum>|content` /
 * `-<lineNum>|content` / ` <lineNum>|content` line format into a compact
 * current-file preview. Removed lines are counted for stats and post-edit
 * offset tracking, but omitted from the preview. Added and context lines are
 * anchored to their post-edit positions so a follow-up edit can reuse visible
 * concrete lines directly. Long contiguous added runs are summarized with a
 * `…` marker instead of echoing every inserted line.
 *
 * This is intentionally decoupled from the diff producer: anything that
 * emits the `<sign><lineNum>|<content>` shape works.
 */
import type { CompactDiffOptions, CompactDiffPreview } from "./types.js";

const DEFAULT_ADDED_RUN_CONTEXT_LINES = 2;

const PREVIEW_ELISION_MARKER = "…";
/** Blank row separating non-contiguous regions of a numbered diff. */
const PREVIEW_GAP_ROW = "";
/**
 * Raw elision markers a producer may emit, all normalized to
 * {@link PREVIEW_ELISION_MARKER}. A `Record` rather than a `Set` because the
 * keys are static literals; membership is an `=== true` lookup.
 */
const RAW_ELISION_MARKERS: Record<string, true> = {
  "...": true,
  [PREVIEW_ELISION_MARKER]: true,
  [`+${PREVIEW_ELISION_MARKER}`]: true,
};

function appendPreviewLine(output: string[], line: string): void {
  const normalized =
    RAW_ELISION_MARKERS[line] === true ? PREVIEW_ELISION_MARKER : line;
  const isSeparator =
    normalized === PREVIEW_ELISION_MARKER || normalized === PREVIEW_GAP_ROW;
  const last = output.at(-1);
  const lastIsSeparator =
    last === PREVIEW_ELISION_MARKER || last === PREVIEW_GAP_ROW;
  // Separators (elision markers, blank gap rows) never stack: omitted
  // removed lines between two separators would otherwise leave them
  // adjacent. A leading separator is dropped outright.
  if (isSeparator && (output.length === 0 || lastIsSeparator)) {
    return;
  }
  output.push(normalized);
}

interface ParsedDiffLine {
  content: string;
  kind: "+" | "-" | " ";
  lineNumber: number;
}

function normalizeAddedRunContext(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_ADDED_RUN_CONTEXT_LINES;
  }
  return Math.max(1, Math.trunc(value));
}

function parseNumberedDiffLine(line: string): ParsedDiffLine | undefined {
  const [kind] = line;
  if (kind !== "+" && kind !== "-" && kind !== " ") {
    return undefined;
  }

  const body = line.slice(1);
  const sep = body.indexOf("|");
  if (sep === -1) {
    return undefined;
  }

  const lineNumber = Number.parseInt(body.slice(0, sep), 10);
  if (!Number.isFinite(lineNumber)) {
    return undefined;
  }

  return { content: body.slice(sep + 1), kind, lineNumber };
}

function appendAddedRun(
  output: string[],
  run: string[],
  edgeLines: number
): void {
  if (run.length === 0) {
    return;
  }

  const collapseThreshold = edgeLines * 2 + 1;
  if (run.length <= collapseThreshold) {
    for (const text of run) {
      appendPreviewLine(output, text);
    }
    return;
  }

  // Both indices are inside the run by construction; the `undefined` guards
  // only satisfy `noUncheckedIndexedAccess`.
  for (let index = 0; index < edgeLines; index += 1) {
    const text = run[index];
    if (text !== undefined) {
      appendPreviewLine(output, text);
    }
  }
  appendPreviewLine(output, PREVIEW_ELISION_MARKER);
  for (let index = run.length - edgeLines; index < run.length; index += 1) {
    const text = run[index];
    if (text !== undefined) {
      appendPreviewLine(output, text);
    }
  }
}

export function buildCompactDiffPreview(
  diff: string,
  options: CompactDiffOptions = {}
): CompactDiffPreview {
  const lines = diff.length === 0 ? [] : diff.split("\n");
  const addedRunContext = normalizeAddedRunContext(
    options.maxAddedRunContext ?? options.maxUnchangedRun
  );
  let addedLines = 0;
  let removedLines = 0;
  const formatted: string[] = [];
  const addedRun: string[] = [];

  const flushAddedRun = (): void => {
    appendAddedRun(formatted, addedRun, addedRunContext);
    addedRun.length = 0;
  };

  // External diff producers number `+` lines with the post-edit line number,
  // `-` lines with the pre-edit line number, and context lines with the
  // pre-edit line number. To emit fresh line numbers usable for follow-up
  // edits, convert context-line numbers to post-edit positions by tracking
  // the running offset (added so far - removed so far) as we walk the diff.
  for (const line of lines) {
    const parsed = parseNumberedDiffLine(line);
    if (!parsed) {
      flushAddedRun();
      appendPreviewLine(formatted, line);
      continue;
    }

    if (parsed.kind === "+") {
      addedLines += 1;
      addedRun.push(`${parsed.lineNumber}:${parsed.content}`);
      continue;
    }
    if (parsed.kind === "-") {
      flushAddedRun();
      removedLines += 1;
      continue;
    }

    // Context line: renumber it onto its post-edit position.
    flushAddedRun();
    const newLineNumber = parsed.lineNumber + addedLines - removedLines;
    appendPreviewLine(formatted, `${newLineNumber}:${parsed.content}`);
  }
  flushAddedRun();

  while (formatted.length > 0) {
    const last = formatted.at(-1);
    if (last !== PREVIEW_ELISION_MARKER && last !== PREVIEW_GAP_ROW) {
      break;
    }
    formatted.pop();
  }

  return { addedLines, preview: formatted.join("\n"), removedLines };
}
