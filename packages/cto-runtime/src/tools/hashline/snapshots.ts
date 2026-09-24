// SPDX-License-Identifier: MIT
// Ported from spectra (MIT, the project owner's own codebase) —
// packages/code/src/tools/hashline/snapshots.ts.

/**
 * Per-session snapshot store used by {@link Recovery} and {@link Patcher} to
 * bind hashline section tags to the exact file content that minted them.
 *
 * A section tag is a content-derived hash of the *whole file* (see
 * {@link computeFileHash}). Any read of byte-identical content mints the same
 * tag, so reads of one file state fuse onto one anchor and a follow-up edit
 * anchored at any line validates whenever the live file still hashes to it.
 *
 * Producers (typically `read` / `search` / `write` tools) call
 * {@link SnapshotStore.record} with the full normalized text they observed.
 * The store hashes it, dedups against the per-path history, and returns the
 * tag. Consumers (recovery, the patcher) resolve a stale tag back to the
 * recorded full text via {@link SnapshotStore.byHash} and 3-way-merge the
 * would-be edit onto the live content.
 *
 * The abstract base class lets callers plug in whatever storage they like
 * (LRU, persistent SQLite, etc.). {@link InMemorySnapshotStore} ships as a
 * sensible default: a bounded LRU over `maxPaths` paths, each holding a short
 * ring of full-file versions, under a global byte ceiling, so in-session edit
 * chains can still recover against the version a stale tag names. Spectra
 * backed those bounds with `lru-cache`; they are implemented in this file
 * instead, because that package is not a dependency here.
 */
import { computeFileHash } from "./format.js";

/**
 * One full-file version observed at a point in time. The tag the model sees is
 * {@link Snapshot.hash}; recovery replays edits against {@link Snapshot.text}.
 */
export interface Snapshot {
  /** Content-derived tag for {@link Snapshot.text} (see {@link computeFileHash}). */
  readonly hash: string;
  /** Canonical path this version belongs to. */
  readonly path: string;
  /** Timestamp (ms since epoch) the version was recorded. */
  recordedAt: number;
  /**
   * 1-indexed file lines a producer (read/search) actually *displayed* under
   * this tag. A partial read (range, or a structural summary that collapsed
   * bodies) leaves this sparse; a whole-file read fills every line. Multiple
   * reads of the same content union into one set. `undefined` means "no
   * provenance recorded" — the patcher then skips the seen-line check and
   * applies as before. Mutated in place as more of the same content is read.
   */
  seenLines?: Set<number>;
  /** Full normalized (LF, no BOM) file text as observed. */
  readonly text: string;
}

/**
 * Storage seam for full-file version snapshots. The patcher calls {@link head}
 * for the latest version of a path and {@link byHash} when it needs the
 * historical version a section's stale tag names.
 */
export abstract class SnapshotStore {
  /** Most-recently recorded version for `path`, or `null` if none. */
  abstract head(path: string): Snapshot | null;

  /**
   * Recorded version for `path` whose tag equals `hash`, or `null`. When two
   * distinct texts collide on the 16-bit tag, returns the most-recently
   * recorded one.
   */
  abstract byHash(path: string, hash: string): Snapshot | null;

  /**
   * Recorded version for `path` whose {@link Snapshot.text} equals `fullText`,
   * or `null`. The patcher uses it on the no-drift path to attach seen-line
   * provenance to the exact text the model read.
   */
  abstract byContent(path: string, fullText: string): Snapshot | null;

  /**
   * Every retained version whose tag equals `hash`, across all tracked
   * paths. The patcher uses this to recover the intended file when a section
   * names a path that does not exist on disk but carries a tag the store
   * minted — the model mistyped the path of a file it read this session.
   *
   * The base returns no matches (recovery disabled); stores that can
   * enumerate their contents override it to enable tag-based path recovery.
   */
  findByHash(_hash: string): Snapshot[] {
    return [];
  }

  /**
   * Record the full normalized text of `path` and return its content tag.
   * `seenLines` (optional) are the 1-indexed lines the producer displayed;
   * they merge into {@link Snapshot.seenLines} across reads of identical text.
   */
  abstract record(
    path: string,
    fullText: string,
    seenLines?: Iterable<number>
  ): string;

