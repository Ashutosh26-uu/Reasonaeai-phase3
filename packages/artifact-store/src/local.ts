import {
  type FileHandle,
  mkdir,
  open,
  readFile,
  realpath,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ArtifactManifest } from "@reasonateai/contracts/execution-protocol";
import {
  ArtifactConflictError,
  ArtifactIntegrityError,
  ArtifactKeyError,
  ArtifactManifestMismatchError,
  ArtifactNotFoundError,
  ArtifactStoreError,
} from "./errors.js";
import type {
  ArtifactPutInput,
  ArtifactPutResult,
  ArtifactReadInput,
  ArtifactStore,
} from "./index.js";
import {
  type ArtifactObjectKey,
  artifactObjectKeyFor,
  parseArtifactObjectKey,
  requireUuid,
  sha256Hex,
} from "./keys.js";

export interface LocalArtifactStoreOptions {
  /** Directory that holds every tenant's objects. Created on first use. */
  readonly root: string;
}

/** An object path already proven to sit inside its tenant's directory. */
interface ContainedObjectTarget {
  readonly objectPath: string;
  readonly tenantDirectory: string;
}

/** Where a contained walk ended, and the boundary it stayed inside. */
interface DescendedPath {
  readonly boundary: string;
  readonly directory: string;
}

/** Exclusive creation: an existing object is verified, never rewritten. */
const CREATE_ONLY_FLAG = "wx";
const MANIFEST_SCHEMA_VERSION = 1;
const OBJECT_FILE_MODE = 0o600;
/** `organizations/<organizationId>/projects/<projectId>` — the tenant boundary. */
const TENANT_SEGMENT_COUNT = 4;

/**
 * A filesystem artifact store.
 *
 * Objects are content-addressed under `<root>/organizations/<organizationId>/
 * projects/<projectId>/artifacts/<artifactId>/objects/<sha256>`. Nothing a
 * caller supplies is joined into a path before it has been revalidated and
 * proven to resolve inside the caller's own tenant directory, and every read
 * rehashes the bytes and compares them with the digest the object's address
 * demands.
 */
export function createLocalArtifactStore(
  options: LocalArtifactStoreOptions
): ArtifactStore {
  if (typeof options.root !== "string" || options.root.trim().length === 0) {
    throw new ArtifactKeyError(
      options.root,
      "a store root must be a non-empty filesystem path"
    );
  }
  const requestedRoot = resolve(options.root);
  let resolvedRoot: Promise<string> | undefined;

  /**
   * Resolves the root once, through its symlinks, so every later containment
   * check compares like with like. A failed resolution is not cached: the
   * directory may simply not be creatable yet.
   */
  const ensureRoot = async (): Promise<string> => {
    if (resolvedRoot === undefined) {
      resolvedRoot = (async () => {
        await mkdir(requestedRoot, { recursive: true });
        return await realpath(requestedRoot);
      })().catch((error: unknown) => {
        resolvedRoot = undefined;
        throw error;
      });
    }
    return await resolvedRoot;
  };

  /**
   * A write target, confined to the caller's tenant directory. Each existing
   * ancestor is resolved and checked *before* anything below it is created, so
   * a link planted anywhere along the path cannot make directory creation (let
   * alone the object) land outside the tenant.
   */
  const resolveWriteTarget = async (
    objectKey: ArtifactObjectKey
  ): Promise<ContainedObjectTarget> => {
    const root = await ensureRoot();
    const descended = await descendContainedPath({
      boundary: root,
      current: root,
      key: objectKey.key,
      remaining: objectKey.segments.slice(0, -1),
      tenantDepth: TENANT_SEGMENT_COUNT,
    });

    return {
      objectPath: join(descended.directory, objectKey.digest),
      tenantDirectory: descended.boundary,
    };
  };

  /** The real, symlink-free path of an object the caller may read. */
  const resolveReadTarget = async (
    objectKey: ArtifactObjectKey
  ): Promise<string> => {
    const root = await ensureRoot();
    const tenantDirectory = await realpathIfPresent(
      join(
        root,
        "organizations",
        objectKey.organizationId,
        "projects",
        objectKey.projectId
      )
    );
    if (tenantDirectory === undefined) {
      throw new ArtifactNotFoundError(objectKey.key);
    }
    requireContained(root, tenantDirectory, objectKey.key);

    const target = join(root, ...objectKey.segments);
    requireContained(root, target, objectKey.key);

    const realTarget = await realpathIfPresent(target);
    if (realTarget === undefined) {
      throw new ArtifactNotFoundError(objectKey.key);
    }
    requireContained(tenantDirectory, realTarget, objectKey.key);
    return realTarget;
  };

  const read = async (input: ArtifactReadInput): Promise<Uint8Array> => {
    const organizationId = requireUuid("organizationId", input.organizationId);
    const projectId = requireUuid("projectId", input.projectId);
    const objectKey = parseArtifactObjectKey(input.key);
    if (objectKey.organizationId !== organizationId) {
      throw new ArtifactKeyError(
        input.key,
        "the key belongs to another organization"
      );
    }
    if (objectKey.projectId !== projectId) {
      throw new ArtifactKeyError(
        input.key,
        "the key belongs to another project"
      );
    }

    const target = await resolveReadTarget(objectKey);
    const content = await readFile(target);
    const actualDigest = sha256Hex(content);
    if (actualDigest !== objectKey.digest) {
      throw new ArtifactIntegrityError({
        actualDigest,
        expectedDigest: objectKey.digest,
        key: input.key,
      });
    }
    return content;
  };

  const put = async (input: ArtifactPutInput): Promise<ArtifactPutResult> => {
    const organizationId = requireUuid("organizationId", input.organizationId);
    const projectId = requireUuid("projectId", input.projectId);
    if (!(input.content instanceof Uint8Array)) {
      throw new ArtifactStoreError("Artifact content must be a Uint8Array.");
    }

    const artifactId = requireManifestScope(input.manifest, {
      organizationId,
      projectId,
    });
    const digest = sha256Hex(input.content);
    const key = artifactObjectKeyFor({
      artifactId,
      digest,
      organizationId,
      projectId,
    });
    requireDeclaredObject(input.manifest, {
      bytes: input.content.byteLength,
      digest,
      key,
    });

    const objectKey = parseArtifactObjectKey(key);
    const target = await resolveWriteTarget(objectKey);
    await writeImmutableObject(target, input.content, digest, key);
    return { bytes: input.content.byteLength, digest, key };
  };

  return { put, read };
}

