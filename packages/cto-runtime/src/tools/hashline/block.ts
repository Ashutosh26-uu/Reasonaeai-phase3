// SPDX-License-Identifier: MIT
// Ported from spectra (MIT, the project owner's own codebase) —
// packages/code/src/tools/hashline/block.ts.

/**
 * Expand deferred block edits (`replace_block N:` / `delete_block N` /
 * `insert_after_block N:`) into concrete inserts + deletes.
 *
 * The hashline parser cannot expand a block edit on its own — the line span is
 * unknown until file text + path (→ language) are available. This transform
 * runs at every apply/preview boundary that has text: it calls the injected
 * {@link BlockResolver} to resolve each block's `[start, end]` span, then emits
 * the exact same edits the concrete form produces in the parser: `replace
 * start.=end:` inserts + deletes for a replace, a pure range delete for a
 * delete, and plain `after_anchor` inserts at `end` for an insert-after. After
 * it runs, no `block` edits remain, so {@link applyEdits} (and recovery) only
 * ever see resolved edits.
 */

import { STRUCTURAL_CLOSER_RE } from "./apply.js";
import {
  BLOCK_RESOLVER_UNAVAILABLE,
  blockSingleLineMessage,
  blockUnresolvedMessage,
  insertAfterBlockCloserLoweredWarning,
  insertAfterBlockUnresolvedLoweredWarning,
} from "./messages.js";
import type {
  BlockResolution,
  BlockResolver,
  BlockSpan,
  Cursor,
  Edit,
} from "./types.js";

/** The deferred `block` variant of {@link Edit}. */
type BlockEdit = Extract<Edit, { kind: "block" }>;

export interface ResolveBlockEditsOptions {
  /**
   * Invoked once per successfully resolved block edit, in patch order, with
   * the anchor line and the concrete span it resolved to. Lets the host echo
   * the resolution back to the caller. Never fired for dropped/unresolvable
   * edits.
   */
  onResolved?: (resolution: BlockResolution) => void;
  /**
   * How to handle a replace/delete block edit that cannot be resolved
   * (missing resolver or a `null` span). `"throw"` (default) raises a
   * `blockUnresolvedMessage` error — used by the authoritative apply + final
   * preview paths. `"drop"` silently skips the edit — used by the streaming
   * preview, where a half-written file or transient parse error must not
   * throw. Unresolvable `insert_after_block N:` edits never reach this: they
   * are lowered to plain `insert after N:` with a warning.
   */
  onUnresolved?: "throw" | "drop";
  /**
   * Invoked once per diagnostic produced while resolving — currently the
   * `insert_after_block N:` lowerings (closer anchor or unresolvable block).
   * Hosts should surface these on the apply result's `warnings`.
   */
  onWarning?: (message: string) => void;
}

/** True when at least one edit is an unresolved deferred block edit. */
export function hasBlockEdit(edits: readonly Edit[]): boolean {
  return edits.some((edit) => edit.kind === "block");
}

/**
 * Resolve every deferred block edit in `edits` against `text` (parsed as the
 * language inferred from `path`). Non-block edits pass through untouched.
 * Returns a fresh edit list with no `block` variants. The fast path returns the
 * input unchanged when there is nothing to resolve.
 *
 * Synthesized inserts/deletes carry sequential `index` values for readability
 * only — {@link applyEdits} re-derives every edit's index from array order, so
 * the passthrough edits keeping their original indices is harmless.
 */
export function resolveBlockEdits(
  edits: readonly Edit[],
  text: string,
  path: string,
  resolver: BlockResolver | undefined,
  options: ResolveBlockEditsOptions = {}
): readonly Edit[] {
  if (!hasBlockEdit(edits)) {
    return edits;
  }
  const onUnresolved = options.onUnresolved ?? "throw";
  const resolved: Edit[] = [];
  let synthIndex = 0;
  for (const edit of edits) {
    if (edit.kind !== "block") {
      resolved.push(edit);
      continue;
    }
    const rows = resolveOneBlockEdit(
      edit,
      synthIndex,
      text,
      path,
      resolver,
      onUnresolved,
      options
    );
    synthIndex += rows.length;
    resolved.push(...rows);
  }
  return resolved;
}

/**
 * Resolve one block edit into concrete edits indexed from `startIndex`. Returns
 * an empty list when a lenient (`drop`) unresolved path discards the edit.
 */
