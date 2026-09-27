import type { ArtifactManifest } from "@reasonateai/contracts/execution-protocol";
import type {
  OrganizationId,
  ProjectId,
} from "@reasonateai/contracts/identity";

/**
 * The provider-neutral contract of `@reasonateai/artifact-store`: the store
 * interface, the tenant-scoped key builders, digest helpers, the typed
 * refusals, and short-lived signed access. The filesystem implementation lives
 * behind `@reasonateai/artifact-store/local`.
 */

/** Everything `put` needs: the bytes, their validated description, and their tenant. */
export interface ArtifactPutInput {
  readonly content: Uint8Array;
  readonly manifest: ArtifactManifest;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
}

export interface ArtifactPutResult {
  /** Bytes accepted, as the caller handed them over. */
  readonly bytes: number;
  /** The sha256 of those bytes: the object's address and the manifest's record of it. */
  readonly digest: string;
  /** The content-addressed key the bytes live under. */
  readonly key: string;
}

export interface ArtifactReadInput {
  readonly key: string;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
}

/**
 * Provider-neutral immutable artifact storage. A store owns bytes only: the
 * manifest is their validated description, keys and URLs are never
 * authorization, and access is decided by centralized authorization before a
 * short-lived signed URL is issued.
 */
export interface ArtifactStore {
  readonly put: (input: ArtifactPutInput) => Promise<ArtifactPutResult>;
  readonly read: (input: ArtifactReadInput) => Promise<Uint8Array>;
}

// biome-ignore lint/performance/noBarrelFile: the package root is the frozen public entry point (the store contract is declared here); each concern still lives in the module that owns it.
export {
  type ArtifactAccessTokenPayload,
  type ArtifactSignInput,
  type ArtifactVerifyInput,
  signArtifactUrl,
  verifyArtifactUrl,
} from "./access.js";
export {
  ArtifactConflictError,
  ArtifactIdentifierError,
  ArtifactIntegrityError,
  ArtifactKeyError,
  ArtifactManifestMismatchError,
  ArtifactNotFoundError,
  ArtifactStoreError,
} from "./errors.js";
export {
  ARTIFACT_KEY_MAX_LENGTH,
  type ArtifactKeyInput,
  type ArtifactObjectKey,
  type ArtifactObjectKeyInput,
  artifactKeyFor,
  artifactObjectKeyFor,
  isSha256Digest,
  isUuid,
  parseArtifactObjectKey,
  requireTenantScopedKey,
  requireUuid,
  sha256Hex,
} from "./keys.js";