  /**
   * Merge `lines` into the {@link Snapshot.seenLines} of the version whose tag
   * equals `hash`. No-op when no such version is retained (the content aged
   * out or was overwritten). Lets producers attach displayed lines after the
   * tag was already minted (the body is formatted after the hash is computed).
   */
  abstract recordSeenLines(
    path: string,
    hash: string,
    lines: Iterable<number>
  ): void;

  /** Drop the version history for a single path. */
  abstract invalidate(path: string): void;

  /**
   * Move retained version history (and read provenance) from `from` to `to`.
   * No-op when `from` has no history. Used by file moves so tags minted from
   * reads of the source path stay valid at the destination.
   */
  abstract relocate(from: string, to: string): void;

  /** Drop every version history. */
  abstract clear(): void;
}

const DEFAULT_MAX_PATHS = 30;
const DEFAULT_MAX_VERSIONS_PER_PATH = 4;
/** Global ceiling on retained snapshot text (UTF-16 code units). */
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/** Union `lines` into `snapshot.seenLines`, lazily creating the set. */
function mergeSeenLines(
  snapshot: Snapshot,
  lines: Iterable<number> | undefined
): void {
  if (lines === undefined) {
    return;
  }
  if (snapshot.seenLines === undefined) {
    snapshot.seenLines = new Set<number>();
  }
  for (const line of lines) {
    snapshot.seenLines.add(line);
  }
}

/**
 * Size of one path history as `lru-cache` measured it: `1` per history plus
 * the UTF-16 length of every retained version's text.
 */
function historyBytes(history: readonly Snapshot[]): number {
  let total = 1;
  for (const version of history) {
    total += version.text.length;
  }
  return total;
}

export interface InMemorySnapshotStoreOptions {
  /** Maximum distinct paths tracked at once (default 30). LRU eviction. */
  maxPaths?: number;
  /**
   * Global ceiling on retained snapshot text summed across every path's
   * version history, measured in UTF-16 code units (default 64 MiB).
   * Least-recently-used path histories are evicted to stay under it.
   */
  maxTotalBytes?: number;
  /** Maximum full-file versions per path (default 4). Oldest dropped first. */
  maxVersionsPerPath?: number;
}

/**
 * In-memory {@link SnapshotStore} whose bounds are an in-file LRU over path
 * histories. Per-path history is a short ring of full-file versions (oldest
 * dropped first); per-session path tracking is LRU-bounded so cold paths age
 * out automatically, and a global byte ceiling evicts least-recently-used
 * histories when the retained text grows too large. A history whose own size
 * exceeds that ceiling is dropped on its own instead of flushing the rest.
 *
 * Recording byte-identical content again refreshes recency and reuses the
 * existing tag (read fusion); recording new content unshifts a fresh version
 * onto the front of the path history. Two distinct texts that collide on the
 * short 4-hex tag are retained as separate versions so callers can still tell
 * them apart via {@link Snapshot.text} — the tag is only a fast index, never
 * the identity.
 */
export class InMemorySnapshotStore extends SnapshotStore {
  /**
   * Path histories in least-recently-used-first order: the first key is the
   * next eviction victim, so `Map` insertion order is the recency order.
   */
  readonly #histories = new Map<string, Snapshot[]>();
  readonly #maxPaths: number;
  readonly #maxTotalBytes: number;
  readonly #maxVersionsPerPath: number;

  constructor(options: InMemorySnapshotStoreOptions = {}) {
    super();
    this.#maxPaths = options.maxPaths ?? DEFAULT_MAX_PATHS;
    this.#maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.#maxVersionsPerPath =
      options.maxVersionsPerPath ?? DEFAULT_MAX_VERSIONS_PER_PATH;
  }

  override head(path: string): Snapshot | null {
    return this.#read(path)?.[0] ?? null;
  }

  override byHash(path: string, hash: string): Snapshot | null {
    const history = this.#read(path);
    return history?.find((version) => version.hash === hash) ?? null;
  }

  override byContent(path: string, fullText: string): Snapshot | null {
    const history = this.#read(path);
    return history?.find((version) => version.text === fullText) ?? null;
  }

