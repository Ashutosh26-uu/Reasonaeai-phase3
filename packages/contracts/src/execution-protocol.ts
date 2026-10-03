import { z } from "zod";
import {
  BuildSessionIdSchema,
  ConversationMessageSchema,
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

export const RunCancellationAcceptedSchema = z.strictObject({
  accepted: z.literal(true),
  runId: RunIdSchema,
});
export type RunCancellationAccepted = z.infer<
  typeof RunCancellationAcceptedSchema
>;

export const RunAnswerRequestSchema = z.strictObject({
  answer: z.string().trim().min(1).max(20_000),
  toolCallId: z.string().min(1).max(256),
});

export const RunAnswerAcceptedSchema = z.strictObject({
  accepted: z.literal(true),
  runId: RunIdSchema,
  toolCallId: z.string(),
});

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
  "run.cancel.requested",
  "run.cancelled",
  "run.steering.requested",
  "run.steering.delivered",
  "run.steering.failed",
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

const GitCommitSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
export const CheckpointFileChangeSchema = z.strictObject({
  added: z.number().int().nonnegative().nullable(),
  path: z.string().min(1).max(4096),
  previousPath: z.string().min(1).max(4096).optional(),
  removed: z.number().int().nonnegative().nullable(),
  status: z.enum([
    "added",
    "modified",
    "deleted",
    "renamed",
    "copied",
    "typechanged",
  ]),
});
export type CheckpointFileChange = z.infer<typeof CheckpointFileChangeSchema>;

/** Immutable provenance and bounded, measured changes for one saved turn. */
export const RunCheckpointSchema = z.discriminatedUnion("status", [
  z.strictObject({
    added: z.number().int().nonnegative(),
    baseCommit: GitCommitSchema.nullable(),
    checkpointId: z.string().min(1).max(512),
    commit: GitCommitSchema,
    fileCount: z.number().int().nonnegative(),
    files: z.array(CheckpointFileChangeSchema).max(1000),
    removed: z.number().int().nonnegative(),
    status: z.literal("available"),
    truncated: z.boolean(),
    version: z.literal(1),
  }),
  z.strictObject({
    checkpointId: z.string().min(1).max(512),
    commit: GitCommitSchema.nullable(),
    reason: z.enum(["unknown_base", "diff_failed"]),
    status: z.literal("unavailable"),
    version: z.literal(1),
  }),
]);
export type RunCheckpoint = z.infer<typeof RunCheckpointSchema>;

export const CheckpointDiffSchema = z.strictObject({
  binary: z.boolean(),
  checkpointId: z.string().min(1).max(512),
  patch: z.string().max(256 * 1024),
  path: z.string().min(1).max(4096),
  unavailable: z.enum(["oversized"]).nullable(),
});

const TranscriptSpan = {
  endedAt: IsoDateTimeSchema.nullable(),
  index: z.number().int().nonnegative(),
  startedAt: IsoDateTimeSchema,
};

export const TranscriptPartSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...TranscriptSpan,
    text: z.string().max(1_000_000),
    type: z.literal("text"),
  }),
  z.strictObject({
    ...TranscriptSpan,
    text: z.string().max(1_000_000),
    type: z.literal("reasoning"),
  }),
  z.strictObject({
    index: z.number().int().nonnegative(),
    toolCallId: z.string().min(1).max(256),
    type: z.literal("tool"),
  }),
]);
export type TranscriptPart = z.infer<typeof TranscriptPartSchema>;

/** Versioned snapshots retain source-part order without persisting every token. */
export const MessageSnapshotSchema = z
  .strictObject({
    finished: z.boolean(),
    messageId: z.string().min(1).max(256),
    parts: z.array(TranscriptPartSchema).max(4096),
    recovery: z
      .strictObject({
        source: z.literal("mastra.parts.v1"),
        sourceEventId: RunEventIdSchema,
        sourceSequence: z.number().int().positive(),
      })
      .optional(),
    revision: z.number().int().positive(),
    startedAt: IsoDateTimeSchema,
    version: z.literal(1),
  })
  .refine(
    (snapshot) =>
      snapshot.parts.reduce(
        (size, part) => size + (part.type === "tool" ? 0 : part.text.length),
        0
      ) <= 1_000_000,
    "Transcript exceeds the message size limit"
  );
