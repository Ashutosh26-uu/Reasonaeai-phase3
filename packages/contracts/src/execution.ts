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

/** An attachment accepted with a user turn and forwarded to the run worker. */
export const PromptAttachmentSchema = z
  .strictObject({
    data: z
      .string()
      .min(1)
      .max(6_000_000)
      .regex(/^data:[^;,]+;base64,[A-Za-z0-9+/]+=*$/),
    filename: z.string().min(1).max(255),
    mediaType: z.string().min(1).max(128),
  })
  .superRefine((attachment, context) => {
    const dataMediaType = attachment.data.slice(
      5,
      attachment.data.indexOf(";")
    );
    if (dataMediaType !== attachment.mediaType) {
      context.addIssue({
        code: "custom",
        message: "Attachment media type does not match its data.",
      });
    }
    if (estimatePromptAttachmentBytes(attachment.data) > 4 * 1024 * 1024) {
      context.addIssue({
        code: "custom",
        message: "Each attachment must be 4 MB or smaller.",
      });
    }
  });
export type PromptAttachment = z.infer<typeof PromptAttachmentSchema>;

/** Safe attachment details shown in durable conversation history. */
export const ConversationAttachmentSchema = z.strictObject({
  filename: z.string().min(1).max(255),
  mediaType: z.string().min(1).max(128),
  sizeBytes: z
    .number()
    .int()
    .nonnegative()
    .max(4 * 1024 * 1024),
});
export type ConversationAttachment = z.infer<
  typeof ConversationAttachmentSchema
>;

export const AllocateBuildSessionRequestSchema = z.strictObject({
  attachments: z.array(PromptAttachmentSchema).max(5).optional(),
  idempotencyKey: z.string().min(1).max(128),
  /**
   * The opening message of the conversation. A build session is the project's
   * conversation with its CTO, so allocating one is how a conversation starts:
   * the first turn is recorded on the session's first run and reaches the agent
   * as the user's own words. Omitted means the session is allocated without an
   * opening turn, which leaves its run on the default dispatch directive.
   */
  message: z.string().max(20_000).optional(),
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
  attachments: z.array(ConversationAttachmentSchema).max(5).optional(),
  createdAt: IsoDateTimeSchema,
  id: z.string().min(1).max(256),
  /**
   * What the model reasoned before writing this message, when it produced any.
   *
   * It is the only honest source for "how the answer was reached": the message's
   * own text is what a person reads, and the reasoning is what they open when
   * they want to see the work behind it.
   */
  reasoning: z.string().max(1_000_000).nullable(),
  role: ConversationMessageRoleSchema,
  runId: RunIdSchema.optional(),
  /**
   * The agent-platform message this row came from, when it came from one.
   *
   * The history's own id is the ledger event that recorded the message, and a
   * client holding live events knows the same message by its platform id. This
   * is what lets the two be recognized as one message, so a streamed message
   * and the committed one that replaces it occupy the same place in the
   * conversation rather than appearing twice.
   */
  sourceId: z.string().min(1).max(256).nullable(),
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
export const AppendConversationTurnRequestSchema = z
  .strictObject({
    attachments: z.array(PromptAttachmentSchema).max(5).optional(),
    message: z.string().max(20_000),
  })
  .superRefine((request, context) => {
    const hasMessage = request.message.trim().length > 0;
    const hasAttachments = (request.attachments?.length ?? 0) > 0;
    if (!(hasMessage || hasAttachments)) {
      context.addIssue({
        code: "custom",
        message: "A message or attachment is required.",
      });
    }
    const totalBytes = (request.attachments ?? []).reduce(
      (total, attachment) =>
        total + estimatePromptAttachmentBytes(attachment.data),
      0
    );
    if (totalBytes > 12 * 1024 * 1024) {
      context.addIssue({
        code: "custom",
        message: "Attachments exceed the total size limit.",
      });
    }
  });

function estimatePromptAttachmentBytes(data: string): number {
  const encoded = data.slice(data.indexOf(",") + 1);
  let padding = 0;
  if (encoded.endsWith("==")) {
    padding = 2;
  } else if (encoded.endsWith("=")) {
    padding = 1;
  }
  return Math.floor((encoded.length * 3) / 4) - padding;
}
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
