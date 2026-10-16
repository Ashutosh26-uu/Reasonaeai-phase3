/**
 * The durable spill sink: spilled tool output written through the immutable
 * artifact store.
 *
 * The read tool spills oversized output into a per-run directory (see
 * `resources/artifacts.ts`), which is enough for the model to page it back
 * during the run. A run ends, though, and a host temporary directory is
 * neither durable nor tenant-attributable. This adapter wraps that spill:
 * every write puts the same text through the artifact store — one
 * content-addressed, tenant-prefixed object whose manifest is validated and
 * whose digest is recomputed on read — and, when the caller supplies metadata
 * hooks, records what was stored durably.
 *
 * Resolving a spill after a restart is the part that needs care: a spilled
 * id is a per-run counter, and nothing in the immutable store maps a counter
 * back to an object. The mapping is made derivable instead of persisted: the
 * spill's artifact id is a deterministic UUID keyed by the verified scope and
 * the index ({@link artifactIdForSpill}), so a later process holding the same
 * scope can recompute the id, look up the recorded digest, and rebuild the
 * object key. Keys and digests are still only ever derived by
 * `@reasonateai/artifact-store`'s own helpers, and reads rehash the bytes, so
 * a wrong or tampered mapping yields a refusal, not foreign content.
 */

import { createHash } from "node:crypto";
import type { ArtifactStore } from "@reasonateai/artifact-store";
import { artifactObjectKeyFor, sha256Hex } from "@reasonateai/artifact-store";
import {
  type ArtifactManifest,
  ArtifactManifestSchema,
} from "@reasonateai/contracts/execution-protocol";
import type {
  OrganizationId,
  ProjectId,
} from "@reasonateai/contracts/identity";

/**
 * Module-level digest regex, hoisted so each read does not construct one.
 */
const SHA256_DIGEST_REGEX = /^[0-9a-f]{64}$/;

/** The tenant scope one sink writes into and reads from. */
export interface SpillScope {
  readonly buildSessionId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly runId: string;
}

/**
 * The durable metadata a spill becomes. Only what the immutable store and the
 * record need; nothing here authorizes anything by itself.
 */
export interface SpillRecord {
  readonly artifactId: string;
  readonly digest: string;
  readonly index: number;
  readonly key: string;
  readonly size: number;
}

export interface DurableSpillSink {
  /**
   * Read one spill back by its per-run index, or `undefined` when neither
   * this process nor the recorded metadata knows it. The store rehashes the
   * bytes on the way out, so an altered object is refused rather than served.
   */
  readonly read: (index: number) => Promise<string | undefined>;
  /**
   * Write one spill through the immutable store and return its record.
   * `index` is the per-run id the caller has already assigned; the manifest's
   * file path carries it so transcript readers can show it.
   */
  readonly write: (input: {
    readonly content: string;
    readonly extension: string;
    readonly index: number;
  }) => Promise<SpillRecord>;
}

export interface CreateDurableSpillSinkInput {
  /** The immutable artifact store the bytes are put through. */
  readonly artifacts: ArtifactStore;
  /**
   * Persists one spill's validated manifest, best effort by design: the
   * bytes and their manifest are the artifact's identity, and the record is
   * what later processes use to find them. A record failure is not a write
   * failure; the caller composes it so.
   */
  readonly record?: ((manifest: ArtifactManifest) => Promise<void>) | undefined;
  /**
   * Reads back the digest recorded for one spill's artifact id, or undefined
   * when nothing was recorded. Supplying this (with {@link record}) is what
   * makes a spill resolvable after the process that wrote it is gone.
   */
  readonly recordedDigest?:
    | ((artifactId: string) => Promise<string | undefined>)
    | undefined;
  readonly scope: SpillScope;
}

const SPILL_KIND = "spill";
const SPILL_PATH_PREFIX = "spill/";
/** Universally unique but recognizable: a version-4 variant string. */
const VERSION_4 = "4";
const VARIANT_8 = "8";

/**
 * The artifact id one spill belongs to, recomputed by any process that holds
 * the verified scope and the index. This is the restart mapping: nothing has
 * to be looked up to reconstruct the id, and everything else about the
 * object (digest, key) is then checkable against a record or against bytes.
 */
