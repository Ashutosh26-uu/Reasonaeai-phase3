// SPDX-License-Identifier: MIT
// Ported from spectra (MIT, the project owner's own codebase) —
// packages/code/src/tools/hashline/apply.ts.

/**
 * Apply a parsed list of {@link Edit}s to a text body and return the
 * post-edit lines plus any diagnostic warnings. Pure function: no FS, no
 * mutation of the input.
 *
 * Replacement groups are first normalized by `repairReplacementBoundaries`,
 * which absorbs common model mistakes where a payload restates unchanged range
 * boundaries or duplicates/drops structural closers.
 */

import {
  afterInsertLandingShiftWarning,
  blockInsertLandingShiftWarning,
  UNRESOLVED_BLOCK_INTERNAL,
} from "./messages.js";
import { cloneCursor } from "./tokenizer.js";
import type { Anchor, ApplyResult, Cursor, Edit } from "./types.js";

type LineOrigin = "original" | "insert" | "replacement";

type InsertEdit = Extract<Edit, { kind: "insert" }>;
type DeleteEdit = Extract<Edit, { kind: "delete" }>;
type AppliedEdit = InsertEdit | DeleteEdit;

interface IndexedEdit {
  edit: AppliedEdit;
  idx: number;
}

function isReplacementInsert(
  edit: Edit
): edit is InsertEdit & { mode: "replacement" } {
  return edit.kind === "insert" && edit.mode === "replacement";
}

/** Narrowing filter so indexed lookups with `noUncheckedIndexedAccess` stay typed. */
function isDefinedEdit(edit: AppliedEdit | undefined): edit is AppliedEdit {
  return edit !== undefined;
}

function getCursorAnchors(cursor: Cursor): Anchor[] {
  return cursor.kind === "before_anchor" || cursor.kind === "after_anchor"
    ? [cursor.anchor]
    : [];
}

function getEditAnchors(edit: AppliedEdit): Anchor[] {
  if (edit.kind === "delete") {
    return [edit.anchor];
  }
  return getCursorAnchors(edit.cursor);
}

function trailingPhantomLine(fileLines: readonly string[]): number {
  // `split("\n")` on a newline-terminated file yields a trailing "" sentinel.
  // It is addressable for inserts (append-past-end), but it is not real
  // content. Deleting it only strips the file's final newline, so ignore delete
  // edits that land there; inclusive ranges ending at EOF then do the intended
  // thing and delete through the last concrete line.
  return fileLines.length > 1 && fileLines.at(-1) === "" ? fileLines.length : 0;
}

function dropTrailingPhantomDeletes(
  edits: AppliedEdit[],
  fileLines: readonly string[]
): AppliedEdit[] {
  const phantomLine = trailingPhantomLine(fileLines);
  if (phantomLine === 0) {
    return edits;
  }
  return edits.filter(
    (edit) => edit.kind !== "delete" || edit.anchor.line !== phantomLine
  );
}

/**
 * Verify every anchored edit points at an existing line. File-version binding is
 * checked once per section via the header hash before this function runs.
 */
function validateLineBounds(
  edits: readonly AppliedEdit[],
  fileLines: readonly string[]
): void {
  for (const edit of edits) {
    for (const anchor of getEditAnchors(edit)) {
      if (anchor.line < 1 || anchor.line > fileLines.length) {
        throw new Error(
          `Line ${anchor.line} does not exist (file has ${fileLines.length} lines)`
        );
      }
    }
  }
}

function cloneAppliedEdit(edit: AppliedEdit, index: number): AppliedEdit {
  if (edit.kind === "delete") {
    return { ...edit, anchor: { ...edit.anchor }, index };
  }
  return { ...edit, cursor: cloneCursor(edit.cursor), index };
}

function insertAtStart(
  fileLines: string[],
  lineOrigins: LineOrigin[],
  lines: string[]
): void {
  if (lines.length === 0) {
    return;
  }
  const origins = lines.map((): LineOrigin => "insert");
  if (fileLines.length === 1 && fileLines[0] === "") {
    fileLines.splice(0, 1, ...lines);
    lineOrigins.splice(0, 1, ...origins);
    return;
  }
  fileLines.splice(0, 0, ...lines);
  lineOrigins.splice(0, 0, ...origins);
}

function insertAtEnd(
  fileLines: string[],
  lineOrigins: LineOrigin[],
  lines: string[]
): number | undefined {
  if (lines.length === 0) {
    return undefined;
  }
  const origins = lines.map((): LineOrigin => "insert");
  if (fileLines.length === 1 && fileLines[0] === "") {
    fileLines.splice(0, 1, ...lines);
    lineOrigins.splice(0, 1, ...origins);
    return 1;
  }
  const hasTrailingNewline = fileLines.at(-1) === "";
  const insertIndex = hasTrailingNewline
    ? fileLines.length - 1
    : fileLines.length;
  fileLines.splice(insertIndex, 0, ...lines);
  lineOrigins.splice(insertIndex, 0, ...origins);
  return insertIndex + 1;
}

function bucketAnchorEditsByLine(
  edits: IndexedEdit[]
): Map<number, IndexedEdit[]> {
  const byLine = new Map<number, IndexedEdit[]>();
  for (const entry of edits) {
    let line = 0;
    if (entry.edit.kind === "delete") {
      ({ line } = entry.edit.anchor);
    } else if (
      entry.edit.cursor.kind === "before_anchor" ||
      entry.edit.cursor.kind === "after_anchor"
    ) {
      ({ line } = entry.edit.cursor.anchor);
    }
    const bucket = byLine.get(line);
    if (bucket) {
      bucket.push(entry);
    } else {
      byLine.set(line, [entry]);
    }
  }
  return byLine;
}

// ═══════════════════════════════════════════════════════════════════════════
// Replacement-boundary repair
//
// Models routinely miscount a replacement range's edges. Sometimes the payload
// re-states unchanged lines that still live on both sides of the range
// (duplicating a function header and final statement); sometimes it only
// re-states or omits a structural closer, which leaves delimiter balance broken.
//
// A balance-neutral boundary-echo repair fires only when both the leading and
// trailing payload edges are exact copies of the surviving lines outside the
// range. One-sided content echoes are left alone unless delimiter-balance repair
// proves they are duplicated structural boundaries. This preserves intended
// duplicate statements while absorbing the common "body includes the unchanged
// wrapper" mistake.

/** A line that is nothing but closing delimiters: `}`, `)`, `];`, `})`, `},`. */
export const STRUCTURAL_CLOSER_RE = /^\s*[)\]}]+[;,]?\s*$/;

/** A JSX/XML closing boundary that carries structure but no bracket tokens. */
const JSX_CLOSER_RE = /^\s*(?:<\/>|<\/[A-Za-z][\w.:-]*>|\/>)\s*[;,]?\s*$/;
const JSX_NAMED_CLOSER_RE = /^\s*<\/([A-Za-z][\w.:-]*)>\s*[;,]?\s*$/;
const JSX_FRAGMENT_CLOSER_RE = /^\s*<\/>\s*[;,]?\s*$/;
const JSX_NAME_CHAR_RE = /[\w.:-]/;
const JSX_SELF_CLOSING_RE = /\/>\s*$/;

function isStructuralCloserLine(text: string): boolean {
  return STRUCTURAL_CLOSER_RE.test(text) || JSX_CLOSER_RE.test(text);
}

function jsxCloserName(text: string): string | undefined {
  if (JSX_FRAGMENT_CLOSER_RE.test(text)) {
    return "";
  }
  const match: RegExpExecArray | null = JSX_NAMED_CLOSER_RE.exec(text);
  return match?.[1];
}