function resolveOneBlockEdit(
  edit: BlockEdit,
  startIndex: number,
  text: string,
  path: string,
  resolver: BlockResolver | undefined,
  onUnresolved: "throw" | "drop",
  options: ResolveBlockEditsOptions
): Edit[] {
  const op = blockOp(edit);
  const span = resolver
    ? resolver({ line: edit.anchor.line, path, text })
    : null;
  if (span === null) {
    if (op === "insert_after") {
      warnLoweredInsertAfter(edit, text, options);
      return afterAnchorRows(edit, edit.anchor.line, startIndex);
    }
    if (onUnresolved === "drop") {
      return [];
    }
    throw new Error(
      `line ${edit.lineNum}: ${
        resolver
          ? blockUnresolvedMessage(edit.anchor.line, op, text.split("\n"))
          : BLOCK_RESOLVER_UNAVAILABLE
      }`
    );
  }
  if (span.start === span.end) {
    // A single-line block resolution means line N is a bare statement, not
    // the opening line of a multi-line construct — the common mis-anchor
    // that lands a body in the wrong scope (e.g. between a `case` body line
    // and its `break;`). The plain op is exact for one line, so reject and
    // point at it; drop instead on the lenient preview path.
    if (onUnresolved === "drop") {
      return [];
    }
    throw new Error(
      `line ${edit.lineNum}: ${blockSingleLineMessage(edit.anchor.line, op)}`
    );
  }
  options.onResolved?.({
    anchorLine: edit.anchor.line,
    end: span.end,
    op,
    start: span.start,
  });
  return op === "insert_after"
    ? afterAnchorRows(edit, span.end, startIndex, span.start)
    : replacementRows(edit, span, startIndex);
}

/** The `insert_after_block N:` op inferred from a block edit's mode and payloads. */
function blockOp(edit: BlockEdit): "replace" | "delete" | "insert_after" {
  if (edit.mode === "insert_after") {
    return "insert_after";
  }
  return edit.payloads.length === 0 ? "delete" : "replace";
}

/**
 * `insert after anchorLine:` rows for one hunk, indexed from `startIndex`.
 * `blockStart` tags rows lowered from `insert_after_block N:` so the applier's
 * landing correction can slide a body claiming a depth inside the block.
 */
function afterAnchorRows(
  edit: BlockEdit,
  anchorLine: number,
  startIndex: number,
  blockStart?: number
): Edit[] {
  const rows: Edit[] = [];
  for (const payload of edit.payloads) {
    const cursor: Cursor = {
      anchor: { line: anchorLine },
      kind: "after_anchor",
    };
    rows.push({
      ...(blockStart === undefined ? {} : { blockStart }),
      cursor,
      index: startIndex + rows.length,
      kind: "insert",
      lineNum: edit.lineNum,
      text: payload,
    });
  }
  return rows;
}

/**
 * `replace start.=end:` rows: one `before_anchor` replacement insert per payload
 * row at `span.start`, then one delete per line across the span. An empty
 * `payloads` (from `delete_block N`) emits no inserts — a pure deletion.
 */
function replacementRows(
  edit: BlockEdit,
  span: BlockSpan,
  startIndex: number
): Edit[] {
  const rows: Edit[] = [];
  for (const payload of edit.payloads) {
    const cursor: Cursor = {
      anchor: { line: span.start },
      kind: "before_anchor",
    };
    rows.push({
      cursor,
      index: startIndex + rows.length,
      kind: "insert",
      lineNum: edit.lineNum,
      mode: "replacement",
      text: payload,
    });
  }
  for (let line = span.start; line <= span.end; line += 1) {
    rows.push({
      anchor: { line },
      index: startIndex + rows.length,
      kind: "delete",
      lineNum: edit.lineNum,
    });
  }
  return rows;
}

/**
 * Warn when an unresolvable `insert_after_block N:` degrades to plain
 * `insert after N:`. Two flavors:
 * - anchored on a pure closing-delimiter line: no block begins there, but line N
 *   IS the end of one, and "after the end of the block" is exactly the plain
 *   form — warn with the opener rule.
 * - otherwise (unsupported language, blank line, unparsable block, or no
 *   resolver wired): "after the block at N" degrades to "after line N" — warn to
 *   verify the landing line.
 */
function warnLoweredInsertAfter(
  edit: BlockEdit,
  text: string,
  options: ResolveBlockEditsOptions
): void {
  const anchorText = text.split("\n")[edit.anchor.line - 1];
  const isCloser =
    anchorText !== undefined && STRUCTURAL_CLOSER_RE.test(anchorText);
  options.onWarning?.(
    isCloser
      ? insertAfterBlockCloserLoweredWarning(edit.anchor.line)
      : insertAfterBlockUnresolvedLoweredWarning(edit.anchor.line)
  );
}
