// SPDX-License-Identifier: MIT
// Ported from spectra (MIT, the project owner's own codebase) —
// packages/code/src/tools/read-snapshots.ts.

/**
 * Snapshot recording for the read side of the hashline protocol: it binds the
 * text a read displayed to the store whose content tags the patcher resolves
 * section headers against.
 */

import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  InMemorySnapshotStore,
  type SnapshotStore,
} from "./hashline/snapshots.js";

/** Content above this size is never recorded: the store could not hold it. */
export const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;

/** A leading UTF-8 BOM, stripped before hashing so it never changes a tag. */
const BOM_RE = /^\uFEFF/;

/** CRLF, normalized to LF before hashing. */
const CRLF_RE = /\r\n/g;

export class ReadSnapshotStore {
  readonly store: SnapshotStore;

  constructor(store: SnapshotStore = new InMemorySnapshotStore()) {
    this.store = store;
  }

  /**
   * Record `content` as the current state of `filePath` and return its content
   * tag, or `undefined` when the content exceeds {@link SNAPSHOT_MAX_BYTES}.
   */
  async record(
    filePath: string,
    content: string,
    seenLines: Iterable<number>
  ): Promise<string | undefined> {
    if (Buffer.byteLength(content) > SNAPSHOT_MAX_BYTES) {
      return undefined;
    }
    return this.store.record(
      await this.canonicalPath(filePath),
      content.replace(BOM_RE, "").replace(CRLF_RE, "\n"),
      seenLines
    );
  }

  /**
   * The key the snapshot store knows this file by: its real path, the real path
   * of its directory joined to its basename when the file itself cannot be
   * resolved, or the resolved path as a last resort.
   */
  async canonicalPath(filePath: string): Promise<string> {
    try {
      return await realpath(filePath);
    } catch {
      try {
        return join(await realpath(dirname(filePath)), basename(filePath));
      } catch {
        return resolve(filePath);
      }
    }
  }
}
