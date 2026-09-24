// SPDX-License-Identifier: MIT
// Ported from spectra (MIT, the project owner's own codebase) —
// packages/code/src/tools/hashline/recovery.ts.

/**
 * Recover from a stale section snapshot tag by replaying the would-be edit
 * against a cached pre-edit snapshot of the file and 3-way-merging the
 * result onto the current on-disk content.
 *
 * The patcher consults this when a section tag resolves to a snapshot that no
 * longer matches the live file content. The recovery class is stateless apart
 * from the {@link SnapshotStore} it queries; the snapshot store is the seam
 * lets you plug in your own caching strategy.
 */
// biome-ignore lint/performance/noNamespaceImport: spectra reads Diff.structuredPatch / Diff.applyPatch / Diff.diffArrays; `diff` is a required dependency of this slice.
import * as Diff from "diff";

import { applyEdits } from "./apply.js";
import {
  RECOVERY_EXTERNAL_WARNING,
  RECOVERY_LINE_REMAP_WARNING,
  RECOVERY_SESSION_CHAIN_WARNING,
  RECOVERY_SESSION_REPLAY_WARNING,
} from "./messages.js";
import type { SnapshotStore } from "./snapshots.js";
import type { Anchor, ApplyResult, Edit } from "./types.js";

// Section tags are line-precise; never let Diff.applyPatch slide a hunk
// onto a duplicate closer 100+ lines away. If snapshot replay does not
// align exactly, refuse and let the caller re-read.
const RECOVERY_FUZZ_FACTOR = 0;

export interface RecoveryArgs {
  currentText: string;
  edits: readonly Edit[];
  fileHash: string;
  path: string;
}

export interface RecoveryResult {
  /** First changed line (1-indexed) relative to the live `currentText`, or `undefined`. */
  firstChangedLine: number | undefined;
  /** Post-recovery text. */
  text: string;
  /** Warnings collected during recovery, including the user-facing recovery banner. */
  warnings: string[];
}

function applyEditsToSnapshot(
  previousText: string,
  currentText: string,
  edits: readonly Edit[],
  recoveryWarning: string
): RecoveryResult | null {
  let applied: ApplyResult;
  try {
    applied = applyEdits(previousText, [...edits]);
  } catch {
    return null;
  }
  if (applied.text === previousText) {
    return null;
  }

  const patch = Diff.structuredPatch(
    "file",
    "file",
    previousText,
    applied.text,
    "",
    "",
    { context: 3 }
  );
  const merged = Diff.applyPatch(currentText, patch, {
    fuzzFactor: RECOVERY_FUZZ_FACTOR,
  });
  if (typeof merged !== "string" || merged === currentText) {
    return null;
  }

  const firstChangedLine =
    findFirstChangedLine(currentText, merged) ?? applied.firstChangedLine;
  const hasNetChange = firstChangedLine !== undefined;
  const warnings = hasNetChange
    ? [recoveryWarning, ...(applied.warnings ?? [])]
    : [...(applied.warnings ?? [])];

  return { firstChangedLine, text: merged, warnings };
}

function collectAnchorLines(edits: readonly Edit[]): number[] {
  const lines: number[] = [];
  for (const edit of edits) {
    for (const anchor of getEditAnchors(edit)) {
      lines.push(anchor.line);
    }
  }
  return lines;
}

function getEditAnchors(edit: Edit): Anchor[] {
  if (edit.kind === "delete") {
    return [edit.anchor];
  }
  // Recovery only ever receives already-resolved edits (no `block`); this arm
  // exists for type-exhaustiveness over the full `Edit` union.
  if (edit.kind === "block") {
    return [edit.anchor];
  }
  const { cursor } = edit;
  if (cursor.kind === "before_anchor" || cursor.kind === "after_anchor") {
    return [cursor.anchor];
  }
  return [];
}

/**
 * Returns true when every anchor line in `edits` has identical content in
 * `previousText` and `currentText`. The session-chain replay fast-path
 * requires this: if the prior in-session edit rewrote the line the model is
 * now re-targeting with a stale hash, replaying onto current would silently
 * overwrite the new content with whatever the model authored against the
 * old content — a corruption window, not a recovery.
 */
function verifyAnchorContent(
  previousText: string,
  currentText: string,
  edits: readonly Edit[]
): boolean {
  const lines = collectAnchorLines(edits);
  if (lines.length === 0) {
    return true;
  }
  const prev = previousText.split("\n");
  const curr = currentText.split("\n");
  for (const line of lines) {
    const idx = line - 1;
    if (idx < 0 || idx >= prev.length || idx >= curr.length) {
      return false;
    }
    if (prev[idx] !== curr[idx]) {
      return false;
    }
  }
  return true;
}