interface JsxPayloadTag {
  readonly closing: boolean;
  readonly name: string;
  readonly selfClosing: boolean;
}

function isJsxTagStart(text: string, index: number): boolean {
  const next = text[index + 1];
  if (next === undefined) {
    return false;
  }
  return (
    next === ">" ||
    next === "/" ||
    (next >= "A" && next <= "Z") ||
    (next >= "a" && next <= "z")
  );
}

/**
 * Index just past the closing quote of a quoted literal, scanning from `from`
 * and honoring backslash escapes. `-1` when it never closes before end of text.
 */
function findQuoteEnd(text: string, from: number, quote: string): number {
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") {
      i += 1;
    } else if (ch === quote) {
      return i + 1;
    }
  }
  return -1;
}

function findJsxTagEnd(text: string, start: number): number {
  let braces = 0;
  for (let i = start + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const afterQuote = findQuoteEnd(text, i + 1, ch);
      if (afterQuote === -1) {
        return -1;
      }
      i = afterQuote - 1;
      continue;
    }
    if (ch === "{") {
      braces += 1;
    } else if (ch === "}" && braces > 0) {
      braces -= 1;
    } else if (ch === ">" && braces === 0) {
      return i;
    }
  }
  return -1;
}

function parseJsxPayloadTag(raw: string): JsxPayloadTag | undefined {
  if (raw === "<>") {
    return { closing: false, name: "", selfClosing: false };
  }
  if (raw === "</>") {
    return { closing: true, name: "", selfClosing: false };
  }
  const closing = raw.startsWith("</");
  const nameStart = closing ? 2 : 1;
  let nameEnd = nameStart;
  while (nameEnd < raw.length) {
    const ch = raw[nameEnd] ?? "";
    if (!JSX_NAME_CHAR_RE.test(ch)) {
      break;
    }
    nameEnd += 1;
  }
  if (nameEnd === nameStart) {
    return undefined;
  }
  return {
    closing,
    name: raw.slice(nameStart, nameEnd),
    selfClosing: !closing && JSX_SELF_CLOSING_RE.test(raw),
  };
}

function readJsxPayloadTags(text: string): JsxPayloadTag[] {
  const tags: JsxPayloadTag[] = [];
  for (
    let start = text.indexOf("<");
    start >= 0;
    start = text.indexOf("<", start + 1)
  ) {
    if (!isJsxTagStart(text, start)) {
      continue;
    }
    const end = findJsxTagEnd(text, start);
    if (end < 0) {
      break;
    }
    const tag = parseJsxPayloadTag(text.slice(start, end + 1));
    if (tag) {
      tags.push(tag);
    }
    start = end;
  }
  return tags;
}

function payloadHasJsxOpenerForEcho(
  payloadPrefix: readonly string[],
  echoLines: readonly string[]
): boolean {
  const openTags: string[] = [];
  for (const tag of readJsxPayloadTags(payloadPrefix.join("\n"))) {
    if (tag.closing) {
      if (openTags.at(-1) === tag.name) {
        openTags.pop();
      }
    } else if (!tag.selfClosing) {
      openTags.push(tag.name);
    }
  }
  for (const line of echoLines) {
    const name = jsxCloserName(line);
    if (name !== undefined && openTags.includes(name)) {
      return true;
    }
  }
  return false;
}

interface DelimiterBalance {
  brace: number;
  bracket: number;
  paren: number;
}

/** Mutable cursor carried across the lines of a delimiter scan. */
interface DelimiterScanState {
  balance: DelimiterBalance;
  inBlockComment: boolean;
  quote: string;
}

/** Apply one character's +/-1 to the running balance; non-delimiters are ignored. */
function applyDelimiterDelta(
  ch: string | undefined,
  balance: DelimiterBalance
): void {
  if (ch === "(") {
    balance.paren += 1;
  } else if (ch === ")") {
    balance.paren -= 1;
  } else if (ch === "[") {
    balance.bracket += 1;
  } else if (ch === "]") {
    balance.bracket -= 1;
  } else if (ch === "{") {
    balance.brace += 1;
  } else if (ch === "}") {
    balance.brace -= 1;
  }
}

/** Index after a block comment's closing marker, or `-1` when it stays open. */
function findBlockCommentEnd(line: string, from: number): number {
  for (let i = from; i < line.length; i += 1) {
    if (line[i] === "*" && line[i + 1] === "/") {
      return i + 2;
    }
  }
  return -1;
}

/**
 * Advance `state` across one line: block comments, string/template literals, line
 * comments, and the delimiter deltas outside them.
 */
function scanDelimiterLine(line: string, state: DelimiterScanState): void {
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (state.inBlockComment) {
      const end = findBlockCommentEnd(line, i);
      if (end === -1) {
        return;
      }
      state.inBlockComment = false;
      i = end - 1;
      continue;
    }
    if (state.quote !== "") {
      const end = findQuoteEnd(line, i, state.quote);
      if (end === -1) {
        return;
      }
      state.quote = "";
      i = end - 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      state.quote = ch;
      continue;
    }
    if (ch === "/" && line[i + 1] === "/") {
      break;
    }
    if (ch === "/" && line[i + 1] === "*") {
      state.inBlockComment = true;
      i += 1;
      continue;
    }
    applyDelimiterDelta(ch, state.balance);
  }
}

/**
 * Net `()` / `[]` / `{}` delta across `lines`, skipping delimiters inside line
 * comments (`//`), block comments, and string/template literals. Block-comment
 * and backtick-template state carry across lines; `"` / `'` reset at EOL since
 * they cannot span lines. Deliberately language-light: constructs it cannot
 * classify (e.g. regex literals) are counted naively, which can only suppress a
 * repair (the safe direction), never force one.
 */
function computeDelimiterBalance(lines: readonly string[]): DelimiterBalance {
  const state: DelimiterScanState = {
    balance: { brace: 0, bracket: 0, paren: 0 },
    inBlockComment: false,
    quote: "",
  };
  for (const line of lines) {
    scanDelimiterLine(line, state);
    // `"` / `'` cannot span lines; only backtick templates and block comments do.
    if (state.quote === '"' || state.quote === "'") {
      state.quote = "";
    }
  }
  return state.balance;
}

function balanceDelta(
  a: DelimiterBalance,
  b: DelimiterBalance
): DelimiterBalance {
  return {
    brace: a.brace - b.brace,
    bracket: a.bracket - b.bracket,
    paren: a.paren - b.paren,
  };
}

function balanceNegate(a: DelimiterBalance): DelimiterBalance {
  return { brace: -a.brace, bracket: -a.bracket, paren: -a.paren };
}

function balanceEqual(a: DelimiterBalance, b: DelimiterBalance): boolean {
  return a.paren === b.paren && a.bracket === b.bracket && a.brace === b.brace;
}

function balanceIsZero(a: DelimiterBalance): boolean {
  return a.paren === 0 && a.bracket === 0 && a.brace === 0;
}

function balanceSum(
  a: DelimiterBalance,
  b: DelimiterBalance
): DelimiterBalance {
  return {
    brace: a.brace + b.brace,
    bracket: a.bracket + b.bracket,
    paren: a.paren + b.paren,
  };
}

function balanceComponentCovers(candidate: number, target: number): boolean {
  if (target === 0) {
    return true;
  }
  return (
    candidate > 0 === target > 0 && Math.abs(candidate) >= Math.abs(target)
  );
}

function balanceCovers(
  candidate: DelimiterBalance,
  target: DelimiterBalance
): boolean {
  return (
    balanceComponentCovers(candidate.paren, target.paren) &&
    balanceComponentCovers(candidate.bracket, target.bracket) &&
    balanceComponentCovers(candidate.brace, target.brace)
  );
}