/**
 * Creates the object once, exclusively. Content addressing means a key always
 * describes the same bytes: an existing object that hashes to the requested
 * digest makes the write idempotent, and one that does not is reported as a
 * conflict instead of being overwritten.
 */
async function writeImmutableObject(
  target: ContainedObjectTarget,
  content: Uint8Array,
  digest: string,
  key: string
): Promise<void> {
  const handle = await openExclusively(target.objectPath, key);
  if (handle === undefined) {
    // The object was already there. Re-resolve it so a link planted at the
    // object path cannot make this read (or this write) leave the tenant.
    const realTarget = await realpathIfPresent(target.objectPath);
    if (realTarget === undefined) {
      throw new ArtifactNotFoundError(key);
    }
    requireContained(target.tenantDirectory, realTarget, key);
    const existingDigest = sha256Hex(await readFile(realTarget));
    if (existingDigest !== digest) {
      throw new ArtifactConflictError({
        existingDigest,
        incomingDigest: digest,
        key,
      });
    }
    return;
  }

  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
}

/**
 * The manifest and the caller's scope have to agree before anything is
 * written: a manifest describing another tenant is a mis-addressed write, not
 * a different address.
 */
function requireManifestScope(
  manifest: ArtifactManifest,
  scope: { readonly organizationId: string; readonly projectId: string }
): string {
  if (typeof manifest !== "object" || manifest === null) {
    throw new ArtifactManifestMismatchError("a manifest is required");
  }
  const organizationId = requireUuid(
    "manifest.organizationId",
    manifest.organizationId
  );
  const projectId = requireUuid("manifest.projectId", manifest.projectId);
  if (
    organizationId !== scope.organizationId ||
    projectId !== scope.projectId
  ) {
    throw new ArtifactManifestMismatchError(
      `the manifest belongs to ${organizationId}/${projectId}, not to the caller's ${scope.organizationId}/${scope.projectId}`
    );
  }
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new ArtifactManifestMismatchError(
      `manifest schemaVersion must be ${MANIFEST_SCHEMA_VERSION}`
    );
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new ArtifactManifestMismatchError(
      "a manifest has to describe at least one file"
    );
  }
  if (manifest.runId !== null && manifest.runId !== undefined) {
    requireUuid("manifest.runId", manifest.runId);
  }

  return requireUuid("manifest.artifactId", manifest.artifactId);
}

