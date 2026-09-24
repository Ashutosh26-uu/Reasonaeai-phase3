// SPDX-License-Identifier: MIT
// Ported from spectra (MIT, the project owner's own codebase) —
// packages/code/src/tools/hashline/types.ts.

/**
 * Pure data types shared across the hashline parser, applier, and patcher.
 * Nothing in this file references a filesystem, agent runtime, or schema
 * library — keep it that way.
 */

/** A line-number anchor (1-indexed). */
export interface Anchor {
  line: number;
}

/** Where an `insert` edit should land relative to existing content. */
export type Cursor =
  | { kind: "bof" }
  | { kind: "eof" }
  | { kind: "before_anchor"; anchor: Anchor }
  | { kind: "after_anchor"; anchor: Anchor };

/**
 * A single low-level edit produced by the parser and consumed by the applier.
 * Multi-line replacements decompose to one `insert` per replacement line plus
 * one `delete` per consumed line. Replacement payloads are tagged so the
 * applier can distinguish literal insertion from new content for a deleted
 * line.
 */
export type Edit =
  | {
      kind: "insert";
      cursor: Cursor;
      text: string;
      lineNum: number;
      index: number;
      mode?: "replacement" | undefined;
      /**
       * Present on inserts lowered from `insert_after_block N:`: the
       * resolved block's first line. Lets the applier slide a body that
       * claims a depth inside the block back across the block's trailing
       * closer lines (never above this line).
       */
      blockStart?: number | undefined;
    }
  | {
      kind: "delete";
      anchor: Anchor;
      lineNum: number;
      index: number;
      oldAssertion?: string | undefined;
    }
  | {
      /**
       * Deferred block edit (`replace_block N:` / `delete_block N` /
       * `insert_after_block N:`). The exact line span is unknown at parse
       * time — it is computed by `resolveBlockEdits` once file text + path
       * (→ language) are available, then expanded into concrete edits: a
       * non-empty `payloads` without `mode` (from `replace_block`) becomes
       * the same `replacement` inserts + deletes that `replace start.=end:`
       * produces; an empty `payloads` (from `delete_block`) becomes a pure
       * range deletion; `mode: "insert_after"` becomes plain `after_anchor`
       * inserts at the block's last line. `applyEdits` never sees this
       * variant.
       */
      kind: "block";
      anchor: Anchor;
      payloads: string[];
      mode?: "insert_after" | undefined;
      lineNum: number;
      index: number;
    };

/** File-level operation parsed from a section body (`REM` / `MV`). */
export type FileOp = { kind: "rem" } | { kind: "move"; dest: string };

/** Result of applying a parsed set of edits to a text body. */
export interface ApplyResult {
  /**
   * Resolved spans for each `replace_block`/`delete_block` op in this apply,
   * in patch order. Present only when the apply matched the tagged content
   * (the common no-drift path), so the line numbers line up with what the
   * caller read. Absent when there were no block ops.
   */
  blockResolutions?: BlockResolution[] | undefined;
  /** First line number (1-indexed) that changed, or `undefined` for a no-op apply. */
  firstChangedLine?: number | undefined;
  /** Post-edit text body. */
  text: string;
  /** Diagnostic warnings collected by the parser, patcher, or recovery. */
  warnings?: string[] | undefined;
}

/** A parsed `[A.=B]` line range. */
export interface ParsedRange {
  end: Anchor;
  start: Anchor;
}

/** Optional hints for `splitPatchInput`. */
export interface SplitOptions {
  /** Resolves absolute paths inside hashline headers to cwd-relative form. */
  cwd?: string | undefined;
  /**
   * Fallback path used when the input lacks a `[PATH]` header but contains
   * recognizable hashline operations. Lets streaming previews work before
   * the model has written the header.
   */
  path?: string | undefined;
}

/** Streaming-formatter knobs for `streamHashLines`. */
export interface StreamOptions {
  /** Maximum UTF-8 bytes per yielded chunk (default 64 KiB). */
  maxChunkBytes?: number | undefined;
  /** Maximum formatted lines per yielded chunk (default 200). */
  maxChunkLines?: number | undefined;
  /** First line number to use when formatting (1-indexed, default 1). */
  startLine?: number | undefined;
}

/** Result of `buildCompactDiffPreview`. */
export interface CompactDiffPreview {
  addedLines: number;
  preview: string;
  removedLines: number;
}

/** Optional knobs for `buildCompactDiffPreview`. */
export interface CompactDiffOptions {
  /** Added lines kept on each side of a long added-run elision (default 2). */
  maxAddedRunContext?: number | undefined;
  /** Back-compat alias for `maxAddedRunContext`. */
  maxUnchangedRun?: number | undefined;
}

/**
 * Resolved 1-indexed inclusive line span of a `replace_block N:` target.
 */
export interface BlockSpan {
  /** Last line of the block (1-indexed, inclusive). */
  end: number;
  /** First line of the block (1-indexed, inclusive). */
  start: number;
}

/**
 * One `replace_block N:` / `delete_block N` / `insert_after_block N:` anchor
 * resolved to its concrete line span. Surfaced on {@link ApplyResult} so the
 * host can echo "block N → lines start.=end" and let the model catch a wrong
 * opener — e.g. a decorator or doc-comment that sits in a separate node
 * outside the resolved block.
 */
export interface BlockResolution {
  /** The 1-indexed line the block op was anchored on (the `N`). */
  anchorLine: number;
  /** Last line of the resolved span (1-indexed, inclusive). */
  end: number;
  /** Which block op produced this resolution. */
  op: "replace" | "delete" | "insert_after";
  /** First line of the resolved span (1-indexed, inclusive). */
  start: number;
}

/** Request handed to a `BlockResolver` to resolve one `replace_block N:` anchor. */
export interface BlockResolverRequest {
  /** 1-indexed line the block must begin on. */
  line: number;
  /** Target file path (used to infer language by extension). */
  path: string;
  /** Full text the block must be resolved against (the snapshot the tag names). */
  text: string;
}

/**
 * Resolves a `replace_block N:` anchor to the line span of the syntactic block
 * that begins on line N. Returns `null` when no block can be resolved
 * (unrecognized language, blank/out-of-range line, no node begins there, or the
 * resolved subtree has a syntax error). Pure seam: the hashline core declares
 * the contract; the host injects a tree-sitter-backed implementation.
 */
export type BlockResolver = (request: BlockResolverRequest) => BlockSpan | null;
