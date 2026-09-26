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
  /**
   * The opening message of the conversation. A build session is the project's
   * conversation with its CTO, so allocating one is how a conversation starts:
   * the first turn is recorded on the session's first run and reaches the agent
   * as the user's own words. Omitted means the session is allocated without an
   * opening turn, which leaves its run on the default dispatch directive.
   */
  message: z.string().min(1).max(20_000).optional(),
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

/**
 * The identifier of the Mastra thread that carries a build session's
 * conversation.
 *
 * A conversation is a build session, and a build session belongs to exactly one
 * project, so the thread is derived from the session identifier rather than
 * stored beside it: the API that lists conversations and the worker that drives
 * one resolve the same thread without a coordination write, and a restart cannot
 * lose the binding. Messages live in the durable Mastra store under this thread
 * id, keyed by the project as their memory resource.
 */
export function conversationThreadId(buildSessionId: BuildSessionId): string {
  return buildSessionId;
}

export const ConversationMessageRoleSchema = z.enum([
  "assistant",
  "system",
  "tool",
  "user",
]);
export type ConversationMessageRole = z.infer<
  typeof ConversationMessageRoleSchema
>;

/**
 * One durable message of a conversation, as the browser reads it. The model's
 * internal parts are reduced to the text a person is meant to read.
 */
export const ConversationMessageSchema = z.strictObject({
  createdAt: IsoDateTimeSchema,
  id: z.string().min(1).max(256),
  role: ConversationMessageRoleSchema,
  text: z.string().max(1_000_000),
});
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;

export const ConversationHistorySchema = z.strictObject({
  messages: z.array(ConversationMessageSchema),
});

/**
 * One conversation of a project. `title` is the generated one when a title
 * exists, and null while the conversation has not been titled yet.
 */
export const ConversationSummarySchema = z.strictObject({
  buildSessionId: BuildSessionIdSchema,
  createdAt: IsoDateTimeSchema,
  /** The newest run of this conversation, whether or not it has ended. */
  latestRunId: RunIdSchema,
  /** The run a client should follow, or null when no run is in flight. */
  pendingRunId: RunIdSchema.nullable(),
  status: BuildSessionStatusSchema,
  title: z.string().min(1).max(500).nullable(),
  updatedAt: IsoDateTimeSchema,
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

export const ConversationListSchema = z.strictObject({
  conversations: z.array(ConversationSummarySchema),
});

/** A turn the user submits into an existing conversation. */
export const AppendConversationTurnRequestSchema = z.strictObject({
  message: z.string().min(1).max(20_000),
});
export type AppendConversationTurnRequest = z.infer<
  typeof AppendConversationTurnRequestSchema
>;

/** The accepted turn: the run that will execute it and its ledger position. */
export const ConversationTurnAcceptedSchema = z.strictObject({
  buildSessionId: BuildSessionIdSchema,
  runId: RunIdSchema,
  sequence: z.number().int().positive(),
});
export type ConversationTurnAccepted = z.infer<
  typeof ConversationTurnAcceptedSchema
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