export function artifactIdForSpill(input: {
  readonly index: number;
  readonly organizationId: string;
  readonly projectId: string;
  readonly runId: string;
}): string {
  const hash = createHash("sha256")
    .update(
      [
        "spill",
        input.organizationId,
        input.projectId,
        input.runId,
        String(input.index),
      ].join(":")
    )
    .digest("hex");
  const uuid = [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
  // Force the version and variant nibbles so the result always passes the
  // same UUID validation every other artifact id is held to.
  return `${uuid.slice(0, 14)}${VERSION_4}${uuid.slice(15, 19)}${VARIANT_8}${uuid.slice(20)}`;
}

export function createDurableSpillSink(
  input: CreateDurableSpillSinkInput
): DurableSpillSink {
  /**
   * Writes serialize per run. Two spills in flight from one loop are rare,
   * but the record they produce must line up with the index they were given,
   * and interleaved manifest+record work is where that would go wrong.
   */
  let tail: Promise<unknown> = Promise.resolve();

  const write = (request: {
    readonly content: string;
    readonly extension: string;
    readonly index: number;
  }): Promise<SpillRecord> => {
    const next = tail.then(() => writeOnce(request));
    tail = next.catch(() => undefined);
    return next;
  };

  const writeOnce = async (request: {
    readonly content: string;
    readonly extension: string;
    readonly index: number;
  }): Promise<SpillRecord> => {
    const content = Buffer.from(request.content, "utf-8");
    // The digest is computed from the bytes this call received, never from
    // anything a caller claims about them: the manifest must describe the
    // content it arrives with, and the key is derived from that digest.
    const digest = sha256Hex(content);
    const artifactId = artifactIdForSpill({
      index: request.index,
      organizationId: input.scope.organizationId,
      projectId: input.scope.projectId,
      runId: input.scope.runId,
    });
    // The key is rebuilt only through the store package's own builder, so a
    // spilled write is addressed exactly the way every other artifact is.
    const key = artifactObjectKeyFor({
      artifactId,
      digest,
      organizationId: input.scope.organizationId,
      projectId: input.scope.projectId,
    });
    const manifest: ArtifactManifest = ArtifactManifestSchema.parse({
      artifactId,
      buildSessionId: input.scope.buildSessionId,
      files: [
        {
          mediaType: "text/plain",
          objectKey: key,
          path: `${SPILL_PATH_PREFIX}${request.index}.${request.extension}`,
          sha256: digest,
          size: content.byteLength,
        },
      ],
      kind: SPILL_KIND,
      occurredAt: new Date().toISOString(),
      organizationId: input.scope.organizationId,
      projectId: input.scope.projectId,
      runId: input.scope.runId,
      schemaVersion: 1,
      totalSize: content.byteLength,
    });

    const stored = await input.artifacts.put({
      content,
      manifest,
      organizationId: input.scope.organizationId as OrganizationId,
      projectId: input.scope.projectId as ProjectId,
    });
    if (stored.digest !== digest || stored.bytes !== content.byteLength) {
      throw new Error(
        "The artifact store returned a digest that does not match the spilled content."
      );
    }

    if (input.record !== undefined) {
      try {
        await input.record(manifest);
      } catch (error) {
        // The bytes are stored; the record can be rebuilt on the next write
        // of the same index. Swallowing keeps the model's read unblocked.
        console.warn(
          `recording a spilled artifact failed (artifact ${artifactId}): ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    return {
      artifactId,
      digest,
      index: request.index,
      key,
      size: content.byteLength,
    };
  };

  /**
   * The object key of a previously recorded spill. Only a recorded digest
   * produces a key: a guess would read foreign bytes, so absence is reported
   * as absence.
   */
  const resolveRecordedKey = async (
    index: number
  ): Promise<string | undefined> => {
    if (input.recordedDigest === undefined) {
      return undefined;
    }
    const artifactId = artifactIdForSpill({
      index,
      organizationId: input.scope.organizationId,
      projectId: input.scope.projectId,
      runId: input.scope.runId,
    });
    const digest = await input.recordedDigest(artifactId);
    if (digest === undefined || !SHA256_DIGEST_REGEX.test(digest)) {
      return undefined;
    }
    return artifactObjectKeyFor({
      artifactId,
      digest,
      organizationId: input.scope.organizationId,
      projectId: input.scope.projectId,
    });
  };

  const read = async (index: number): Promise<string | undefined> => {
    const key = await resolveRecordedKey(index);
    if (key === undefined) {
      return undefined;
    }
    const bytes = await input.artifacts.read({
      key,
      organizationId: input.scope.organizationId as OrganizationId,
      projectId: input.scope.projectId as ProjectId,
    });
    return Buffer.from(bytes).toString("utf-8");
  };

  return { read, write };
}
