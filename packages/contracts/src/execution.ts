import { z } from "zod";
import {
  IsoDateTimeSchema,
  OrganizationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  SessionIdSchema,
} from "./identity.js";

export const BuildSessionIdSchema = z.uuid().brand<"BuildSessionId">();
export type BuildSessionId = z.infer<typeof BuildSessionIdSchema>;

export const SandboxEnvironmentIdSchema = z
  .uuid()
  .brand<"SandboxEnvironmentId">();
export type SandboxEnvironmentId = z.infer<typeof SandboxEnvironmentIdSchema>;

export const DeploymentIdSchema = z.uuid().brand<"DeploymentId">();
export type DeploymentId = z.infer<typeof DeploymentIdSchema>;

export const BuildSessionStatusSchema = z.enum([
  "provisioning",
  "ready",
  "running",
  "awaiting_approval",
  "blocked",
  "completed",
  "failed",
  "cancelled",
]);
export type BuildSessionStatus = z.infer<typeof BuildSessionStatusSchema>;

export const ProductLifecycleStageSchema = z.enum([
  "intake",
  "specification",
  "plan_approval",
  "architecture",
  "implementation",
  "runtime_verification",
  "security_verification",
  "deployment",
  "released",
]);
export type ProductLifecycleStage = z.infer<typeof ProductLifecycleStageSchema>;

export const SandboxEnvironmentStatusSchema = z.enum([
  "allocating",
  "ready",
  "running",
  "stopped",
  "destroying",
  "destroyed",
  "failed",
]);
export type SandboxEnvironmentStatus = z.infer<
  typeof SandboxEnvironmentStatusSchema
>;

export const DeploymentStatusSchema = z.enum([
  "pending",
  "building",
  "deploying",
  "ready",
  "failed",
  "superseded",
  "rolled_back",
]);
export type DeploymentStatus = z.infer<typeof DeploymentStatusSchema>;

export const DeploymentExposureSchema = z.enum([
  "authenticated",
  "unlisted",
  "public",
]);
export type DeploymentExposure = z.infer<typeof DeploymentExposureSchema>;

export const BuildSessionSchema = z.strictObject({
  buildSessionId: BuildSessionIdSchema,
  createdAt: IsoDateTimeSchema,
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema,
  runId: RunIdSchema,
  sandboxEnvironmentId: SandboxEnvironmentIdSchema.nullable(),
  stage: ProductLifecycleStageSchema,
  status: BuildSessionStatusSchema,
  updatedAt: IsoDateTimeSchema,
  userSessionId: SessionIdSchema,
});
export type BuildSession = z.infer<typeof BuildSessionSchema>;

export const AllocateBuildSessionRequestSchema = z.strictObject({
  idempotencyKey: z.string().min(1).max(128),
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema,
  userSessionId: SessionIdSchema,
});
export type AllocateBuildSessionRequest = z.infer<
  typeof AllocateBuildSessionRequestSchema
>;

export const SandboxEnvironmentSchema = z.strictObject({
  buildSessionId: BuildSessionIdSchema,
  createdAt: IsoDateTimeSchema,
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema,
  sandboxEnvironmentId: SandboxEnvironmentIdSchema,
  status: SandboxEnvironmentStatusSchema,
  updatedAt: IsoDateTimeSchema,
  workspaceUri: z.string().startsWith("sandbox://").max(2048),
});
export type SandboxEnvironment = z.infer<typeof SandboxEnvironmentSchema>;

export const BuildSessionAllocationSchema = z.strictObject({
  buildSession: BuildSessionSchema,
  created: z.boolean(),
  sandbox: SandboxEnvironmentSchema,
});
export type BuildSessionAllocation = z.infer<
  typeof BuildSessionAllocationSchema
>;

export const DeploymentSchema = z.strictObject({
  createdAt: IsoDateTimeSchema,
  deploymentId: DeploymentIdSchema,
  exposure: DeploymentExposureSchema,
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema,
  providerReference: z.string().min(1).max(512),
  rollbackDeploymentId: DeploymentIdSchema.nullable(),
  runId: RunIdSchema,
  sourceCheckpoint: z.string().min(1).max(256),
  status: DeploymentStatusSchema,
  updatedAt: IsoDateTimeSchema,
  url: z.string().url().nullable(),
});
export type Deployment = z.infer<typeof DeploymentSchema>;

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

export const CheckpointIdSchema = z.uuid().brand<"CheckpointId">();
export type CheckpointId = z.infer<typeof CheckpointIdSchema>;

/**
 * A Git snapshot captured inside the build-session sandbox by the CTO agent
 * running `git commit`. Not a Docker-layer snapshot —
 * MastraWorkspaceSandboxAdapter.supportsCheckpoints is false.
 */
export const GitCheckpointSchema = z.strictObject({
  author: z.string().min(1).max(256),
  buildSessionId: BuildSessionIdSchema,
  checkpointId: CheckpointIdSchema,
  commitHash: z.string().regex(/^[a-f0-9]{40}$/),
  message: z.string().min(1).max(512),
  occurredAt: IsoDateTimeSchema,
  organizationId: OrganizationIdSchema,
  parentHash: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .nullable(),
  projectId: ProjectIdSchema,
  runId: RunIdSchema,
});
export type GitCheckpoint = z.infer<typeof GitCheckpointSchema>;

