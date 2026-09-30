import { createHash } from "node:crypto";
import {
  BuildSessionIdSchema,
  DeploymentExposureSchema,
} from "@reasonateai/contracts/execution";
import { ArtifactIdSchema } from "@reasonateai/contracts/execution-protocol";
import {
  IsoDateTimeSchema,
  OrganizationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
} from "@reasonateai/contracts/identity";
import { z } from "zod";

const SHA256_SCHEMA = z.string().regex(/^[a-f0-9]{64}$/);
const RELEASE_ID_SCHEMA = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);

/**
 * The release input is deliberately a digest and checkpoint reference rather
 * than source bytes. Bytes already live in the immutable artifact store; the
 * deployment layer must never silently rebuild a mutable workspace.
 */
export const ReleaseDescriptorSchema = z.strictObject({
  artifactDigest: SHA256_SCHEMA,
  artifactId: ArtifactIdSchema,
  buildSessionId: BuildSessionIdSchema,
  exposure: DeploymentExposureSchema,
  occurredAt: IsoDateTimeSchema,
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema,
  releaseId: RELEASE_ID_SCHEMA,
  runId: RunIdSchema,
  schemaVersion: z.literal(1),
  sourceCheckpoint: z.string().min(1).max(256),
});
export type ReleaseDescriptor = z.infer<typeof ReleaseDescriptorSchema>;

export interface ReleaseDescriptorInput
  extends Omit<ReleaseDescriptor, "occurredAt" | "schemaVersion"> {
  readonly occurredAt?: string;
}

export interface ImmutableReleaseDescriptor {
  readonly descriptor: Readonly<ReleaseDescriptor>;
  readonly descriptorDigest: string;
}

/**
 * Creates the signed-data equivalent used by providers and audit records.
 * The descriptor digest is over canonical JSON with a fixed property order,
 * so two providers cannot disagree about which release was promoted.
 */
export function createImmutableReleaseDescriptor(
  input: ReleaseDescriptorInput
): ImmutableReleaseDescriptor {
  const descriptor = ReleaseDescriptorSchema.parse({
    ...input,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    schemaVersion: 1,
  });
  const canonical = JSON.stringify(descriptor);

  return {
    descriptor: Object.freeze(descriptor),
    descriptorDigest: createHash("sha256").update(canonical).digest("hex"),
  };
}

export const isSha256Digest = (value: string): boolean =>
  SHA256_SCHEMA.safeParse(value).success;

export const isReleaseId = (value: string): boolean =>
  RELEASE_ID_SCHEMA.safeParse(value).success;