function buildLineMap(
  previousText: string,
  currentText: string
): Map<number, number> {
  const previousLines = previousText.split("\n");
  const currentLines = currentText.split("\n");
  const changes = Diff.diffArrays(previousLines, currentLines);
  const map = new Map<number, number>();
  let previousLine = 1;
  let currentLine = 1;

  for (const change of changes) {
    const count = change.value.length;
    if (change.added) {
      currentLine += count;
      continue;
    }
    if (change.removed) {
      previousLine += count;
      continue;
    }
    for (let offset = 0; offset < count; offset += 1) {
      map.set(previousLine + offset, currentLine + offset);
    }
    previousLine += count;
    currentLine += count;
  }

  return map;
}

/** Values appearing two or more times in `lines`, for O(1) duplicate checks. */
function collectDuplicatedValues(lines: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const value of lines) {
    if (seen.has(value)) {
      duplicated.add(value);
    } else {
      seen.add(value);
    }
  }
  return duplicated;
}

interface AnchorNeighbors {
  /** Nearest non-anchor line above the anchor's run, or `undefined` at the file edge. */
  after: number | undefined;
  /** Nearest non-anchor line below the anchor's run, or `undefined` at the file edge. */
  before: number | undefined;
}

/**
 * Nearest non-anchor context line on each side of every anchor, computed in
 * one sweep over the sorted anchor set. Anchors in one contiguous run share
 * both neighbors (the lines just outside the run), so this replaces the
 * per-anchor directional walk across anchored ranges — O(anchors²) on a
 * large block replacement — with one O(anchors log anchors) pass.
 */
function computeAnchorNeighbors(
  anchorLines: ReadonlySet<number>,
  lineCount: number
): Map<number, AnchorNeighbors> {
  const sorted = [...anchorLines].sort((a, b) => a - b);
  const neighbors = new Map<number, AnchorNeighbors>();
  let index = 0;
  while (index < sorted.length) {
    const start = sorted[index];
    // Unreachable: `index` is below `sorted.length`. The guard only satisfies
    // `noUncheckedIndexedAccess`.
    if (start === undefined) {
      break;
    }
    let end = start;
    let next = index + 1;
    // Stops at the first non-consecutive anchor and at the array end, where
    // the lookup is `undefined`.
    while (sorted[next] === end + 1) {
      end += 1;
      next += 1;
    }
    const before =
      start - 1 >= 1 && start - 1 <= lineCount ? start - 1 : undefined;
    const after = end + 1 <= lineCount ? end + 1 : undefined;
    for (let line = start; line <= end; line += 1) {
      neighbors.set(line, { after, before });
    }
    index = next;
  }
  return neighbors;
}

function validateDuplicateAnchorContext(
  line: number,
  mapped: number,
  neighbors: AnchorNeighbors,
  lineMap: ReadonlyMap<number, number>
): boolean {
  let checked = false;
  const { after, before } = neighbors;
  if (before !== undefined) {
    checked = true;
    if (lineMap.get(before) !== mapped - (line - before)) {
      return false;
    }
  }
  if (after !== undefined) {
    checked = true;
    if (lineMap.get(after) !== mapped + (after - line)) {
      return false;
    }
  }
  return checked;
}

function validateUniqueAnchorContext(
  line: number,
  mapped: number,
  neighbors: AnchorNeighbors,
  lineMap: ReadonlyMap<number, number>
): boolean {
  const offset = mapped - line;
  const { after, before } = neighbors;
  if (after !== undefined) {
    return lineMap.get(after) === after + offset;
  }
  return before !== undefined && lineMap.get(before) === before + offset;
}

function validateRemappedAnchorContext(
  previousText: string,
  currentText: string,
  lineMap: ReadonlyMap<number, number>,
  edits: readonly Edit[]
): boolean {
  const previousLines = previousText.split("\n");
  const currentLines = currentText.split("\n");
  const anchorLines = new Set(collectAnchorLines(edits));
  // Precompute once per validation pass: which line values are duplicated,
  // and each anchor's nearest non-anchor context. The per-anchor forms —
  // indexOf/lastIndexOf full-file scans plus directional walks across
  // anchored ranges — are O(anchors×lines) + O(anchors²) and blow up on
  // large block replacements.
  const duplicatedPrevious = collectDuplicatedValues(previousLines);
  const duplicatedCurrent = collectDuplicatedValues(currentLines);
  const anchorNeighbors = computeAnchorNeighbors(
    anchorLines,
    previousLines.length
  );

  for (const [line, neighbors] of anchorNeighbors) {
    const mapped = lineMap.get(line);
    if (mapped === undefined) {
      return false;
    }
    const previousValue = previousLines[line - 1];
    const currentValue = currentLines[mapped - 1];
    // Unreachable: `lineMap` only holds keys inside both files, so both
    // lookups resolved above. The guard only satisfies
    // `noUncheckedIndexedAccess`.
    if (previousValue === undefined || currentValue === undefined) {
      return false;
    }
    if (
      !(
        duplicatedPrevious.has(previousValue) ||
        duplicatedCurrent.has(currentValue)
      )
    ) {
      if (!validateUniqueAnchorContext(line, mapped, neighbors, lineMap)) {
        return false;
      }
      continue;
    }
    if (!validateDuplicateAnchorContext(line, mapped, neighbors, lineMap)) {
      return false;
    }
  }

  return true;
}