  override findByHash(hash: string): Snapshot[] {
    const matches: Snapshot[] = [];
    // `lru-cache` iterated most-recently-used first; this map is stored in the
    // opposite order, so walk the keys back to front.
    for (const path of [...this.#histories.keys()].reverse()) {
      const history = this.#histories.get(path);
      if (history === undefined) {
        continue;
      }
      for (const version of history) {
        if (version.hash === hash) {
          matches.push(version);
        }
      }
    }
    return matches;
  }

  override record(
    path: string,
    fullText: string,
    seenLines?: Iterable<number>
  ): string {
    const hash = computeFileHash(fullText);
    // `#read` refreshes LRU recency for `path`.
    const history = this.#read(path) ?? [];
    // Dedup requires full-text equality, not just tag equality: two distinct
    // texts that happen to share the 4-hex tag are DIFFERENT snapshots — fusing
    // them under one entry would corrupt seenLines (attaching lines from
    // text B onto the stored text A) and let the patcher misresolve which
    // snapshot the section tag names when it does 3-way merge or seen-line
    // validation. See issue #4075.
    const existing = history.find(
      (version) => version.hash === hash && version.text === fullText
    );
    if (existing) {
      // Same content state observed again: refresh recency and promote to
      // head (it is the current file content), then reuse the tag. Union any
      // newly-displayed lines so re-reading more of the file widens coverage.
      existing.recordedAt = Date.now();
      mergeSeenLines(existing, seenLines);
      if (history[0] !== existing) {
        this.#write(path, [
          existing,
          ...history.filter((version) => version !== existing),
        ]);
      }
      return hash;
    }

    const snapshot: Snapshot = {
      hash,
      path,
      recordedAt: Date.now(),
      text: fullText,
    };
    mergeSeenLines(snapshot, seenLines);
    this.#write(
      path,
      [snapshot, ...history].slice(0, this.#maxVersionsPerPath)
    );
    return hash;
  }

  override recordSeenLines(
    path: string,
    hash: string,
    lines: Iterable<number>
  ): void {
    const version = this.#read(path)?.find(
      (snapshot) => snapshot.hash === hash
    );
    if (version) {
      mergeSeenLines(version, lines);
    }
  }

  override invalidate(path: string): void {
    this.#histories.delete(path);
  }

  override relocate(from: string, to: string): void {
    const sourceHistory = this.#read(from);
    if (sourceHistory === undefined || sourceHistory.length === 0) {
      return;
    }
    const relocated = sourceHistory.map((version) => ({
      ...version,
      path: to,
    }));
    const destHistory = this.#read(to);
    if (destHistory === undefined) {
      this.#write(to, relocated);
    } else {
      const seen = new Set<string>();
      const merged: Snapshot[] = [];
      for (const version of [...relocated, ...destHistory]) {
        if (seen.has(version.hash)) {
          continue;
        }
        seen.add(version.hash);
        merged.push(version);
      }
      this.#write(to, merged.slice(0, this.#maxVersionsPerPath));
    }
    this.#histories.delete(from);
  }

  override clear(): void {
    this.#histories.clear();
  }

  /**
   * History for `path`, moved to most-recently-used. Mirrors `lru-cache.get`:
   * a miss neither creates nor evicts anything.
   */
  #read(path: string): Snapshot[] | undefined {
    const history = this.#histories.get(path);
    if (history === undefined) {
      return undefined;
    }
    this.#histories.delete(path);
    this.#histories.set(path, history);
    return history;
  }

  /** Store `history` for `path` as most-recently-used, then enforce the caps. */
  #write(path: string, history: Snapshot[]): void {
    // `lru-cache` refuses an entry whose own size exceeds `maxEntrySize`
    // (which defaults to `maxSize`): it deletes whatever the key held and
    // leaves every other entry alone. Mirroring that keeps one oversized file
    // from flushing the rest of the session's snapshots.
    if (historyBytes(history) > this.#maxTotalBytes) {
      this.#histories.delete(path);
      return;
    }
    this.#histories.delete(path);
    this.#histories.set(path, history);
    this.#trim();
  }

  /**
   * Evict least-recently-used path histories until the path cap and the byte
   * ceiling both hold. A single history larger than the ceiling evicts itself,
   * matching `lru-cache`'s behaviour when one entry exceeds `maxSize`.
   */
  #trim(): void {
    let totalBytes = 0;
    for (const history of this.#histories.values()) {
      totalBytes += historyBytes(history);
    }
    while (
      this.#histories.size > this.#maxPaths ||
      (this.#histories.size > 0 && totalBytes > this.#maxTotalBytes)
    ) {
      const oldest = this.#histories.keys().next();
      if (oldest.done === true) {
        break;
      }
      const history = this.#histories.get(oldest.value);
      if (history !== undefined) {
        totalBytes -= historyBytes(history);
      }
      this.#histories.delete(oldest.value);
    }
  }
}