export type MessageSnapshot = z.infer<typeof MessageSnapshotSchema>;

export const ConversationTranscriptSchema = z.strictObject({
  events: z.array(RunEventEnvelopeSchema).max(500),
  messages: z.array(ConversationMessageSchema),
  nextAfter: z.number().int().nonnegative().nullable(),
});

/**
 * A transient frame of a run's live view: text an agent is still producing.
 *
 * Deltas are deliberately not durable. A ledger entry per token would record
 * one message thousands of times and make the ledger a transcript store, so the
 * ledger keeps the completed message and this channel carries the same text as
 * it arrives. Delivery is therefore at-most-once and is never replayed from the
 * beginning: a client that misses a delta loses only part of a partial view of
 * a message it will receive complete from the durable ledger.
 *
 * A live frame carries its tenant scope for the same reason a durable event
 * does — the topic names one run, so a payload that does not match the
 * subscription's scope is a transport fault, not a delivery.
 */
const LiveScope = {
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema,
  runId: RunIdSchema,
  schemaVersion: z.literal(1),
};

/**
 * The assistant text of one message as the model produces it. `mode` is
 * `append` when `delta` continues the message so far and `replace` when the
 * message was rewritten and `delta` is its text in full.
 */
export const RunLiveMessageDeltaSchema = z.strictObject({
  ...LiveScope,
  delta: z.string().min(1),
  kind: z.literal("message.delta"),
  messageId: z.string().min(1).max(256),
  mode: z.enum(["append", "replace"]),
});
export type RunLiveMessageDelta = z.infer<typeof RunLiveMessageDeltaSchema>;

/**
 * The text one delegated worker is producing. A subagent runs in parallel with
 * its parent, so its text is addressed by the delegation tool call that spawned
 * it rather than by the parent's streaming message.
 */
export const RunLiveSubagentDeltaSchema = z.strictObject({
  ...LiveScope,
  agentType: z.string().min(1).max(64),
  delta: z.string().min(1),
  kind: z.literal("subagent.delta"),
  toolCallId: z.string().min(1).max(256),
});
export type RunLiveSubagentDelta = z.infer<typeof RunLiveSubagentDeltaSchema>;

export const RunLiveEventSchema = z.discriminatedUnion("kind", [
  RunLiveMessageDeltaSchema,
  RunLiveSubagentDeltaSchema,
  z.strictObject({
    ...LiveScope,
    kind: z.literal("message.snapshot"),
    snapshot: MessageSnapshotSchema,
  }),
]);
export type RunLiveEvent = z.infer<typeof RunLiveEventSchema>;

/**
 * The live frame kinds, taken from the schema rather than written again.
 *
 * A browser registers one SSE listener per frame kind, so the names it
 * subscribes to have to be exactly the names the schema accepts; deriving them
 * is what keeps a renamed kind from silently reaching nobody.
 */
export const RUN_LIVE_EVENT_KINDS: readonly string[] =
  RunLiveEventSchema.options.map((option) => option.shape.kind.value);

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

/**
 * The topic that carries a run's live deltas. A separate topic from the durable
 * one because the two have different retention: the ledger's topic is what a
 * reconnecting client replays, while this one is bounded and expires with the
 * run.
 */
export const runLiveTopic = (runId: string): string =>
  `reasonateai.run.live.${runId}`;

export const runCommandTopic = "reasonateai.run.commands";

/**
 * A reconnect may only resume from a sequence the run has actually produced.
 * Sequence zero is the "deliver everything retained" cursor.
 */
export function isReplayableSequence(afterSequence: number): boolean {
  return Number.isInteger(afterSequence) && afterSequence >= 0;
}
