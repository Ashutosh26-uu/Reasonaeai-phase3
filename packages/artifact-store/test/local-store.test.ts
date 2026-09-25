import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactConflictError,
  ArtifactIdentifierError,
  ArtifactIntegrityError,
  ArtifactKeyError,
  ArtifactManifestMismatchError,
  ArtifactNotFoundError,
  type ArtifactStore,
  artifactKeyFor,
  artifactObjectKeyFor,
  sha256Hex,
} from "../src/index.js";
import { createLocalArtifactStore } from "../src/local.js";
import {
  artifactId,
  captureFailure,
  createTemporaryRoot,
  manifestFor,
  objectPath,
  organizationId,
  otherOrganizationId,
  otherProjectId,
  projectId,
  runId,
} from "./support/fixtures.js";

const encoder = new TextEncoder();
const pendingRoots: string[] = [];

async function storeWithRoot(): Promise<{
  root: string;
  store: ArtifactStore;
}> {
  const root = await createTemporaryRoot();
  pendingRoots.push(root);
  return { root, store: createLocalArtifactStore({ root }) };
}

/** Bytes that only compare equal if every byte survived the round trip. */
const BINARY_EVIDENCE = Uint8Array.from([0, 1, 2, 65, 127, 128, 200, 254, 255]);

afterEach(async () => {
  await Promise.all(
    pendingRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("local artifact store", () => {
  it("round-trips the exact bytes under a tenant-scoped, content-addressed key", async () => {
    const { root, store } = await storeWithRoot();
    const digest = sha256Hex(BINARY_EVIDENCE);
    const expectedKey = artifactObjectKeyFor({
      artifactId,
      digest,
      organizationId,
      projectId,
    });

    const stored = await store.put({
      content: BINARY_EVIDENCE,
      manifest: manifestFor({ digest, size: BINARY_EVIDENCE.byteLength }),
      organizationId,
      projectId,
    });

    expect(stored).toEqual({
      bytes: BINARY_EVIDENCE.byteLength,
      digest,
      key: expectedKey,
    });
    expect(
      expectedKey.startsWith(
        `${artifactKeyFor({ artifactId, organizationId, projectId, runId })}/objects/`
      )
    ).toBe(true);
    expect(
      Array.from(
        await store.read({ key: stored.key, organizationId, projectId })
      )
    ).toEqual(Array.from(BINARY_EVIDENCE));
    // The bytes really are under the caller's tenant prefix inside the root.
    expect(Array.from(await readFile(objectPath(root, stored.key)))).toEqual(
      Array.from(BINARY_EVIDENCE)
    );
  });

  it("writes into an object directory a concurrent writer already created", async () => {
    const { root, store } = await storeWithRoot();
    const content = encoder.encode("evidence");
    const digest = sha256Hex(content);
    const key = artifactObjectKeyFor({
      artifactId,
      digest,
      organizationId,
      projectId,
    });
    await mkdir(dirname(objectPath(root, key)), { recursive: true });

    const stored = await store.put({
      content,
      manifest: manifestFor({ digest, size: content.byteLength }),
      organizationId,
      projectId,
    });

    expect(stored.key).toBe(key);
    expect(
      Array.from(await store.read({ key, organizationId, projectId }))
    ).toEqual(Array.from(content));
  });

  it("creates its root when the configured directory does not exist yet", async () => {
    const parent = await createTemporaryRoot();
    pendingRoots.push(parent);
    const root = `${parent}/nested/objects`;
    const store = createLocalArtifactStore({ root });
    const content = encoder.encode("evidence");
    const digest = sha256Hex(content);

    const stored = await store.put({
      content,
      manifest: manifestFor({ digest, size: content.byteLength }),
      organizationId,
      projectId,
    });

    expect(Array.from(await readFile(objectPath(root, stored.key)))).toEqual(
      Array.from(content)
    );
  });

  it("accepts a repeated put of identical bytes without writing again", async () => {
    const { root, store } = await storeWithRoot();
    const content = encoder.encode("evidence");
    const digest = sha256Hex(content);
    const input = {
      content,
      manifest: manifestFor({ digest, size: content.byteLength }),
      organizationId,
      projectId,
    };

    const first = await store.put(input);
    const second = await store.put(input);

    expect(second).toEqual(first);
    expect(Array.from(await readFile(objectPath(root, first.key)))).toEqual(
      Array.from(content)
    );
  });

  it("refuses a mutated object instead of returning its bytes", async () => {
    const { root, store } = await storeWithRoot();
    const content = encoder.encode("evidence");
    const digest = sha256Hex(content);
    const stored = await store.put({
      content,
      manifest: manifestFor({ digest, size: content.byteLength }),
      organizationId,
      projectId,
    });

    const mutated = encoder.encode("evilence");
    await writeFile(objectPath(root, stored.key), mutated);

    const failure = await captureFailure(() =>
      store.read({ key: stored.key, organizationId, projectId })
    );
    expect(failure).toBeInstanceOf(ArtifactIntegrityError);
    expect(failure).toMatchObject({
      actualDigest: sha256Hex(mutated),
      expectedDigest: digest,
      key: stored.key,
    });
  });

  it("refuses a truncated object instead of returning its bytes", async () => {
    const { root, store } = await storeWithRoot();
    const content = encoder.encode("evidence that was truncated");
    const digest = sha256Hex(content);
    const stored = await store.put({
      content,
      manifest: manifestFor({ digest, size: content.byteLength }),
      organizationId,
      projectId,
    });

    await writeFile(objectPath(root, stored.key), content.slice(0, 8));

    const failure = await captureFailure(() =>
      store.read({ key: stored.key, organizationId, projectId })
    );
    expect(failure).toBeInstanceOf(ArtifactIntegrityError);
    expect(failure).toMatchObject({ expectedDigest: digest });
  });

  it("never replaces the first object when a later put carries different bytes", async () => {
    const { root, store } = await storeWithRoot();
    const firstContent = encoder.encode("first revision");
    const secondContent = encoder.encode("second revision");

    const first = await store.put({
      content: firstContent,
      manifest: manifestFor({
        digest: sha256Hex(firstContent),
        size: firstContent.byteLength,
      }),
      organizationId,
      projectId,
    });
    const second = await store.put({
      content: secondContent,
      manifest: manifestFor({
        digest: sha256Hex(secondContent),
        size: secondContent.byteLength,
      }),
      organizationId,
      projectId,
    });

    expect(second.key).not.toBe(first.key);
    expect(
      Array.from(
        await store.read({ key: first.key, organizationId, projectId })
      )
    ).toEqual(Array.from(firstContent));
    expect(Array.from(await readFile(objectPath(root, first.key)))).toEqual(
      Array.from(firstContent)
    );
  });

  it("refuses to write over an object whose stored bytes no longer match its address", async () => {
    const { root, store } = await storeWithRoot();
    const content = encoder.encode("evidence");
    const digest = sha256Hex(content);
    const stored = await store.put({
      content,
      manifest: manifestFor({ digest, size: content.byteLength }),
      organizationId,
      projectId,
    });
    await writeFile(objectPath(root, stored.key), encoder.encode("tampered"));

    const failure = await captureFailure(() =>
      store.put({
        content,
        manifest: manifestFor({ digest, size: content.byteLength }),
        organizationId,
        projectId,
      })
    );

    expect(failure).toBeInstanceOf(ArtifactConflictError);
    expect(await readFile(objectPath(root, stored.key), "utf8")).toBe(
      "tampered"
    );
  });

  it("refuses a manifest that belongs to another tenant", async () => {
    const { store } = await storeWithRoot();
    const content = encoder.encode("evidence");
    const digest = sha256Hex(content);

    const failure = await captureFailure(() =>
      store.put({
        content,
        manifest: manifestFor({
          digest,
          organizationId: otherOrganizationId,
          size: content.byteLength,
        }),
        organizationId,
        projectId,
      })
    );

    expect(failure).toBeInstanceOf(ArtifactManifestMismatchError);
  });

  it("refuses a manifest that records a different digest for the object", async () => {
    const { store } = await storeWithRoot();
    const content = encoder.encode("evidence");
    const digest = sha256Hex(content);
    const key = artifactObjectKeyFor({
      artifactId,
      digest,
      organizationId,
      projectId,
    });

    const failure = await captureFailure(() =>
      store.put({
        content,
        manifest: manifestFor({
          digest,
          objectKey: key,
          sha256: "0".repeat(64),
          size: content.byteLength,
        }),
        organizationId,
        projectId,
      })
    );

    expect(failure).toBeInstanceOf(ArtifactManifestMismatchError);
  });

  it("refuses a run identifier that is not an identifier", async () => {
    const { store } = await storeWithRoot();
    const content = encoder.encode("evidence");
    const digest = sha256Hex(content);

    const failure = await captureFailure(() =>
      store.put({
        content,
        manifest: manifestFor({
          digest,
          runId: "../../escape" as typeof runId,
          size: content.byteLength,
        }),
        organizationId,
        projectId,
      })
    );

    expect(failure).toBeInstanceOf(ArtifactIdentifierError);
  });

  it("addresses an object the same way for every run of one artifact", async () => {
    const { store } = await storeWithRoot();
    const content = encoder.encode("evidence");
    const digest = sha256Hex(content);
    const runScoped = await store.put({
      content,
      manifest: manifestFor({ digest, runId, size: content.byteLength }),
      organizationId,
      projectId,
    });
    const projectScoped = await store.put({
      content,
      manifest: manifestFor({ digest, runId: null, size: content.byteLength }),
      organizationId,
      projectId,
    });

    // Run identity is manifest metadata: the key stays recomputable from the
    // artifact record PostgreSQL keeps, which carries no run identifier.
    expect(runScoped.key).toBe(
      artifactObjectKeyFor({ artifactId, digest, organizationId, projectId })
    );
    expect(projectScoped.key).toBe(runScoped.key);
  });

  it("refuses a read whose key belongs to another tenant", async () => {
    const { store } = await storeWithRoot();
    const content = encoder.encode("evidence");
    const stored = await store.put({
      content,
      manifest: manifestFor({
        digest: sha256Hex(content),
        size: content.byteLength,
      }),
      organizationId,
      projectId,
    });

    const crossOrganization = await captureFailure(() =>
      store.read({
        key: stored.key,
        organizationId: otherOrganizationId,
        projectId,
      })
    );
    const crossProject = await captureFailure(() =>
      store.read({
        key: stored.key,
        organizationId,
        projectId: otherProjectId,
      })
    );

    expect(crossOrganization).toBeInstanceOf(ArtifactKeyError);
    expect(crossProject).toBeInstanceOf(ArtifactKeyError);
  });

  it("reports a missing object as missing", async () => {
    const { store } = await storeWithRoot();
    const key = artifactObjectKeyFor({
      artifactId,
      digest: "a".repeat(64),
      organizationId,
      projectId,
    });

    const failure = await captureFailure(() =>
      store.read({ key, organizationId, projectId })
    );

    expect(failure).toBeInstanceOf(ArtifactNotFoundError);
  });

  it("refuses a key that addresses something other than an object", async () => {
    const { store } = await storeWithRoot();
    const manifestKey = `${artifactKeyFor({ artifactId, organizationId, projectId, runId: null })}/manifest.json`;

    const failure = await captureFailure(() =>
      store.read({ key: manifestKey, organizationId, projectId })
    );

    expect(failure).toBeInstanceOf(ArtifactKeyError);
  });
});