/**
 * When the manifest already names the object being written, the digest and
 * size it records have to be the ones arriving: the manifest is what a later
 * read verifies the bytes against.
 */
function requireDeclaredObject(
  manifest: ArtifactManifest,
  object: {
    readonly bytes: number;
    readonly digest: string;
    readonly key: string;
  }
): void {
  for (const file of manifest.files) {
    if (file.objectKey !== object.key) {
      continue;
    }
    if (file.sha256 !== object.digest || file.size !== object.bytes) {
      throw new ArtifactManifestMismatchError(
        `the manifest records ${file.sha256} (${file.size} bytes) for ${object.key} but the content hashes to ${object.digest} (${object.bytes} bytes)`
      );
    }
  }
}

/**
 * Walks an object's parent path one segment at a time, creating only what is
 * missing. Every existing ancestor is resolved and checked before anything
 * below it is created, so a link planted anywhere along the path cannot make
 * this walk — or the write that follows it — leave the boundary it started
 * from. `tenantDepth` counts how many of the remaining segments still belong to
 * the tenant prefix: the tenant's own real directory becomes the boundary as
 * soon as they are consumed, which also refuses a link into a sibling tenant.
 */
async function descendContainedPath(input: {
  readonly boundary: string;
  readonly current: string;
  readonly key: string;
  readonly remaining: readonly string[];
  readonly tenantDepth: number;
}): Promise<DescendedPath> {
  const [segment, ...rest] = input.remaining;
  if (segment === undefined) {
    return { boundary: input.boundary, directory: input.current };
  }

  const next = join(input.current, segment);
  const existing = await realpathIfPresent(next);
  if (existing !== undefined) {
    requireContained(input.boundary, existing, input.key);
  }
  const resolved =
    existing ??
    (await createContainedDirectory({
      boundary: input.boundary,
      key: input.key,
      path: next,
    }));

  return await descendContainedPath({
    boundary: input.tenantDepth === 1 ? resolved : input.boundary,
    current: resolved,
    key: input.key,
    remaining: rest,
    tenantDepth: Math.max(input.tenantDepth - 1, 0),
  });
}

/**
 * Creates one directory segment and returns its real path. A concurrent writer
 * that got there first is not an error, but whatever is now there is resolved
 * and re-checked, so a race cannot smuggle a link past the boundary.
 */
async function createContainedDirectory(input: {
  readonly boundary: string;
  readonly key: string;
  readonly path: string;
}): Promise<string> {
  try {
    await mkdir(input.path);
  } catch (error) {
    if (errorCodeOf(error) !== "EEXIST") {
      throw error;
    }
  }

  const created = await realpathIfPresent(input.path);
  if (created === undefined) {
    throw new ArtifactStoreError(
      `Could not create the artifact directory ${JSON.stringify(input.path)}.`
    );
  }
  requireContained(input.boundary, created, input.key);
  return created;
}

/**
 * A resolved path must stay inside the directory this operation is scoped to,
 * or it is refused. This is the second half of traversal defence: the first
 * half refuses the key, this half refuses the filesystem.
 */
function requireContained(
  parent: string,
  candidate: string,
  key: string
): void {
  const relativePath = relative(parent, candidate);
  if (relativePath === "") {
    return;
  }
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new ArtifactKeyError(
      key,
      "the resolved path escapes the tenant prefix"
    );
  }
}

/**
 * The real, symlink-free path of something that exists, or `undefined` when it
 * does not. Every caller decides for itself whether absence is a refusal or an
 * instruction to create.
 */
async function realpathIfPresent(
  targetPath: string
): Promise<string | undefined> {
  try {
    return await realpath(targetPath);
  } catch (error) {
    if (errorCodeOf(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function openExclusively(
  targetPath: string,
  key: string
): Promise<FileHandle | undefined> {
  try {
    return await open(targetPath, CREATE_ONLY_FLAG, OBJECT_FILE_MODE);
  } catch (error) {
    if (errorCodeOf(error) === "EEXIST") {
      return undefined;
    }
    throw new ArtifactStoreError(
      `Could not create the artifact object ${JSON.stringify(key)}.`,
      { cause: error }
    );
  }
}

function errorCodeOf(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const { code } = error as NodeJS.ErrnoException;
  return typeof code === "string" ? code : undefined;
}