interface ReplacementGroup {
  /** Positions in the edit array of the range deletes, ascending by line. */
  deleteIndices: number[];
  /** Last deleted line (1-indexed). */
  endLine: number;
  /** Positions in the edit array of the payload inserts, in payload order. */
  insertIndices: number[];
  payload: string[];
  /** First deleted line (1-indexed). */
  startLine: number;
}

/**
 * Detect a replacement group starting at `start`: a run of `before_anchor`
 * replacement inserts sharing one source op line, immediately followed by the
 * contiguous range deletes for that same op. Mirrors how the parser lowers an
 * `replace N.=M:` hunk with a body.
 */
function findReplacementGroup(
  edits: readonly AppliedEdit[],
  start: number
): ReplacementGroup | undefined {
  const first = edits[start];
  if (first === undefined) {
    return undefined;
  }
  if (
    first.kind !== "insert" ||
    first.mode !== "replacement" ||
    first.cursor.kind !== "before_anchor"
  ) {
    return undefined;
  }
  const { lineNum } = first;
  const anchorLine = first.cursor.anchor.line;
  const insertIndices: number[] = [];
  const payload: string[] = [];
  let i = start;
  for (; i < edits.length; i += 1) {
    const edit = edits[i];
    if (edit === undefined) {
      break;
    }
    if (
      edit.kind !== "insert" ||
      edit.mode !== "replacement" ||
      edit.lineNum !== lineNum
    ) {
      break;
    }
    if (
      edit.cursor.kind !== "before_anchor" ||
      edit.cursor.anchor.line !== anchorLine
    ) {
      break;
    }
    insertIndices.push(i);
    payload.push(edit.text);
  }
  const deleteIndices: number[] = [];
  let expectedLine = anchorLine;
  for (; i < edits.length; i += 1) {
    const edit = edits[i];
    if (edit === undefined) {
      break;
    }
    if (
      edit.kind !== "delete" ||
      edit.lineNum !== lineNum ||
      edit.anchor.line !== expectedLine
    ) {
      break;
    }
    deleteIndices.push(i);
    expectedLine += 1;
  }
  if (deleteIndices.length === 0) {
    return undefined;
  }
  return {
    deleteIndices,
    endLine: anchorLine + deleteIndices.length - 1,
    insertIndices,
    payload,
    startLine: anchorLine,
  };
}

/**
 * Largest `k` such that the payload's last `k` lines exactly equal the `k`
 * surviving file lines just below the range AND dropping them zeroes `delta`.
 * Requires a non-zero `delta`: a zero-balance candidate can never account for
 * the imbalance, so intentional duplicates of ordinary statements stay intact,
 * while duplicated structural lines (closers like `});`, openers like `foo(`)
 * are dropped when they exactly explain the imbalance.
 */
function findDuplicateSuffix(
  group: ReplacementGroup,
  fileLines: readonly string[],
  delta: DelimiterBalance
): number {
  if (balanceIsZero(delta)) {
    return 0;
  }
  const { payload, endLine } = group;
  const maxK = Math.min(payload.length, fileLines.length - endLine);
  for (let k = maxK; k >= 1; k -= 1) {
    let matches = true;
    for (let t = 0; t < k; t += 1) {
      if (payload[payload.length - k + t] !== fileLines[endLine + t]) {
        matches = false;
        break;
      }
    }
    if (!matches) {
      continue;
    }
    if (
      balanceEqual(
        computeDelimiterBalance(payload.slice(payload.length - k)),
        delta
      )
    ) {
      return k;
    }
  }
  return 0;
}

/**
 * Largest `j` such that the payload's first `j` lines exactly equal the `j`
 * surviving file lines just above the range AND dropping them zeroes `delta`.
 * Requires a non-zero `delta`; see {@link findDuplicateSuffix}.
 */
function findDuplicatePrefix(
  group: ReplacementGroup,
  fileLines: readonly string[],
  delta: DelimiterBalance
): number {
  if (balanceIsZero(delta)) {
    return 0;
  }
  const { payload, startLine } = group;
  const maxJ = Math.min(payload.length, startLine - 1);
  for (let j = maxJ; j >= 1; j -= 1) {
    let matches = true;
    for (let t = 0; t < j; t += 1) {
      if (payload[t] !== fileLines[startLine - 1 - j + t]) {
        matches = false;
        break;
      }
    }
    if (!matches) {
      continue;
    }
    if (balanceEqual(computeDelimiterBalance(payload.slice(0, j)), delta)) {
      return j;
    }
  }
  return 0;
}

interface DroppedSuffixClosers {
  readonly balance: DelimiterBalance;
  readonly count: number;
  readonly startLine: number;
}

