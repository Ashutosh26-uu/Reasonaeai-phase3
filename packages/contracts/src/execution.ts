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
  url: z.url().nullable(),
});
export type Deployment = z.infer<typeof DeploymentSchema>;

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
