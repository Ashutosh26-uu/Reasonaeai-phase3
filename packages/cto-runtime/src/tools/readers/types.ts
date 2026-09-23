/**
 * The format-reader contract.
 *
 * `read` dispatches by extension to a reader that knows one family of formats.
 * Keeping them behind one interface is what lets a new format be added without
 * touching the tool: a reader announces the extensions it claims and returns
 * text, and the dispatch is a table lookup.
 *
 * Two rules every reader must honour:
 *
 * 1. **State the limit that was hit.** These formats carry data far larger than
 *    any useful context, so every reader is bounded. A bound that is applied
 *    silently reads as a complete result, which is how a model concludes a
 *    database has no other tables or a PDF has no page 200.
 * 2. **Never claim a format it cannot actually parse.** A reader that returns a
 *    best-effort dump of binary bytes as "text" is worse than refusing, because
 *    the model cannot tell the difference between content and noise.
 */

/** Where a reader's output came from, so the tool can annotate it. */
export interface ReaderResult {
  contentType: "text/markdown" | "text/plain" | "application/json";
  /**
   * True when the source cannot be edited, so no edit anchor should be minted.
   * A row of a database and a page of a PDF are not editable regions of a file.
   */
  immutable?: boolean | undefined;
  /** Facts worth surfacing beside the content, such as which page or table. */
  notes?: string[] | undefined;
  text: string;
}

/**
 * Size limits, in bytes of source input.
 *
 * These are deliberately generous compared to what fits in context, because the
 * readers select and summarise rather than dumping. The bound exists to stop a
 * pathological input from exhausting memory before selection happens.
 */
export interface ReaderLimits {
  /** An archive container. */
  maxArchiveBytes: number;
  /** One member extracted from an archive. */
  maxArchiveMemberBytes: number;
  /** A document converted to text, which expands during conversion. */
  maxDocumentBytes: number;
  /** A plain resource read. */
  maxResourceBytes: number;
}

/** The default limits. */
export const DEFAULT_READER_LIMITS: ReaderLimits = {
  maxArchiveBytes: 256 * 1024 * 1024,
  maxArchiveMemberBytes: 64 * 1024 * 1024,
  maxDocumentBytes: 64 * 1024 * 1024,
  maxResourceBytes: 16 * 1024 * 1024,
};

/** Output bounding, applied by the tool after a reader returns. */
export interface OutputLimits {
  /** Characters kept before the output is reduced and spilled. */
  maxInlineChars: number;
  /** Lines kept when the output is reduced. */
  maxReducedLines: number;
}

export const DEFAULT_OUTPUT_LIMITS: OutputLimits = {
  maxInlineChars: 240_000,
  maxReducedLines: 240,
};

/** A raised limit breach, reported so the caller can say which bound was hit. */
export class ReaderLimitError extends Error {
  readonly limit: string;
  readonly observed: number;

  constructor(limit: string, observed: number, allowed: number) {
    super(
      `${limit} exceeded: ${observed} bytes is over the ${allowed}-byte limit`
    );
    this.name = "ReaderLimitError";
    this.limit = limit;
    this.observed = observed;
  }
}

/** Raised when a target is a format the reader cannot actually interpret. */
export class UnsupportedFormatError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UnsupportedFormatError";
  }
}

/** Everything a reader needs to read one target. */
export interface ReaderRequest {
  limits: ReaderLimits;
  /** Absolute path to the target. */
  path: string;
  /** The raw selector chain, such as `:table` or `:1-40`, unparsed by the tool. */
  selector: string | undefined;
}

/**
 * One format family.
 *
 * `matches` is separate from `extensions` because a selector can change which
 * reader applies: `data.db:raw` wants the bytes while `data.db` wants the
 * schema, and `archive.zip:inner.txt` wants a member.
 */
export interface FormatReader {
  /** Lowercase extensions this reader claims, each including the leading dot. */
  readonly extensions: readonly string[];
  /** Whether this reader handles the given target. */
  readonly matches: (
    request: Pick<ReaderRequest, "path" | "selector">
  ) => boolean;
  /** Stable name, used in diagnostics and tests. */
  readonly name: string;
  /** Read the target. Must throw rather than return a partial dump. */
  readonly read: (request: ReaderRequest) => Promise<ReaderResult>;
}

/** True when `size` exceeds `limit`, reporting which bound was breached. */
export function assertWithinLimit(
  limit: string,
  size: number,
  allowed: number
): void {
  if (size > allowed) {
    throw new ReaderLimitError(limit, size, allowed);
  }
}