/**
 * Remap one already-resolved edit through the line map, or `null` when an
 * anchor it names has no unchanged counterpart. Split out of
 * {@link remapEditsToCurrent} to keep that driver's branching shallow.
 */
function remapEditToCurrent(
  edit: Edit,
  mapLine: (line: number) => number | null,
  mapAnchor: (anchor: Anchor) => Anchor | null
): Edit | null {
  if (edit.kind === "delete") {
    const anchor = mapAnchor(edit.anchor);
    if (anchor === null) {
      return null;
    }
    return { ...edit, anchor };
  }
  if (edit.kind === "block") {
    const anchor = mapAnchor(edit.anchor);
    if (anchor === null) {
      return null;
    }
    return { ...edit, anchor };
  }

  let { blockStart } = edit;
  if (blockStart !== undefined) {
    const mappedBlockStart = mapLine(blockStart);
    if (mappedBlockStart === null) {
      return null;
    }
    blockStart = mappedBlockStart;
  }
  // `exactOptionalPropertyTypes` forbids re-stating `blockStart: undefined`,
  // so carry it only when it resolved; readers only test it against
  // `undefined`, which the absent key satisfies.
  const carriedBlockStart = blockStart === undefined ? {} : { blockStart };

  const { cursor } = edit;
  if (cursor.kind !== "before_anchor" && cursor.kind !== "after_anchor") {
    return blockStart === edit.blockStart
      ? edit
      : { ...edit, ...carriedBlockStart };
  }

  const anchor = mapAnchor(cursor.anchor);
  if (anchor === null) {
    return null;
  }
  return {
    ...edit,
    ...carriedBlockStart,
    cursor: { anchor, kind: cursor.kind },
  };
}

function remapEditsToCurrent(
  previousText: string,
  currentText: string,
  edits: readonly Edit[]
): Edit[] | null {
  const lineMap = buildLineMap(previousText, currentText);
  if (
    !validateRemappedAnchorContext(previousText, currentText, lineMap, edits)
  ) {
    return null;
  }
  const offsets: number[] = [];

  const mapLine = (line: number): number | null => {
    const mapped = lineMap.get(line);
    if (mapped === undefined) {
      return null;
    }
    offsets.push(mapped - line);
    return mapped;
  };

  const mapAnchor = (anchor: Anchor): Anchor | null => {
    const line = mapLine(anchor.line);
    if (line === null) {
      return null;
    }
    return { line };
  };

  const remapped: Edit[] = [];
  for (const edit of edits) {
    const next = remapEditToCurrent(edit, mapLine, mapAnchor);
    if (next === null) {
      return null;
    }
    remapped.push(next);
  }

  if (offsets.length === 0) {
    return null;
  }
  const [firstOffset] = offsets;
  if (firstOffset === undefined || firstOffset === 0) {
    return null;
  }
  if (!offsets.every((offset) => offset === firstOffset)) {
    return null;
  }
  return remapped;
}

function replayRemappedAnchorsOnCurrent(
  previousText: string,
  currentText: string,
  edits: readonly Edit[]
): RecoveryResult | null {
  const remapped = remapEditsToCurrent(previousText, currentText, edits);
  if (remapped === null) {
    return null;
  }
  let applied: ApplyResult;
  try {
    applied = applyEdits(currentText, remapped);
  } catch {
    return null;
  }
  if (applied.text === currentText) {
    return null;
  }
  return {
    firstChangedLine: applied.firstChangedLine,
    text: applied.text,
    warnings: [RECOVERY_LINE_REMAP_WARNING, ...(applied.warnings ?? [])],
  };
}

