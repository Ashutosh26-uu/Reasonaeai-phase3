/**
 * The format readers a run uses, in dispatch order.
 *
 * Order is load-bearing and is the reason this is one list rather than four
 * independent registrations. Dispatch takes the first reader whose `matches`
 * accepts the target, so a reader that claims an extension another reader also
 * claims wins by being earlier.
 *
 * Two pairs overlap deliberately:
 *
 * - `docx`, `xlsx`, `pptx`, and `epub` are ZIP containers, so the archive reader
 *   can list their members. That is correct today, because nothing converts them.
 *   When a document reader exists it MUST be placed before the archive reader, or
 *   a `.docx` would be served as a member listing instead of readable text.
 * - A `.db` is not a ZIP, so the SQLite and archive readers do not contend. The
 *   order between them is fixed anyway, so dispatch is deterministic rather than
 *   dependent on insertion.
 *
 * The web reader is first because its target is a URL rather than a path, and no
 * other reader can match one.
 */

import { archiveReader } from "./archive.js";
import { imageReader } from "./image.js";
import { sqliteReader } from "./sqlite.js";
import type { FormatReader } from "./types.js";
import { webReader } from "./web.js";

/**
 * Build the reader list for a run.
 *
 * Readers are stateless and hold no per-run state, so one list serves every run.
 * It is built per call rather than shared as a module constant only so that a
 * caller can wrap or extend it without mutating global state.
 */
export function createFormatReaders(): readonly FormatReader[] {
  return [webReader, sqliteReader, imageReader, archiveReader];
}
