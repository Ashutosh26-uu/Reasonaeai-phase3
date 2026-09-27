import { mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactIdentifierError,
  ArtifactKeyError,
  type ArtifactStore,
  artifactKeyFor,
  sha256Hex,
} from "../src/index.js";
import { createLocalArtifactStore } from "../src/local.js";
import {
  artifactId,
  captureFailure,
  createTemporaryRoot,
  manifestFor,
  organizationId,
  projectId,
  runId,
} from "./support/fixtures.js";

const encoder = new TextEncoder();
const pendingRoots: string[] = [];
const junctions: string[] = [];

async function storeWithRoot(): Promise<{
  root: string;
  store: ArtifactStore;
}> {
  const root = await createTemporaryRoot();
  pendingRoots.push(root);
  return { root, store: createLocalArtifactStore({ root }) };
}

/**
 * A directory link inside the store root that resolves outside it. Windows
 * needs no elevation for a junction, and `realpath` resolves it exactly like a
 * POSIX symlink, so this is the escape the containment check has to refuse.
 */
async function plantJunction(target: string, linkPath: string): Promise<void> {
  await mkdir(dirname(linkPath), { recursive: true });
  await symlink(target, linkPath, "junction");
  junctions.push(linkPath);
}

/** The directory a traversal attempt would have to reach to succeed. */
async function outsideRoot(): Promise<string> {
  const outside = await createTemporaryRoot();
  pendingRoots.push(outside);
  return outside;
}

afterEach(async () => {
  await Promise.all(
    junctions
      .splice(0)
      .map((junction) => rm(junction, { force: true, recursive: true }))
  );
  await Promise.all(
    pendingRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("artifact key safety", () => {
  it("refuses every key shape that could aim a read outside its tenant", async () => {
    const { store } = await storeWithRoot();
    const digest = "a".repeat(64);
    const prefix = `organizations/${organizationId}/projects/${projectId}/artifacts/${artifactId}`;
    const refused: { readonly key: string; readonly label: string }[] = [
      {
        key: `${prefix}/../../../../../../etc/passwd`,
        label: "traversal out of the tenant prefix",
      },
      {
        key: `${prefix}/objects/../../..//${digest}`,
        label: "traversal out of the object prefix",
      },
      {
        key: `/${prefix}/objects/${digest}`,
        label: "an absolute path",
      },
      {
        key: `\\${prefix.replaceAll("/", "\\")}\\objects\\${digest}`,
        label: "backslashes instead of separators",
      },
      {
        key: `organizations/${organizationId}/projects/${projectId}/artifacts/%2e%2e%2fobjects/${digest}`,
        label: "percent-encoded separators",
      },
      {
        key: `${prefix}/objects/${digest}\u0000`,
        label: "a trailing NUL",
      },
      {
        key: "C:/windows/system32/config/sam",
        label: "a drive-letter absolute path",
      },
      {
        key: `${prefix}/./objects/${digest}`,
        label: "a dot segment",
      },
      {
        key: `${prefix}/objects`,
        label: "a key with no digest",
      },
      {
        key: `organizations/${organizationId}/projects/${projectId}/runs/${runId}/artifacts/${artifactId}/objects/${digest}`,
        label: "a run-scoped address that is not an address this store mints",
      },
    ];

    const failures = await Promise.all(
      refused.map(async ({ key, label }) => ({
        failure: await captureFailure(() =>
          store.read({ key, organizationId, projectId })
        ),
        key,
        label,
      }))
    );

    for (const { failure, key, label } of failures) {
      expect(failure, label).toBeInstanceOf(ArtifactKeyError);
      expect(failure, label).toHaveProperty("key", key);
    }
  });

  it("refuses a read that reaches outside the root through a linked directory", async () => {
    const { root, store } = await storeWithRoot();
    const outside = await outsideRoot();
    const planted = encoder.encode("planted outside the root");
    const digest = sha256Hex(planted);
    await mkdir(join(outside, "objects"), { recursive: true });
    await writeFile(join(outside, "objects", digest), planted);
    // The digest matches the planted bytes, so the escape is the only reason
    // this read can fail.
    await plantJunction(
      outside,
      join(
        root,
        "organizations",
        organizationId,
        "projects",
        projectId,
        "artifacts",
        artifactId
      )
    );

    const key = `${artifactKeyFor({ artifactId, organizationId, projectId, runId: null })}/objects/${digest}`;
    const failure = await captureFailure(() =>
      store.read({ key, organizationId, projectId })
    );

    expect(failure).toBeInstanceOf(ArtifactKeyError);
  });

  it("refuses a read whose object path is itself a link out of the tenant", async () => {
    const { root, store } = await storeWithRoot();
    const outside = await outsideRoot();
    const key = `${artifactKeyFor({ artifactId, organizationId, projectId, runId: null })}/objects/${"b".repeat(64)}`;
    await plantJunction(outside, join(root, ...key.split("/")));

    const failure = await captureFailure(() =>
      store.read({ key, organizationId, projectId })
    );

    expect(failure).toBeInstanceOf(ArtifactKeyError);
  });

  it("refuses a write that would land outside the root through a linked directory", async () => {
    const { root, store } = await storeWithRoot();
    const outside = await outsideRoot();
    await plantJunction(
      outside,
      join(
        root,
        "organizations",
        organizationId,
        "projects",
        projectId,
        "artifacts",
        artifactId
      )
    );
    const content = encoder.encode("evidence");

    const failure = await captureFailure(() =>
      store.put({
        content,
        manifest: manifestFor({
          digest: sha256Hex(content),
          size: content.byteLength,
        }),
        organizationId,
        projectId,
      })
    );

    expect(failure).toBeInstanceOf(ArtifactKeyError);
    expect(await readdir(outside)).toEqual([]);
  });

  it("builds every prefix from the tenant scope and validates each identifier", () => {
    expect(
      artifactKeyFor({ artifactId, organizationId, projectId, runId: null })
    ).toBe(
      `organizations/${organizationId}/projects/${projectId}/artifacts/${artifactId}`
    );
    expect(
      artifactKeyFor({ artifactId, organizationId, projectId, runId })
    ).toBe(
      `organizations/${organizationId}/projects/${projectId}/artifacts/${artifactId}`
    );
    expect(() =>
      artifactKeyFor({
        artifactId: "../../escape" as typeof artifactId,
        organizationId,
        projectId,
        runId: null,
      })
    ).toThrow(ArtifactIdentifierError);
    expect(() =>
      artifactKeyFor({
        artifactId,
        organizationId: "../.." as typeof organizationId,
        projectId,
        runId: null,
      })
    ).toThrow(ArtifactIdentifierError);
    expect(() =>
      artifactKeyFor({
        artifactId,
        organizationId,
        projectId,
        runId: "../../escape" as typeof runId,
      })
    ).toThrow(ArtifactIdentifierError);
  });
});