// ---------------------------------------------------------------------------
// Failure details — shared by Preview and Deployment
// ---------------------------------------------------------------------------

/**
 * Structured failure information attached to a resource that entered an error
 * or failed state. Shared schema so the frontend can render a consistent
 * failure card regardless of which resource type failed.
 */
export const FailureDetailsSchema = z.strictObject({
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(1024),
  occurredAt: IsoDateTimeSchema,
  recoverable: z.boolean(),
  stack: z.string().max(4096).nullable(),
  step: z.string().max(128).nullable(),
});
export type FailureDetails = z.infer<typeof FailureDetailsSchema>;

// ---------------------------------------------------------------------------
// Preview session
// ---------------------------------------------------------------------------

export const PreviewIdSchema = z.uuid().brand<"PreviewId">();
export type PreviewId = z.infer<typeof PreviewIdSchema>;

export const PreviewStatusSchema = z.enum([
  "allocating",
  "ready",
  "degraded",
  "stopped",
  "failed",
]);
export type PreviewStatus = z.infer<typeof PreviewStatusSchema>;

/**
 * A live preview of the user's application running inside the build-session
 * Docker sandbox.
 *
 * Field notes:
 * - `sandboxId`  — string produced by sandboxIdFor(scope), passed as
 *   SandboxConfig.id to the ISandbox instance.
 * - `sandboxEnvironmentId` — UUID FK to the authoritative sandbox_environments
 *   PostgreSQL row.
 * - `healthUrl`  — polled via ISandbox.runCommand inside the container network;
 *   not a public URL.
 * - `proxyUrl`   — null until a preview gateway is available; the frontend
 *   renders a placeholder when null.
 */
export const PreviewSessionSchema = z.strictObject({
  buildSessionId: BuildSessionIdSchema,
  createdAt: IsoDateTimeSchema,
  errorDetails: FailureDetailsSchema.nullable(),
  expiresAt: IsoDateTimeSchema,
  healthUrl: z.string().url().nullable(),
  organizationId: OrganizationIdSchema,
  port: z.number().int().min(1).max(65_535),
  previewId: PreviewIdSchema,
  projectId: ProjectIdSchema,
  proxyUrl: z.string().url().nullable(),
  sandboxEnvironmentId: SandboxEnvironmentIdSchema,
  sandboxId: z.string().min(1).max(128),
  status: PreviewStatusSchema,
  updatedAt: IsoDateTimeSchema,
});
export type PreviewSession = z.infer<typeof PreviewSessionSchema>;

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export const EvidenceIdSchema = z.uuid().brand<"EvidenceId">();
export type EvidenceId = z.infer<typeof EvidenceIdSchema>;

export const evidenceKinds = [
  "console_log",
  "network_trace",
  "screenshot",
  "test_report",
  "dom_snapshot",
  "security_audit",
] as const;
export const EvidenceKindSchema = z.enum(evidenceKinds);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

export const EvidenceStatusSchema = z.enum([
  "passed",
  "failed",
  "warning",
  "info",
]);
export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>;

/**
 * Metadata row for a single piece of runtime evidence captured by the CTO
 * agent. The raw bytes live in private object storage; `artifactId` is the
 * UUID foreign-key to the artifacts table manifest row.
 */
export const EvidenceRecordSchema = z.strictObject({
  /** UUID FK to the artifacts table row that holds the raw bytes. */
  artifactId: z.uuid(),
  buildSessionId: BuildSessionIdSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  evidenceId: EvidenceIdSchema,
  kind: EvidenceKindSchema,
  metadata: z.record(z.string(), z.unknown()),
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema,
  runId: RunIdSchema.nullable(),
  status: EvidenceStatusSchema,
  summary: z.string().min(1).max(1024),
});
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

// ---------------------------------------------------------------------------
// Deployment request helpers
// ---------------------------------------------------------------------------

/**
 * Request body for POST /v1/projects/:projectId/deployments.
 * providerReference is opaque — no concrete provider is hard-coded.
 */
export const CreateDeploymentRequestSchema = z.strictObject({
  exposure: DeploymentExposureSchema,
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema,
  providerReference: z.string().min(1).max(512),
  sourceCheckpoint: z.string().min(1).max(256),
});
export type CreateDeploymentRequest = z.infer<
  typeof CreateDeploymentRequestSchema
>;

/**
 * Request body for POST /v1/deployments/:deploymentId/rollback.
 */
export const RollbackDeploymentRequestSchema = z.strictObject({
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema,
  reason: z.string().max(512),
  targetDeploymentId: DeploymentIdSchema,
});
export type RollbackDeploymentRequest = z.infer<
  typeof RollbackDeploymentRequestSchema
>;

// ---------------------------------------------------------------------------
// Lifecycle helpers (unchanged)
// ---------------------------------------------------------------------------

const lifecycleOrder = ProductLifecycleStageSchema.options;

export function canAdvanceProductLifecycle(
  from: ProductLifecycleStage,
  to: ProductLifecycleStage
): boolean {
  const fromIndex = lifecycleOrder.indexOf(from);
  const toIndex = lifecycleOrder.indexOf(to);
  return toIndex === fromIndex || toIndex === fromIndex + 1;
}

export function isShareableDeployment(
  deployment: Deployment
): deployment is Deployment & { status: "ready"; url: string } {
  return deployment.status === "ready" && deployment.url !== null;
}
