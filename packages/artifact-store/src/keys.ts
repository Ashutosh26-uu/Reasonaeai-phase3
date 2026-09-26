import { createHash } from "node:crypto";
import type { ArtifactId } from "@reasonateai/contracts/execution-protocol";
import type {
  OrganizationId,
  ProjectId,
  RunId,
} from "@reasonateai/contracts/identity";
import { ArtifactIdentifierError, ArtifactKeyError } from "./errors.js";

/** Every key this package mints or accepts is addressable within these bounds. */
export const ARTIFACT_KEY_MAX_LENGTH = 1024;

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const KEY_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const MAX_KEY_SEGMENT_LENGTH = 128;
const OBJECT_SEGMENT = "objects";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The frozen key contract: tenant scope plus the artifact's identity. */
export interface ArtifactKeyInput {
  readonly artifactId: ArtifactId;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly runId: RunId | null;
}

/** The parts an object key is addressed by, as a durable record can supply them. */
export interface ArtifactObjectKeyInput {
  readonly artifactId: string;
  readonly digest: string;
  readonly organizationId: string;
  readonly projectId: string;
}

/** A parsed object key, with every part revalidated. */
export interface ArtifactObjectKey {
  readonly artifactId: string;
  readonly digest: string;
  readonly key: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly segments: readonly string[];
}

interface SplitKey {
  readonly key: string;
  readonly segments: string[];
}

export const sha256Hex = (content: Uint8Array): string =>
  createHash("sha256").update(content).digest("hex");

export const isSha256Digest = (value: string): boolean =>
  DIGEST_PATTERN.test(value);

export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID_PATTERN.test(value);

/**
 * Revalidates an identifier at the system boundary. Identifiers arrive as
 * branded types from callers, but a brand is a compile-time claim: a forged
 * value must not be able to aim a write at another organization's directory.
 * The canonical (lower-case) form is what keys are built from.
 */
export const requireUuid = (field: string, value: unknown): string => {
  if (!isUuid(value)) {
    throw new ArtifactIdentifierError(field, value);
  }
  return value.toLowerCase();
};

/**
 * The tenant-scoped prefix every one of an artifact's objects lives under.
 *
 * `runId` is accepted because the frozen call shape carries it, and a forged
 * run identifier must not pass silently, but it is deliberately not a path
 * segment: PostgreSQL records an artifact's manifest path as
 * `organizations/<organizationId>/projects/<projectId>/artifacts/<artifactId>`
 * with no run scope, and an access path has to recompute an object key from
 * that record alone. Run identity stays in the manifest and the run ledger.
 *
 * Tenant scope comes first so an object path can be authorized and audited
 * from its prefix alone.
 */
export const artifactKeyFor = (input: ArtifactKeyInput): string =>
  artifactPrefix(input);

/**
 * The content-addressed key of one object: the artifact's tenant-scoped prefix
 * plus the sha256 of its bytes. This is what `put` stores under and returns,
 * and what an access path recomputes from the metadata recorded for an
 * artifact (`artifactId`, `sha256`, organization, project).
 */
export const artifactObjectKeyFor = (input: ArtifactObjectKeyInput): string => {
  const { digest } = input;
  if (typeof digest !== "string" || !DIGEST_PATTERN.test(digest)) {
    throw new ArtifactKeyError(
      digest,
      "an object key is addressed by a lower-case sha256 digest"
    );
  }
  return [artifactPrefix(input), OBJECT_SEGMENT, digest].join("/");
};

/**
 * Parses a content-addressed object key and revalidates every part of it.
 * Only keys in this exact shape are readable, which is what makes the recorded
 * digest checkable at read time and the tenant prefix unambiguous.
 */
