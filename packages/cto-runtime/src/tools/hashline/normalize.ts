// SPDX-License-Identifier: MIT
// Ported from spectra (MIT, the project owner's own codebase) —
// packages/code/src/tools/hashline/normalize.ts.

/**
 * Minimal text-shape normalization: line-ending detection / round-trip and
 * BOM stripping. The patcher uses these to canonicalize text to LF before
 * applying edits and to restore the original shape on write-back.
 */

export type LineEnding = "\r\n" | "\n";

const CRLF_OR_CR_RE = /\r\n?/g;
const LF_RE = /\n/g;
const BOM = "\uFEFF";

/** Detect the first line ending style in `content`. Defaults to LF when neither is present. */
export function detectLineEnding(content: string): LineEnding {
  const crlfIndex = content.indexOf("\r\n");
  const lfIndex = content.indexOf("\n");
  if (lfIndex === -1) {
    return "\n";
  }
  if (crlfIndex === -1) {
    return "\n";
  }
  return crlfIndex < lfIndex ? "\r\n" : "\n";
}

/** Normalize every line ending to LF. */
export function normalizeToLF(text: string): string {
  return text.replace(CRLF_OR_CR_RE, "\n");
}

/** Re-encode LF text with the requested line ending. */
export function restoreLineEndings(text: string, ending: LineEnding): string {
  return ending === "\r\n" ? text.replace(LF_RE, "\r\n") : text;
}

export interface BomResult {
  /** Either the empty string or the BOM sequence (currently UTF-8 BOM). */
  bom: string;
  /** Text with any leading BOM removed. */
  text: string;
}

/** Strip a UTF-8 BOM if present and return both the BOM and the trailing text. */
export function stripBom(content: string): BomResult {
  return content.startsWith(BOM)
    ? { bom: BOM, text: content.slice(1) }
    : { bom: "", text: content };
}
