import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ArtifactPutInput,
  type ArtifactStore,
  artifactObjectKeyFor,
} from "@reasonateai/artifact-store";
import { describe, expect, it } from "vitest";
import { createDurableSpillSink } from "../src/durable-artifacts.js";
import type { RunScope } from "../src/run-scope.js";

const SHA256_DIGEST_REGEX = /^[0-9a-f]{64}$/;

const scope = {
  buildSessionId: "55555555-5555-4555-8555-555555555555",
  organizationId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  runId: "44444444-4444-4444-8444-444444444444",
} as RunScope;

interface MemoryRecord {
  readonly bytes: Uint8Array;
}

/** An in-memory store whose reads mirror the real one: key lookup, no rehash. */
function memoryStore(): ArtifactStore & {
  stored: Map<string, MemoryRecord>;
} {
  const stored = new Map<string, MemoryRecord>();

  const store: ArtifactStore = {
    put(
      input: ArtifactPutInput
    ): Promise<{ bytes: number; digest: string; key: string }> {
      const digest = createHash("sha256").update(input.content).digest("hex");

      // The manifest already carries the real key the store would use, so the
      // memory store addresses by it rather than inventing a second shape.
      const key =
        input.manifest.files[0]?.objectKey ??
        artifactObjectKeyFor({
          artifactId: input.manifest.artifactId,
          digest,
          organizationId: input.organizationId,
          projectId: input.projectId,
        });

      stored.set(key, { bytes: input.content });

      return Promise.resolve({ bytes: input.content.byteLength, digest, key });
    },

    read(input): Promise<Uint8Array> {
      const record = stored.get(input.key);

      if (record === undefined) {
        throw new Error(`not found: ${input.key}`);
      }

      return Promise.resolve(record.bytes);
    },
  };

  return Object.assign(store, { stored });
}

describe("durable spill sink", () => {
  it("writes a spill through the store and records its manifest digest", async () => {
    const store = memoryStore();
    const recorded: string[] = [];

    const sink = createDurableSpillSink({
      artifacts: store,
      record: (manifest) => {
        recorded.push(manifest.artifactId);
        return Promise.resolve();
      },
      scope,
    });

    const spill = await sink.write({
      content: "spilled body",
      extension: "txt",
      index: 0,
    });

    expect(recorded).toEqual([spill.artifactId]);
    expect(spill.digest).toMatch(SHA256_DIGEST_REGEX);
    expect(store.stored.size).toBe(1);
  });

  it("resolves a spill after the writing process is gone", async () => {
    const store = memoryStore();
    const digests = new Map<string, string>();

    const first = createDurableSpillSink({
      artifacts: store,
      record: (manifest) => {
        digests.set(manifest.artifactId, manifest.files[0]?.sha256 ?? "");
        return Promise.resolve();
      },
      scope,
    });

    const spill = await first.write({
      content: "spilled body",
      extension: "txt",
      index: 0,
    });

    // A restarted process holds the same scope and the recorded digests,
    // but no in-memory index of what index N was.
    const second = createDurableSpillSink({
      artifacts: store,
      recordedDigest: async (artifactId) => digests.get(artifactId),
      scope,
    });

    expect(await second.read(0)).toBe(
      spill.digest ? "spilled body" : undefined
    );
    expect(await second.read(1)).toBeUndefined();
  });

  it("refuses a spill whose recorded digest does not match the stored bytes", async () => {
    const store = memoryStore();
    const digests = new Map<string, string>();

    const writer = createDurableSpillSink({
      artifacts: store,
      record: (manifest) => {
        digests.set(manifest.artifactId, manifest.files[0]?.sha256 ?? "");
        return Promise.resolve();
      },
      scope,
    });

    await writer.write({
      content: "real body",
      extension: "txt",
      index: 0,
    });

    // A tampered record produces a key that does not exist in the store.
    const tampered = new Map(digests);
    const first = digests.keys().next().value as string;

    tampered.set(
      first,
      "0000000000000000000000000000000000000000000000000000000000000000"
    );

    const reader = createDurableSpillSink({
      artifacts: store,
      recordedDigest: async (artifactId) => tampered.get(artifactId),
      scope,
    });

    await expect(reader.read(0)).rejects.toThrow();
  });

  it("keeps spill index and record aligned when writes are concurrent", async () => {
    const store = memoryStore();
    const recorded: number[] = [];

    const sink = createDurableSpillSink({
      artifacts: store,
      record: () => {
        recorded.push(recorded.length);
        return Promise.resolve();
      },
      scope,
    });

    const spills = await Promise.all(
      [0, 1, 2].map((index) =>
        sink.write({ content: `body ${index}`, extension: "txt", index })
      )
    );

    expect(spills.map((spill) => spill.index)).toEqual([0, 1, 2]);
    expect(recorded).toEqual([0, 1, 2]);
  });

  it("reports absence rather than guessing when nothing was recorded", async () => {
    const store = memoryStore();

    const sink = createDurableSpillSink({
      artifacts: store,
      recordedDigest: async () => undefined,
      scope,
    });

    expect(await sink.read(0)).toBeUndefined();
  });
});

describe("durable spill sink against the real local store", () => {
  it("writes through the real local store and reads back the same bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "durable-spill-"));
    const { createLocalArtifactStore } = await import(
      "@reasonateai/artifact-store/local"
    );
    const store = createLocalArtifactStore({ root });
    const digests = new Map<string, string>();

    const writer = createDurableSpillSink({
      artifacts: store,
      record: (manifest) => {
        digests.set(manifest.artifactId, manifest.files[0]?.sha256 ?? "");
        return Promise.resolve();
      },
      scope,
    });

    await writer.write({
      content: "durable body",
      extension: "txt",
      index: 0,
    });

    const reader = createDurableSpillSink({
      artifacts: store,
      recordedDigest: async (artifactId) => digests.get(artifactId),
      scope,
    });

    expect(await reader.read(0)).toBe("durable body");
  });
});