function replaySessionChainOnCurrent(
  previousText: string,
  currentText: string,
  edits: readonly Edit[]
): RecoveryResult | null {
  // Two guards narrow the corruption window. Neither alone is sufficient,
  // and even together they don't fully prove correctness — replay is the
  // less-certain recovery mode and emits RECOVERY_SESSION_REPLAY_WARNING
  // so the caller can verify the diff.
  //   - Equal line counts: every line number in `edits` still resolves to
  //     SOME logical row (no net shift across the prior chain). A
  //     coincidental insert+delete pair can still leave indices pointing
  //     at different logical rows than the model anchored against.
  //   - Anchor-content alignment: the row at each anchor's line index has
  //     identical content in previous and current. Catches the common
  //     case of a prior edit rewriting the targeted line; can still be
  //     coincidentally satisfied by a duplicated row at the shifted
  //     index.
  if (previousText.split("\n").length !== currentText.split("\n").length) {
    return null;
  }
  if (!verifyAnchorContent(previousText, currentText, edits)) {
    return null;
  }
  let applied: ApplyResult;
  try {
    applied = applyEdits(currentText, [...edits]);
  } catch {
    return null;
  }
  if (applied.text === currentText) {
    return null;
  }
  return {
    firstChangedLine: applied.firstChangedLine,
    text: applied.text,
    warnings: [RECOVERY_SESSION_REPLAY_WARNING, ...(applied.warnings ?? [])],
  };
}

/** First 1-indexed line at which `a` and `b` diverge, or `undefined` if equal. */
function findFirstChangedLine(a: string, b: string): number | undefined {
  if (a === b) {
    return undefined;
  }
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const max = Math.max(aLines.length, bLines.length);
  for (let i = 0; i < max; i += 1) {
    if (aLines[i] !== bLines[i]) {
      return i + 1;
    }
  }
  return undefined;
}

/**
 * Stateless recovery driver over a {@link SnapshotStore}. Construct once and
 * call {@link Recovery.tryRecover} per stale-tag incident. The default
 * implementation tries three strategies in order:
 *
 * 1. Apply the edits on the full-file version the tag names, then 3-way-merge
 *    the resulting patch onto the live content (handles external writes).
 * 2. Remap every stale anchor through the unchanged-line diff from the tagged
 *    snapshot to the live text, then replay on live content. This handles a
 *    prior insertion/deletion before the target while refusing changed anchors
 *    and mixed offsets across the same edit range.
 * 3. (Session chain) If that version wasn't the head, replay the edits onto
 *    the live content directly when line counts match AND every edit's anchor
 *    line content is unchanged between version and current — a prior in-session
 *    edit advanced the tag and the model's anchors still name the same logical
 *    rows. Emits a dedicated {@link RECOVERY_SESSION_REPLAY_WARNING} because
 *    even with both guards a coincidental insert+delete pair on duplicate rows
 *    can still land the edit on the wrong row; see {@link replaySessionChainOnCurrent}.
 */
export class Recovery {
  readonly store: SnapshotStore;

  constructor(store: SnapshotStore) {
    this.store = store;
  }

  /**
   * Attempt recovery. Returns `null` when no path forward is found — the
   * caller should then surface a {@link MismatchError}.
   */
  tryRecover(args: RecoveryArgs): RecoveryResult | null {
    const { path, currentText, fileHash, edits } = args;
    // When two retained texts collide on the 16-bit tag, resolve to the
    // most-recently recorded one; a wrong pick can only land if one of the
    // merge/remap/session-chain strategies below applies it cleanly.
    const snapshot = this.store.byHash(path, fileHash);
    if (!snapshot) {
      return null;
    }
    const isHead = this.store.head(path) === snapshot;
    const recoveryWarning = isHead
      ? RECOVERY_EXTERNAL_WARNING
      : RECOVERY_SESSION_CHAIN_WARNING;
    const merged = applyEditsToSnapshot(
      snapshot.text,
      currentText,
      edits,
      recoveryWarning
    );
    if (merged !== null) {
      return merged;
    }
    // Line-shift fallback: the 3-way merge refused, but unchanged anchor
    // lines may have moved because a prior edit inserted or deleted rows
    // before them. Remap only when every anchor resolves through the diff
    // with one consistent offset; otherwise the edit range was touched.
    const remapped = replayRemappedAnchorsOnCurrent(
      snapshot.text,
      currentText,
      edits
    );
    if (remapped !== null) {
      return remapped;
    }
    // Session-chain fallback: replay onto current is gated by line-count
    // equality AND anchor-content alignment — see
    // `replaySessionChainOnCurrent` for why both guards together still
    // don't fully prove correctness.
    if (!isHead) {
      return replaySessionChainOnCurrent(snapshot.text, currentText, edits);
    }
    return null;
  }
}