function countPayloadRestatedSuffixHead(
  payload: readonly string[],
  suffixLines: readonly string[]
): number {
  const maxCount = Math.min(payload.length, suffixLines.length);
  for (let count = maxCount; count >= 1; count -= 1) {
    let matches = true;
    for (let offset = 0; offset < count; offset += 1) {
      if (payload[payload.length - count + offset] !== suffixLines[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return count;
    }
  }
  return 0;
}

function countProjectedBelowSuffixTail(
  group: ReplacementGroup,
  fileLines: readonly string[],
  deletedLines: ReadonlySet<number>,
  insertedLineMaps: InsertedLineMaps,
  suffixLines: readonly string[]
): number {
  const below: string[] = [];
  const appendCloserLines = (lines: readonly string[] | undefined): boolean => {
    if (!lines) {
      return true;
    }
    for (const text of lines) {
      if (!STRUCTURAL_CLOSER_RE.test(text)) {
        return false;
      }
      below.push(text);
    }
    return true;
  };
  if (!appendCloserLines(insertedLineMaps.after.get(group.endLine))) {
    return 0;
  }
  for (let line = group.endLine + 1; line <= fileLines.length; line += 1) {
    if (!appendCloserLines(insertedLineMaps.before.get(line))) {
      break;
    }
    if (!deletedLines.has(line)) {
      const text = fileLines[line - 1] ?? "";
      if (!STRUCTURAL_CLOSER_RE.test(text)) {
        break;
      }
      below.push(text);
    }
    if (!appendCloserLines(insertedLineMaps.after.get(line))) {
      break;
    }
  }
  const maxCount = Math.min(below.length, suffixLines.length);
  for (let count = maxCount; count >= 1; count -= 1) {
    let matches = true;
    for (let offset = 0; offset < count; offset += 1) {
      if (below[offset] !== suffixLines[suffixLines.length - count + offset]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return count;
    }
  }
  return 0;
}

interface InsertedLineMaps {
  readonly after: ReadonlyMap<number, readonly string[]>;
  readonly before: ReadonlyMap<number, readonly string[]>;
}

function computeProjectedPrefixBalance(
  group: ReplacementGroup,
  fileLines: readonly string[],
  deletedLines: ReadonlySet<number>,
  insertedByLine: ReadonlyMap<number, readonly string[]>,
  insertedLineMaps: InsertedLineMaps
): DelimiterBalance {
  const prefix: string[] = [];
  for (let line = 1; line < group.startLine; line += 1) {
    const inserted = insertedByLine.get(line);
    if (inserted) {
      prefix.push(...inserted);
    }
    if (!deletedLines.has(line)) {
      prefix.push(fileLines[line - 1] ?? "");
    }
  }
  const insertedAtStart = insertedLineMaps.before.get(group.startLine);
  if (insertedAtStart) {
    prefix.push(...insertedAtStart);
  }
  prefix.push(...group.payload);
  return computeDelimiterBalance(prefix);
}

function prefixCanCoverSuffixClosers(
  group: ReplacementGroup,
  fileLines: readonly string[],
  suffixBalance: DelimiterBalance,
  coveredBelowBalance: DelimiterBalance,
  deletedLines: ReadonlySet<number>,
  insertedByLine: ReadonlyMap<number, readonly string[]>,
  insertedLineMaps: InsertedLineMaps
): boolean {
  const neededOpeners = balanceNegate(suffixBalance);
  const prefixBalance = computeProjectedPrefixBalance(
    group,
    fileLines,
    deletedLines,
    insertedByLine,
    insertedLineMaps
  );
  const uncoveredPrefixBalance = balanceSum(prefixBalance, coveredBelowBalance);
  return balanceCovers(uncoveredPrefixBalance, neededOpeners);
}

/**
 * Missing segment of the range's deleted structural-closer suffix that should
 * be spared. Payload lines that already restate the suffix head are not kept
 * again, and projected closers immediately below the range satisfy the suffix
 * tail. The remaining middle segment is kept only when backed by unmatched
 * openers plus the whole-patch residual.
 */
function findDroppedSuffixClosers(
  group: ReplacementGroup,
  fileLines: readonly string[],
  delta: DelimiterBalance,
  remainingDelta: DelimiterBalance,
  deletedPrefixBalance: DelimiterBalance,
  deletedLines: ReadonlySet<number>,
  insertedByLine: ReadonlyMap<number, readonly string[]>,
  insertedLineMaps: InsertedLineMaps
): DroppedSuffixClosers | undefined {
  let suffixLength = 0;
  while (
    suffixLength < group.deleteIndices.length &&
    STRUCTURAL_CLOSER_RE.test(fileLines[group.endLine - suffixLength - 1] ?? "")
  ) {
    suffixLength += 1;
  }
  if (suffixLength === 0) {
    return undefined;
  }

  const suffixStartLine = group.endLine - suffixLength + 1;
  const suffixLines = fileLines.slice(
    group.endLine - suffixLength,
    group.endLine
  );
  const restatedHead = countPayloadRestatedSuffixHead(
    group.payload,
    suffixLines
  );
  const coveredTail = countProjectedBelowSuffixTail(
    group,
    fileLines,
    deletedLines,
    insertedLineMaps,
    suffixLines
  );
  const keepStart = restatedHead;
  const keepEnd = suffixLength - coveredTail;
  if (keepStart >= keepEnd) {
    return undefined;
  }

  const keptLines = suffixLines.slice(keepStart, keepEnd);
  const keptBalance = computeDelimiterBalance(keptLines);
  const neededOpeners = balanceNegate(keptBalance);
  const coveredBelowBalance = computeDelimiterBalance(
    suffixLines.slice(keepEnd)
  );
  if (!balanceCovers(delta, neededOpeners)) {
    return undefined;
  }
  if (balanceCovers(deletedPrefixBalance, neededOpeners)) {
    return undefined;
  }
  if (!balanceCovers(remainingDelta, neededOpeners)) {
    return undefined;
  }
  if (
    !prefixCanCoverSuffixClosers(
      group,
      fileLines,
      keptBalance,
      coveredBelowBalance,
      deletedLines,
      insertedByLine,
      insertedLineMaps
    )
  ) {
    return undefined;
  }
  return {
    balance: keptBalance,
    count: keepEnd - keepStart,
    startLine: suffixStartLine + keepStart,
  };
}

interface BoundaryEcho {
  leading: number;
  trailing: number;
}

function hasNonWhitespace(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (
      code !== 9 &&
      code !== 10 &&
      code !== 11 &&
      code !== 12 &&
      code !== 13 &&
      code !== 32
    ) {
      return true;
    }
  }
  return false;
}

function countDuplicateLeadingBoundaryLines(
  group: ReplacementGroup,
  fileLines: readonly string[]
): number {
  const { payload, startLine } = group;
  const max = Math.min(payload.length, startLine - 1);
  for (let count = max; count >= 1; count -= 1) {
    let matches = true;
    let hasContent = false;
    for (let offset = 0; offset < count; offset += 1) {
      const line = payload[offset];
      if (line !== fileLines[startLine - 1 - count + offset]) {
        matches = false;
        break;
      }
      hasContent ||= hasNonWhitespace(line ?? "");
    }
    if (matches && hasContent) {
      return count;
    }
  }
  return 0;
}

function countDuplicateTrailingBoundaryLines(
  group: ReplacementGroup,
  fileLines: readonly string[]
): number {
  const { payload, endLine } = group;
  const max = Math.min(payload.length, fileLines.length - endLine);
  for (let count = max; count >= 1; count -= 1) {
    let matches = true;
    let hasContent = false;
    for (let offset = 0; offset < count; offset += 1) {
      const line = payload[payload.length - count + offset];
      if (line !== fileLines[endLine + offset]) {
        matches = false;
        break;
      }
      hasContent ||= hasNonWhitespace(line ?? "");
    }
    if (matches && hasContent) {
      return count;
    }
  }
  return 0;
}

function findBoundaryEcho(
  group: ReplacementGroup,
  fileLines: readonly string[]
): BoundaryEcho | undefined {
  const leadingMax = countDuplicateLeadingBoundaryLines(group, fileLines);
  if (leadingMax === 0) {
    return undefined;
  }
  const trailingMax = countDuplicateTrailingBoundaryLines(group, fileLines);
  if (trailingMax === 0) {
    return undefined;
  }
  // Bail when every payload line could be claimed by a boundary echo: any
  // repair would strip explicit replacement content with no signal that the
  // payload was a mistake rather than an intentional duplication.
  if (leadingMax + trailingMax >= group.payload.length) {
    return undefined;
  }
  // Balance-neutrality guard (see header comment): the dropped echo lines must
  // either be delimiter-neutral on their own or exactly cancel the payload/range
  // balance delta. In brace-heavy code where bare closer lines repeat, an
  // "echo" that shifts delimiter balance is structural content the payload
  // placed intentionally — stripping it would corrupt the result.
  const leadingBalance = computeDelimiterBalance(
    group.payload.slice(0, leadingMax)
  );
  const trailingBalance = computeDelimiterBalance(
    group.payload.slice(group.payload.length - trailingMax)
  );
  const droppedBalance = balanceDelta(
    leadingBalance,
    balanceNegate(trailingBalance)
  );
  if (!balanceIsZero(droppedBalance)) {
    const delta = balanceDelta(
      computeDelimiterBalance(group.payload),
      computeDelimiterBalance(
        fileLines.slice(group.startLine - 1, group.endLine)
      )
    );
    if (!balanceEqual(droppedBalance, delta)) {
      return undefined;
    }
  }
  return { leading: leadingMax, trailing: trailingMax };
}

function describeBoundaryEchoRepair(
  group: ReplacementGroup,
  echo: BoundaryEcho
): string {
  return `Auto-repaired a replacement boundary echo at line ${group.startLine}: dropped ${echo.leading} leading and ${echo.trailing} trailing payload line(s) already present outside the range. Issue the payload as the final desired content for the selected range only — never restate unchanged lines bordering the range.`;
}

function describeBoundaryRepair(
  group: ReplacementGroup,
  action: string
): string {
  return `Auto-repaired a delimiter-balance mismatch in the replacement at line ${group.startLine}: ${action}. Issue the payload as the final desired content only — never restate or omit a closing bracket bordering the range.`;
}

/**
 * A single-sided boundary echo in an otherwise delimiter-balanced *multi-line*
 * replacement: the payload's leading XOR trailing edge exactly restates the
 * surviving line(s) just outside the range — the off-by-one "range one line
 * short of the keeper I retyped" mistake (e.g. att: payload ends with
 * `const x = [];` and line B+1 is the same `const x = [];`). Two-sided echoes
 * are handled by {@link findBoundaryEcho}; delimiter-imbalanced one-sided echoes
 * by {@link findDuplicateSuffix}/{@link findDuplicatePrefix}.
 *
 * Scoped broadly for multi-line ranges (a construct rewrite) because retouched
 * neutral keepers are usually boundary mistakes there. Single-line expansions
 * are riskier — ordinary duplicated statements may be intentional — so they are
 * only repaired when the duplicated edge is a structural closer line that
 * carries no delimiter-balance signal itself, such as a JSX `</section>` close.
 * The dropped lines must keep the already-balanced result balanced, and must
 * not consume the whole payload.
 */
function findOneSidedBoundaryEcho(
  group: ReplacementGroup,
  fileLines: readonly string[]
): { side: "leading" | "trailing"; count: number } | undefined {
  const leading = countDuplicateLeadingBoundaryLines(group, fileLines);
  const trailing = countDuplicateTrailingBoundaryLines(group, fileLines);
  if (leading > 0 === trailing > 0) {
    return undefined;
  }
  const side: "leading" | "trailing" = leading > 0 ? "leading" : "trailing";
  const count = leading > 0 ? leading : trailing;
  if (count >= group.payload.length) {
    return undefined;
  }
  const echoLines =
    side === "leading"
      ? group.payload.slice(0, count)
      : group.payload.slice(group.payload.length - count);
  if (!balanceIsZero(computeDelimiterBalance(echoLines))) {
    return undefined;
  }
  if (group.deleteIndices.length <= 1) {
    if (side !== "trailing" || !echoLines.every(isStructuralCloserLine)) {
      return undefined;
    }
    const payloadPrefix = group.payload.slice(0, group.payload.length - count);
    if (payloadHasJsxOpenerForEcho(payloadPrefix, echoLines)) {
      return undefined;
    }
  }
  return { count, side };
}

function describeOneSidedEchoRepair(
  group: ReplacementGroup,
  side: "leading" | "trailing",
  count: number
): string {
  const where = side === "leading" ? "above" : "below";
  return `Auto-repaired a replacement boundary echo at line ${group.startLine}: dropped ${count} ${side} payload line(s) identical to the surviving line(s) just ${where} the range. The range was one line short of the content you retyped — issue the payload as the final content for the selected range only, and widen the range to consume any keeper you restate.`;
}

/**
 * One pass-1 outcome per source position: resolved edits (with an optional
 * warning) or a deferred missing-closer candidate, resolved against the
 * whole-patch residual in pass 2.
 */
type RepairSlot =
  | { kind: "edits"; edits: AppliedEdit[]; warning?: string }
  | {
      kind: "candidate";
      group: ReplacementGroup;
      inserts: AppliedEdit[];
      deletes: AppliedEdit[];
      delta: DelimiterBalance;
    };

/**
 * Delimiter balance of the lines immediately above a group's range that are
 * themselves deleted by other hunks, netted against any payload inserted at
 * those lines. When this covers the group's own delta the matching opener was
 * deleted (or replaced by an opener of the same shape) just above — a deliberate
 * wrapper removal — so the range's deleted closer must stay deleted, not be
 * "kept". Scanned over its own contiguous lines so quote/comment state never
 * bleeds in from elsewhere in the patch.
 */
function netDeletedPrefixBalance(
  group: ReplacementGroup,
  deletedLines: ReadonlySet<number>,
  insertedByLine: ReadonlyMap<number, readonly string[]>,
  fileLines: readonly string[]
): DelimiterBalance {
  const deleted: string[] = [];
  const inserted: string[] = [];
  for (
    let line = group.startLine - 1;
    line >= 1 && deletedLines.has(line);
    line -= 1
  ) {
    deleted.unshift(fileLines[line - 1] ?? "");
    const insertedAtLine = insertedByLine.get(line);
    if (insertedAtLine) {
      inserted.unshift(...insertedAtLine);
    }
  }
  return balanceDelta(
    computeDelimiterBalance(deleted),
    computeDelimiterBalance(inserted)
  );
}

/**
 * Net delimiter balance a slot contributes, computed over the slot's own
 * contiguous insert/delete lines only. Summing these per-slot deltas — never one
 * concatenated scan across non-adjacent hunks — keeps backtick/block-comment
 * state local, so an unterminated quote in one hunk cannot mask a real delimiter
 * in another.
 */
function slotPatchDelta(
  slot: RepairSlot,
  fileLines: readonly string[]
): DelimiterBalance {
  if (slot.kind === "candidate") {
    return slot.delta;
  }
  const inserted: string[] = [];
  const deleted: string[] = [];
  for (const edit of slot.edits) {
    if (edit.kind === "insert") {
      inserted.push(edit.text);
    } else {
      deleted.push(fileLines[edit.anchor.line - 1] ?? "");
    }
  }
  return balanceDelta(
    computeDelimiterBalance(inserted),
    computeDelimiterBalance(deleted)
  );
}

/**
 * Normalize replacement groups so common off-by-one boundaries do not duplicate
 * unchanged surrounding lines or wrongly drop/keep structural closers. Local
 * repairs run in pass 1; the missing-closer repair is deferred to pass 2 and
 * weighed against the whole-patch delimiter residual, so a closer the range
 * deleted is only kept when the patch as a whole is missing it — never when
 * another hunk already removed the matching opener. Returns the repaired edits
 * plus one warning per repaired group.
 */
function repairReplacementBoundaries(
  edits: readonly AppliedEdit[],
  fileLines: readonly string[]
): {
  edits: AppliedEdit[];
  warnings: string[];
} {
  const slots = buildRepairSlots(edits, fileLines);

  const index = buildProjectionIndex(projectSlotEdits(slots));

  return resolveDeferredSlots(slots, fileLines, index);
}

/** Group → slot, applying every repair whose correctness is local to the group. */
function slotForGroup(
  group: ReplacementGroup,
  edits: readonly AppliedEdit[],
  fileLines: readonly string[]
): RepairSlot {
  const inserts = group.insertIndices
    .map((idx) => edits[idx])
    .filter(isDefinedEdit);
  const deletes = group.deleteIndices
    .map((idx) => edits[idx])
    .filter(isDefinedEdit);

  const boundaryEcho = findBoundaryEcho(group, fileLines);
  if (boundaryEcho) {
    return {
      edits: [
        ...inserts.slice(
          boundaryEcho.leading,
          inserts.length - boundaryEcho.trailing
        ),
        ...deletes,
      ],
      kind: "edits",
      warning: describeBoundaryEchoRepair(group, boundaryEcho),
    };
  }

  const delta = balanceDelta(
    computeDelimiterBalance(group.payload),
    computeDelimiterBalance(fileLines.slice(group.startLine - 1, group.endLine))
  );
  if (balanceIsZero(delta)) {
    const oneSided = findOneSidedBoundaryEcho(group, fileLines);
    if (oneSided) {
      const trimmed =
        oneSided.side === "leading"
          ? inserts.slice(oneSided.count)
          : inserts.slice(0, inserts.length - oneSided.count);
      return {
        edits: [...trimmed, ...deletes],
        kind: "edits",
        warning: describeOneSidedEchoRepair(
          group,
          oneSided.side,
          oneSided.count
        ),
      };
    }
    return { edits: [...inserts, ...deletes], kind: "edits" };
  }

  const dupSuffix = findDuplicateSuffix(group, fileLines, delta);
  if (dupSuffix > 0) {
    return {
      edits: [...inserts.slice(0, inserts.length - dupSuffix), ...deletes],
      kind: "edits",
      warning: describeBoundaryRepair(
        group,
        `dropped ${dupSuffix} duplicated trailing payload line(s) already present below the range`
      ),
    };
  }
  const dupPrefix = findDuplicatePrefix(group, fileLines, delta);
  if (dupPrefix > 0) {
    return {
      edits: [...inserts.slice(dupPrefix), ...deletes],
      kind: "edits",
      warning: describeBoundaryRepair(
        group,
        `dropped ${dupPrefix} duplicated leading payload line(s) already present above the range`
      ),
    };
  }
  return { deletes, delta, group, inserts, kind: "candidate" };
}

/**
 * Pass 1: walk the applied edits, emitting one slot per replacement group (with
 * its local boundary repairs applied) or per lone edit. The missing-closer
 * repair is deferred: it must weigh a group's imbalance against the whole patch,
 * which is only known once the local repairs here have settled.
 */
function buildRepairSlots(
  edits: readonly AppliedEdit[],
  fileLines: readonly string[]
): RepairSlot[] {
  const slots: RepairSlot[] = [];
  let i = 0;
  while (i < edits.length) {
    const group = findReplacementGroup(edits, i);
    if (!group) {
      const single = edits[i];
      if (single !== undefined) {
        slots.push({ edits: [single], kind: "edits" });
      }
      i += 1;
      continue;
    }
    // `findReplacementGroup` guarantees at least one delete index; the fallback
    // only satisfies `noUncheckedIndexedAccess`.
    i = (group.deleteIndices.at(-1) ?? i) + 1;
    slots.push(slotForGroup(group, edits, fileLines));
  }
  return slots;
}

/** Flatten slots into the edit stream the projection index is built from. */
function projectSlotEdits(slots: readonly RepairSlot[]): AppliedEdit[] {
  const projected: AppliedEdit[] = [];
  for (const slot of slots) {
    if (slot.kind === "candidate") {
      projected.push(...slot.inserts, ...slot.deletes);
    } else {
      projected.push(...slot.edits);
    }
  }
  return projected;
}

/** Append `text` to the bucket for `line`, creating the bucket on first use. */
function appendLineText(
  index: Map<number, string[]>,
  line: number,
  text: string
): void {
  const lines = index.get(line);
  if (lines) {
    lines.push(text);
  } else {
    index.set(line, [text]);
  }
}

/** Line-keyed index of the projected edits, read by the deferred repairs. */
interface ProjectionIndex {
  deletedLines: Set<number>;
  insertedByLine: Map<number, string[]>;
  insertedLineMaps: {
    before: Map<number, string[]>;
    after: Map<number, string[]>;
  };
}

/** Index every deleted line and every inserted text in the projection. */
function buildProjectionIndex(
  projected: readonly AppliedEdit[]
): ProjectionIndex {
  const deletedLines = new Set<number>();
  for (const edit of projected) {
    if (edit.kind === "delete") {
      deletedLines.add(edit.anchor.line);
    }
  }
  const insertedByLine = new Map<number, string[]>();
  const insertedLineMaps: {
    before: Map<number, string[]>;
    after: Map<number, string[]>;
  } = {
    after: new Map(),
    before: new Map(),
  };
  for (const edit of projected) {
    if (edit.kind !== "insert") {
      continue;
    }
    for (const anchor of getCursorAnchors(edit.cursor)) {
      appendLineText(insertedByLine, anchor.line, edit.text);
    }
    if (
      edit.cursor.kind === "before_anchor" ||
      edit.cursor.kind === "after_anchor"
    ) {
      const bySide =
        edit.cursor.kind === "before_anchor"
          ? insertedLineMaps.before
          : insertedLineMaps.after;
      appendLineText(bySide, edit.cursor.anchor.line, edit.text);
    }
  }
  return { deletedLines, insertedByLine, insertedLineMaps };
}

/**
 * Pass 2: resolve the deferred missing-closer candidates against the
 * whole-patch delimiter residual, keeping a deleted closer only when the patch
 * as a whole is still missing it.
 */
function resolveDeferredSlots(
  slots: readonly RepairSlot[],
  fileLines: readonly string[],
  index: ProjectionIndex
): { edits: AppliedEdit[]; warnings: string[] } {
  let remainingDelta: DelimiterBalance = { brace: 0, bracket: 0, paren: 0 };
  for (const slot of slots) {
    remainingDelta = balanceSum(
      remainingDelta,
      slotPatchDelta(slot, fileLines)
    );
  }

  const out: AppliedEdit[] = [];
  const warnings: string[] = [];
  for (const slot of slots) {
    if (slot.kind !== "candidate") {
      if (slot.warning !== undefined) {
        warnings.push(slot.warning);
      }
      out.push(...slot.edits);
      continue;
    }
    const deletedPrefixBalance = netDeletedPrefixBalance(
      slot.group,
      index.deletedLines,
      index.insertedByLine,
      fileLines
    );
    const droppedClosers = findDroppedSuffixClosers(
      slot.group,
      fileLines,
      slot.delta,
      remainingDelta,
      deletedPrefixBalance,
      index.deletedLines,
      index.insertedByLine,
      index.insertedLineMaps
    );
    if (droppedClosers) {
      warnings.push(
        describeBoundaryRepair(
          slot.group,
          `kept ${droppedClosers.count} structural closing line(s) the range deleted without restating`
        )
      );
      out.push(
        ...slot.inserts,
        ...slot.deletes.filter(
          (edit) =>
            edit.kind !== "delete" ||
            edit.anchor.line < droppedClosers.startLine ||
            edit.anchor.line >= droppedClosers.startLine + droppedClosers.count
        )
      );
      for (
        let line = droppedClosers.startLine;
        line < droppedClosers.startLine + droppedClosers.count;
        line += 1
      ) {
        index.deletedLines.delete(line);
      }
      remainingDelta = balanceSum(remainingDelta, droppedClosers.balance);
      continue;
    }
    out.push(...slot.inserts, ...slot.deletes);
  }
  return { edits: out, warnings };
}

// ═══════════════════════════════════════════════════════════════════════════
// After-insert landing correction
//
// The body rows of an `insert after N:` hunk carry an implicit depth claim:
// their leading indentation says how deep the author expects the new lines
// to sit. Two corrections share that claim, in opposite directions:
//
// Outward (any after-insert): when the depth is shallower than line N itself,
// the hunk is inserting a sibling of some enclosing construct while anchored
// inside it — the common shape is anchoring on the last statement of a block
// and writing the body at the parent's depth. Sliding the landing point
// forward across the structural closer lines that follow (and nothing else —
// content lines are never crossed) places the body at the depth its
// indentation names.
//
// Inward (block-lowered inserts only): `insert_after_block N:` anchors on the
// resolved block's closing line, but a body indented deeper than that closer
// claims a depth inside the block — the common misreading of the op as
// "append at the end of block N's body". Sliding the landing point backward
// across the block's trailing closer lines places the body inside, at its
// claimed depth. Scoped to block-lowered inserts because there the author
// named the opener and never saw the closer; a plain `insert after M:` on a
// closer line stays literal (the escape hatch for genuinely-after content
// such as method-chain continuations).
//
// Both shifts are deliberately conservative: they fire only when the body
// and anchor indentation are comparable (one is a prefix of the other),
// cross only pure closing-delimiter lines, stop as soon as depth matches the
// body's claim, and are abandoned when any other edit in the patch targets a
// crossed line. Every shift is reported as a warning so the author can
// re-issue when the original landing was intended.

/** Leading run of tabs and spaces. */
function leadingIndent(line: string): string {
  let end = 0;
  while (end < line.length) {
    const code = line.charCodeAt(end);
    if (code !== 9 && code !== 32) {
      break;
    }
    end += 1;
  }
  return line.slice(0, end);
}

/** `deeper` strictly extends `shallower` (same indent style, more depth). */
function isIndentDeeper(deeper: string, shallower: string): boolean {
  return deeper.length > shallower.length && deeper.startsWith(shallower);
}

interface AfterInsertGroup {
  /** Anchor line shared by every insert row of the hunk. */
  anchor: number;
  /** First line of the resolved block when lowered from `insert_after_block N:`. */
  blockStart?: number | undefined;
  /** Indices into the edit list, in patch order. */
  members: number[];
}

/**
 * Depth of an after-insert hunk's body: the shallowest indentation across its
 * non-blank rows. Returns `undefined` when no depth claim can be made — an
 * all-blank or all-closer body, or rows whose indentation styles are not
 * mutually comparable (tabs vs spaces).
 */
function bodyTargetIndent(rows: readonly string[]): string | undefined {
  const nonBlank = rows.filter(hasNonWhitespace);
  if (nonBlank.length === 0) {
    return undefined;
  }
  // A body of pure closers re-balances delimiters; it claims no depth.
  if (nonBlank.every((row) => STRUCTURAL_CLOSER_RE.test(row))) {
    return undefined;
  }
  let target = leadingIndent(nonBlank[0] ?? "");
  for (const row of nonBlank) {
    const indent = leadingIndent(row);
    if (indent.startsWith(target)) {
      continue;
    }
    if (target.startsWith(indent)) {
      target = indent;
    } else {
      return undefined;
    }
  }
  return target;
}

/**
 * Resolve where an after-insert hunk anchored on `group.anchor` should land
 * given its body depth `target`: the last structural closer line in the run
 * directly below the anchor whose indentation still covers `target`. Returns
 * `undefined` when the landing stays put.
 */
function resolveShiftedLanding(
  group: AfterInsertGroup,
  target: string,
  fileLines: readonly string[],
  targetedLines: ReadonlySet<number>
): { line: number; crossed: number } | undefined {
  const anchorText = fileLines[group.anchor - 1];
  if (anchorText === undefined || !hasNonWhitespace(anchorText)) {
    return undefined;
  }
  if (!isIndentDeeper(leadingIndent(anchorText), target)) {
    return undefined;
  }

  let landing = group.anchor;
  let crossed = 0;
  for (let line = group.anchor + 1; line <= fileLines.length; line += 1) {
    const text = fileLines[line - 1] ?? "";
    if (!hasNonWhitespace(text)) {
      continue; // look past blanks, never land on them
    }
    if (!STRUCTURAL_CLOSER_RE.test(text)) {
      break; // content is never crossed
    }
    const indent = leadingIndent(text);
    if (!indent.startsWith(target)) {
      break; // shallower than the body — crossing would over-escape
    }
    if (targetedLines.has(line)) {
      return undefined; // another hunk owns this closer
    }
    landing = line;
    crossed += 1;
    if (indent.length === target.length) {
      break; // depth returned to the body's level
    }
  }
  return landing === group.anchor ? undefined : { crossed, line: landing };
}

/**
 * Resolve where a block-lowered after-insert anchored on the block's closing
 * line should land given a body depth `target` deeper than that closer: just
 * above the block's trailing run of closer lines, bounded below by
 * `blockStart` (an empty block lands the body right after its opener).
 * Returns `undefined` when the landing stays put.
 */
function resolveInwardLanding(
  group: AfterInsertGroup,
  target: string,
  blockStart: number,
  fileLines: readonly string[],
  targetedLines: ReadonlySet<number>
): number | undefined {
  const anchorText = fileLines[group.anchor - 1];
  if (anchorText === undefined || !hasNonWhitespace(anchorText)) {
    return undefined;
  }
  // Fires only when the block ends in a pure closer the body out-indents.
  // Blocks ending in content (indentation-only languages) already land the
  // body inside the block — nothing to correct.
  if (!STRUCTURAL_CLOSER_RE.test(anchorText)) {
    return undefined;
  }
  if (!isIndentDeeper(target, leadingIndent(anchorText))) {
    return undefined;
  }

  let landing = group.anchor;
  for (let line = group.anchor; line > blockStart; line -= 1) {
    const text = fileLines[line - 1] ?? "";
    if (!hasNonWhitespace(text)) {
      landing = line - 1; // look past trailing blanks, never land after one
      continue;
    }
    if (!STRUCTURAL_CLOSER_RE.test(text)) {
      break; // content reached — land right after it
    }
    const indent = leadingIndent(text);
    if (!isIndentDeeper(target, indent)) {
      break; // closer at the body's depth — land after it
    }
    // Another hunk owns this closer (the group's own rows put the anchor
    // itself in `targetedLines`; that one is ours to cross).
    if (line !== group.anchor && targetedLines.has(line)) {
      return undefined;
    }
    landing = line - 1;
  }
  return landing === group.anchor ? undefined : landing;
}

/**
 * Slide mis-anchored after-insert hunks to the depth their body indentation
 * claims: outward past the structural closer lines that follow the anchor
 * when the body is shallower, or — for `insert_after_block N:` lowerings —
 * inward across the block's trailing closers when the body is deeper than
 * the block's closing line. Returns the corrected edit list plus one warning
 * per shifted hunk.
 */
function repairAfterInsertLandings(
  edits: readonly AppliedEdit[],
  fileLines: readonly string[]
): { edits: readonly AppliedEdit[]; warnings: string[] } {
  const groups = groupAfterInserts(edits);
  if (groups.size === 0) {
    return { edits, warnings: [] };
  }
  const targetedLines = collectTargetedLines(edits);

  let out: AppliedEdit[] | undefined;
  const warnings: string[] = [];
  for (const group of groups.values()) {
    const target = bodyTargetIndent(groupRowTexts(edits, group));
    if (target === undefined) {
      continue;
    }
    const outward = resolveShiftedLanding(
      group,
      target,
      fileLines,
      targetedLines
    );
    if (outward !== undefined) {
      out ??= [...edits];
      retargetAfterInsert(out, group, outward.line);
      warnings.push(
        afterInsertLandingShiftWarning(
          group.anchor,
          outward.line,
          outward.crossed
        )
      );
      continue;
    }
    if (group.blockStart === undefined) {
      continue;
    }
    const inward = resolveInwardLanding(
      group,
      target,
      group.blockStart,
      fileLines,
      targetedLines
    );
    if (inward === undefined) {
      continue;
    }
    out ??= [...edits];
    retargetAfterInsert(out, group, inward);
    warnings.push(
      blockInsertLandingShiftWarning(group.blockStart, group.anchor, inward)
    );
  }
  return { edits: out ?? edits, warnings };
}

/**
 * Group plain (non-replacement) after-anchor inserts per authored hunk: rows of
 * one hunk share the anchor line and the patch header line.
 */
function groupAfterInserts(
  edits: readonly AppliedEdit[]
): Map<string, AfterInsertGroup> {
  const groups = new Map<string, AfterInsertGroup>();
  for (let idx = 0; idx < edits.length; idx += 1) {
    const edit = edits[idx];
    if (edit === undefined) {
      continue;
    }
    if (edit.kind !== "insert" || edit.mode === "replacement") {
      continue;
    }
    if (edit.cursor.kind !== "after_anchor") {
      continue;
    }
    const key = `${edit.cursor.anchor.line}:${edit.lineNum}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        anchor: edit.cursor.anchor.line,
        blockStart: edit.blockStart,
        members: [idx],
      });
    } else {
      group.members.push(idx);
    }
  }
  return groups;
}

/** Lines explicitly targeted by any edit; a shift never crosses them. */
function collectTargetedLines(edits: readonly AppliedEdit[]): Set<number> {
  const targetedLines = new Set<number>();
  for (const edit of edits) {
    if (edit.kind === "delete") {
      targetedLines.add(edit.anchor.line);
    } else if (
      edit.cursor.kind === "before_anchor" ||
      edit.cursor.kind === "after_anchor"
    ) {
      targetedLines.add(edit.cursor.anchor.line);
    }
  }
  return targetedLines;
}

/** The body rows of one authored after-insert hunk, in edit order. */
function groupRowTexts(
  edits: readonly AppliedEdit[],
  group: AfterInsertGroup
): string[] {
  const rows: string[] = [];
  for (const idx of group.members) {
    const edit = edits[idx];
    if (edit !== undefined && edit.kind === "insert") {
      rows.push(edit.text);
    }
  }
  return rows;
}

/** Rewrite every member of `group` to land after `line`. */
function retargetAfterInsert(
  out: AppliedEdit[],
  group: AfterInsertGroup,
  line: number
): void {
  for (const idx of group.members) {
    const edit = out[idx];
    if (edit === undefined || edit.kind !== "insert") {
      continue;
    }
    out[idx] = {
      ...edit,
      cursor: { anchor: { line }, kind: "after_anchor" },
    };
  }
}

/**
 * Apply a parsed list of edits to a text body. Pure function — no I/O.
 *
 * Returns the post-edit text and the first changed line number (1-indexed).
 * Throws if an anchor is out of bounds.
 */
export function applyEdits(text: string, edits: readonly Edit[]): ApplyResult {
  if (edits.length === 0) {
    return { firstChangedLine: undefined, text };
  }

  // Block edits are deferred until `resolveBlockEdits` expands them into
  // concrete inserts + deletes. Reaching the applier with one still present
  // is an internal wiring bug, not authored-input error.
  for (const edit of edits) {
    if (edit.kind === "block") {
      throw new Error(UNRESOLVED_BLOCK_INTERNAL);
    }
  }
  // Safe: the guard above proves no `block` variant remains, which TypeScript
  // cannot propagate across an element check on a readonly array.
  const appliedEdits = edits as readonly AppliedEdit[];

  const fileLines = text.split("\n");
  const lineOrigins: LineOrigin[] = fileLines.map(() => "original");

  let firstChangedLine: number | undefined;
  const trackFirstChanged = (line: number) => {
    if (firstChangedLine === undefined || line < firstChangedLine) {
      firstChangedLine = line;
    }
  };

  const targetEdits = dropTrailingPhantomDeletes(
    appliedEdits.map((edit, index) => cloneAppliedEdit(edit, index)),
    fileLines
  );
  validateLineBounds(targetEdits, fileLines);
  const { edits: repaired, warnings: boundaryWarnings } =
    repairReplacementBoundaries(targetEdits, fileLines);
  const { edits: landed, warnings: landingWarnings } =
    repairAfterInsertLandings(repaired, fileLines);
  const warnings = [...boundaryWarnings, ...landingWarnings];

  const { anchorEdits, bofLines, eofLines } = partitionLandings(landed);

  // Apply per-line buckets bottom-up so earlier indices stay valid.
  const byLine = bucketAnchorEditsByLine(anchorEdits);
  for (const line of [...byLine.keys()].sort((a, b) => b - a)) {
    const bucket = byLine.get(line);
    if (!bucket) {
      continue;
    }
    bucket.sort((a, b) => a.idx - b.idx);
    if (
      spliceLineBucket(line, classifyLineEdits(bucket), fileLines, lineOrigins)
    ) {
      trackFirstChanged(line);
    }
  }

  if (bofLines.length > 0) {
    insertAtStart(fileLines, lineOrigins, bofLines);
    trackFirstChanged(1);
  }
  const eofChangedLine = insertAtEnd(fileLines, lineOrigins, eofLines);
  if (eofChangedLine !== undefined) {
    trackFirstChanged(eofChangedLine);
  }

  return {
    firstChangedLine,
    text: fileLines.join("\n"),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** bof/eof text runs plus the anchor-targeted edits, split from the landed stream. */
interface LandingPartition {
  anchorEdits: IndexedEdit[];
  bofLines: string[];
  eofLines: string[];
}

/** Partition edits into bof, eof, and anchor-targeted buckets. */
function partitionLandings(landed: readonly AppliedEdit[]): LandingPartition {
  const bofLines: string[] = [];
  const eofLines: string[] = [];
  const anchorEdits: IndexedEdit[] = [];
  for (let idx = 0; idx < landed.length; idx += 1) {
    const edit = landed[idx];
    if (edit === undefined) {
      continue;
    }
    if (edit.kind === "insert" && edit.cursor.kind === "bof") {
      bofLines.push(edit.text);
    } else if (edit.kind === "insert" && edit.cursor.kind === "eof") {
      eofLines.push(edit.text);
    } else {
      anchorEdits.push({ edit, idx });
    }
  }
  return { anchorEdits, bofLines, eofLines };
}

/** One line's edits, classified by where each lands relative to the line. */
interface LineBucketLines {
  afterInsertLines: string[];
  beforeInsertLines: string[];
  deleteLine: boolean;
  replacementLines: string[];
}

/** Split a line's edits into replacement/before/after inserts and a delete flag. */
function classifyLineEdits(bucket: readonly IndexedEdit[]): LineBucketLines {
  const beforeInsertLines: string[] = [];
  const afterInsertLines: string[] = [];
  const replacementLines: string[] = [];
  let deleteLine = false;
  for (const { edit } of bucket) {
    if (isReplacementInsert(edit)) {
      replacementLines.push(edit.text);
    } else if (edit.kind === "insert" && edit.cursor.kind === "after_anchor") {
      afterInsertLines.push(edit.text);
    } else if (edit.kind === "insert") {
      beforeInsertLines.push(edit.text);
    } else if (edit.kind === "delete") {
      deleteLine = true;
    }
  }
  return { afterInsertLines, beforeInsertLines, deleteLine, replacementLines };
}

/**
 * Splice one line's replacement text and line origins in place. Returns false
 * when the bucket holds no real change.
 */
function spliceLineBucket(
  line: number,
  bucketLines: LineBucketLines,
  fileLines: string[],
  lineOrigins: LineOrigin[]
): boolean {
  const { afterInsertLines, beforeInsertLines, deleteLine, replacementLines } =
    bucketLines;
  if (
    beforeInsertLines.length === 0 &&
    replacementLines.length === 0 &&
    afterInsertLines.length === 0 &&
    !deleteLine
  ) {
    return false;
  }

  const idx = line - 1;
  const currentLine = fileLines[idx] ?? "";
  const replacement = deleteLine
    ? [...beforeInsertLines, ...replacementLines, ...afterInsertLines]
    : [
        ...beforeInsertLines,
        ...replacementLines,
        currentLine,
        ...afterInsertLines,
      ];
  const origins: LineOrigin[] = [];
  for (const _ of beforeInsertLines) {
    origins.push("insert");
  }
  for (const _ of replacementLines) {
    origins.push(deleteLine ? "replacement" : "insert");
  }
  if (!deleteLine) {
    origins.push(lineOrigins[idx] ?? "original");
  }
  for (const _ of afterInsertLines) {
    origins.push("insert");
  }

  fileLines.splice(idx, 1, ...replacement);
  lineOrigins.splice(idx, 1, ...origins);
  return true;
}