export const parseArtifactObjectKey = (key: unknown): ArtifactObjectKey => {
  const { key: text, segments } = splitKey(key);
  const [
    organizationsSegment,
    rawOrganizationId,
    projectsSegment,
    rawProjectId,
    artifactsSegment,
    rawArtifactId,
    objectsSegment,
    digest,
    ...extra
  ] = segments;
  if (
    digest === undefined ||
    extra.length > 0 ||
    organizationsSegment !== "organizations" ||
    projectsSegment !== "projects" ||
    artifactsSegment !== "artifacts" ||
    objectsSegment !== OBJECT_SEGMENT
  ) {
    throw new ArtifactKeyError(
      text,
      "an object key is organizations/<organizationId>/projects/<projectId>/artifacts/<artifactId>/objects/<sha256>"
    );
  }

  const organizationId = requireKeyIdentifier(
    text,
    "organizationId",
    rawOrganizationId
  );
  const projectId = requireKeyIdentifier(text, "projectId", rawProjectId);
  const artifactId = requireKeyIdentifier(text, "artifactId", rawArtifactId);
  if (!DIGEST_PATTERN.test(digest)) {
    throw new ArtifactKeyError(
      text,
      `object digest ${JSON.stringify(digest)} is not a lower-case sha256 digest`
    );
  }

  return {
    artifactId,
    digest,
    key: text,
    organizationId,
    projectId,
    segments,
  };
};

/**
 * A key a signed token may name has to live inside the organization that
 * signs it: a token over another tenant's key is one this package has no
 * reason to mint.
 */
export const requireTenantScopedKey = (
  key: unknown,
  organizationId: unknown
): string => {
  const organization = requireUuid("organizationId", organizationId);
  const { key: text, segments } = splitKey(key);
  if (segments[0] !== "organizations" || segments[1] !== organization) {
    throw new ArtifactKeyError(
      text,
      "a key has to live under organizations/<organizationId>/"
    );
  }
  return text;
};

/**
 * Keys are composed from validated identifiers and a digest only. Nothing a
 * caller passes reaches a path verbatim.
 */
function artifactPrefix(input: {
  readonly artifactId: unknown;
  readonly organizationId: unknown;
  readonly projectId: unknown;
  readonly runId?: unknown;
}): string {
  const organizationId = requireUuid("organizationId", input.organizationId);
  const projectId = requireUuid("projectId", input.projectId);
  const artifactId = requireUuid("artifactId", input.artifactId);
  if (input.runId !== null && input.runId !== undefined) {
    requireUuid("runId", input.runId);
  }

  return [
    "organizations",
    organizationId,
    "projects",
    projectId,
    "artifacts",
    artifactId,
  ].join("/");
}

function requireKeyIdentifier(
  key: string,
  field: string,
  value: unknown
): string {
  if (!isUuid(value)) {
    throw new ArtifactKeyError(key, `the ${field} segment is not a UUID`);
  }
  return value.toLowerCase();
}

function requireKeyText(key: unknown): string {
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > ARTIFACT_KEY_MAX_LENGTH
  ) {
    throw new ArtifactKeyError(
      key,
      `a key must be a non-empty string of at most ${ARTIFACT_KEY_MAX_LENGTH} characters`
    );
  }
  return key;
}

/**
 * Splits a key and refuses any character, segment, or shape this store never
 * mints. An absolute path, a backslash, a `..` segment, a percent-encoded
 * separator, a NUL, or a drive letter fails here, before any path is joined.
 */
function splitKey(key: unknown): SplitKey {
  const text = requireKeyText(key);
  const segments = text.split("/");
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new ArtifactKeyError(text, "keys cannot carry empty path segments");
    }
    if (segment.length > MAX_KEY_SEGMENT_LENGTH) {
      throw new ArtifactKeyError(
        text,
        `path segments are limited to ${MAX_KEY_SEGMENT_LENGTH} characters`
      );
    }
    if (!KEY_SEGMENT_PATTERN.test(segment)) {
      throw new ArtifactKeyError(
        text,
        `segment ${JSON.stringify(segment)} uses characters this store never mints`
      );
    }
  }
  return { key: text, segments };
}
