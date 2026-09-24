import { z } from "zod";
import {
  BuildSessionIdSchema,
  DeploymentExposureSchema,
  SandboxEnvironmentIdSchema,
} from "./execution.js";
import {
  IsoDateTimeSchema,
  OrganizationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  WorkloadIdSchema,
} from "./identity.js";

export const RunEventIdSchema = z.uuid().brand<"RunEventId">();
export type RunEventId = z.infer<typeof RunEventIdSchema>;

export const RunCommandIdSchema = z.uuid().brand<"RunCommandId">();
export type RunCommandId = z.infer<typeof RunCommandIdSchema>;

export const RunLeaseIdSchema = z.uuid().brand<"RunLeaseId">();
export type RunLeaseId = z.infer<typeof RunLeaseIdSchema>;

export const ArtifactIdSchema = z.uuid().brand<"ArtifactId">();
export type ArtifactId = z.infer<typeof ArtifactIdSchema>;

export const IdempotencyKeySchema = z.string().min(8).max(128);

export const RunStatusSchema = z.enum([
  "queued",
  "leased",
  "running",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunCommandTypeSchema = z.enum([
  "run.start",
  "run.message",
  "run.approval.resolve",
  "run.cancel",
]);
export type RunCommandType = z.infer<typeof RunCommandTypeSchema>;

export const RunEventTypeSchema = z.enum([
  "run.queued",
  "run.claimed",
  "sandbox.allocated",
  "agent.started",
  "agent.progress",
  "task.updated",
  "approval.requested",
  "approval.resolved",
  "artifact.recorded",
  "verification.started",
  "verification.passed",
  "verification.failed",
  "preview.ready",
  "deployment.started",
  "deployment.ready",
  "deployment.failed",
  "run.completed",
  "run.failed",
  "run.cancelled",
]);
export type RunEventType = z.infer<typeof RunEventTypeSchema>;

const JsonPayloadSchema = z.record(z.string(), z.unknown());

/**
 * An authorized unit of work handed to the private execution plane. It carries
 * references and authority metadata only: never a browser cookie, a plaintext
 * secret, or an unbounded prompt payload.
 */
export const RunCommandEnvelopeSchema = z.strictObject({
  buildSessionId: BuildSessionIdSchema,
  commandId: RunCommandIdSchema,
  expiresAt: IsoDateTimeSchema,
  idempotencyKey: IdempotencyKeySchema,
  issuedAt: IsoDateTimeSchema,
  organizationId: OrganizationIdSchema,
  payload: JsonPayloadSchema,
  projectId: ProjectIdSchema,
  runId: RunIdSchema,
  schemaVersion: z.literal(1),
  type: RunCommandTypeSchema,
  workloadGrantId: WorkloadIdSchema,
});
export type RunCommandEnvelope = z.infer<typeof RunCommandEnvelopeSchema>;

/**
 * A durable, browser-visible transition. `sequence` is monotonic per run so a
 * reconnecting client can request everything after its last seen sequence.
 */
export const RunEventEnvelopeSchema = z.strictObject({
  eventId: RunEventIdSchema,
  occurredAt: IsoDateTimeSchema,
  organizationId: OrganizationIdSchema,
  payload: JsonPayloadSchema,
  projectId: ProjectIdSchema,
  runId: RunIdSchema,
  schemaVersion: z.literal(1),
  sequence: z.number().int().nonnegative(),
  type: RunEventTypeSchema,
});
export type RunEventEnvelope = z.infer<typeof RunEventEnvelopeSchema>;

export const RunLeaseSchema = z.strictObject({
  expiresAt: IsoDateTimeSchema,
  holder: z.string().min(1).max(128),
  leaseId: RunLeaseIdSchema,
  runId: RunIdSchema,
});
export type RunLease = z.infer<typeof RunLeaseSchema>;

export const ArtifactFileSchema = z.strictObject({
  mediaType: z.string().min(1).max(128),
  objectKey: z.string().min(1).max(1024),
  path: z.string().min(1).max(1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
});
export type ArtifactFile = z.infer<typeof ArtifactFileSchema>;

/**
 * A logical artifact may contain many files. Bytes live in private object
 * storage; this manifest is the validated description of them.
 */
export const ArtifactManifestSchema = z.strictObject({
  artifactId: ArtifactIdSchema,
  buildSessionId: BuildSessionIdSchema.nullable(),
  files: z.array(ArtifactFileSchema).min(1),
  kind: z.string().min(1).max(64),
  occurredAt: IsoDateTimeSchema,
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema,
  runId: RunIdSchema.nullable(),
  schemaVersion: z.literal(1),
  totalSize: z.number().int().nonnegative(),
});
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;

export const PreviewDescriptorSchema = z.strictObject({
  buildSessionId: BuildSessionIdSchema,
  expiresAt: IsoDateTimeSchema,
  organizationId: OrganizationIdSchema,
  port: z.number().int().min(1).max(65_535),
  previewId: z.string().regex(/^[a-z0-9]{16,64}$/),
  projectId: ProjectIdSchema,
  sandboxEnvironmentId: SandboxEnvironmentIdSchema,
});
export type PreviewDescriptor = z.infer<typeof PreviewDescriptorSchema>;

export const ReleaseDescriptorSchema = z.strictObject({
  artifactId: ArtifactIdSchema,
  buildSessionId: BuildSessionIdSchema,
  exposure: DeploymentExposureSchema,
  occurredAt: IsoDateTimeSchema,
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema,
  runId: RunIdSchema,
  sourceCheckpoint: z.string().min(1).max(256),
  url: z.url(),
});
export type ReleaseDescriptor = z.infer<typeof ReleaseDescriptorSchema>;

export const runEventTopic = (runId: string): string =>
  `reasonateai.run.events.${runId}`;

export const runCommandTopic = "reasonateai.run.commands";

/**
 * A reconnect may only resume from a sequence the run has actually produced.
 * Sequence zero is the "deliver everything retained" cursor.
 */
export function isReplayableSequence(afterSequence: number): boolean {
  return Number.isInteger(afterSequence) && afterSequence >= 0;
}
