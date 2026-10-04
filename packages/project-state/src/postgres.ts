import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import {
  type CreateOrganizationResponse,
  CreateOrganizationResponseSchema,
  type OrganizationSummary,
  OrganizationSummarySchema,
  type ProjectSummary,
  ProjectSummarySchema,
  type ProjectView,
  ProjectViewSchema,
} from "@reasonateai/contracts/auth";
import {
  type BuildSession,
  type BuildSessionId,
  BuildSessionIdSchema,
  BuildSessionSchema,
  type ConversationAttachment,
  type ConversationMessage,
  ConversationMessageSchema,
  type ConversationSummary,
  ConversationSummarySchema,
  type PromptAttachment,
  PromptAttachmentSchema,
  type SandboxEnvironment,
  type SandboxEnvironmentId,
  SandboxEnvironmentIdSchema,
  SandboxEnvironmentSchema,
} from "@reasonateai/contracts/execution";
import {
  type ArtifactManifest,
  type RunEventEnvelope,
  RunEventEnvelopeSchema,
  type RunEventType,
  type RunLease,
  RunLeaseSchema,
  type RunStatus,
  RunStatusSchema,
  runEventTopic,
} from "@reasonateai/contracts/execution-protocol";
import {
  type AuditEvent,
  type OrganizationId,
  OrganizationIdSchema,
  type ProjectId,
  ProjectIdSchema,
  type ProjectRole,
  type RunId,
  RunIdSchema,
  type SessionId,
  type UserId,
} from "@reasonateai/contracts/identity";
import { Pool, type PoolClient } from "pg";
import {
  type AuditRepository,
  createAuditRepository,
  recordWith,
} from "./audit.js";
import {
  AUDIT_MIGRATION_SQL,
  AUTH_TOKEN_MIGRATION_SQL,
} from "./auth-schema.js";
import {
  createMagicLinkRepository,
  type MagicLinkRepository,
} from "./magic-links.js";
import { MEMBERSHIP_MIGRATION_SQL } from "./membership-schema.js";
import {
  createMembershipRepository,
  type MembershipRepository,
} from "./memberships.js";
import { createRateLimiter, type RateLimiter } from "./rate-limit.js";
import { PROJECT_STATE_MIGRATION_SQL } from "./schema.js";
import { AUTH_SESSION_MIGRATION_SQL } from "./session-schema.js";
import { createSessionRepository, type SessionRepository } from "./sessions.js";
import {
  createRunSteeringRepository,
  type RunSteeringRepository,
} from "./steering.js";
import { RUN_STEERING_MIGRATION_SQL } from "./steering-schema.js";
import { createUsageRepository, type UsageRepository } from "./usage.js";
import { USAGE_MIGRATION_SQL } from "./usage-schema.js";
import { createUserRepository, type UserRepository } from "./users.js";

export interface TenantScope {
  organizationId: OrganizationId;
  projectId: ProjectId;
}

export interface BuildSessionAllocation {
  buildSession: BuildSession;
  created: boolean;
  sandbox: SandboxEnvironment;
}

export class ConversationBusyError extends Error {
  constructor() {
    super("This conversation already has a run in progress.");
    this.name = "ConversationBusyError";
  }
}

export class ConversationRetryUnavailableError extends Error {
  constructor() {
    super(
      "Only a failed or cancelled run in this conversation can be retried."
    );
    this.name = "ConversationRetryUnavailableError";
  }
}

function conversationRetryKey(input: { idempotencyKey: string; runId: RunId }) {
  return JSON.stringify(["retry", input.runId, input.idempotencyKey]);
}

async function resolveConversationPrompt(
  client: PoolClient,
  input: {
    attachments?: PromptAttachment[];
    buildSessionId: BuildSessionId;
    message: string;
    retryRunId?: RunId;
    scope: TenantScope;
  }
) {
  if (!input.retryRunId) {
    return { attachments: input.attachments ?? [], message: input.message };
  }
  const source = await client.query<{
    user_message: string | null;
    user_attachments: unknown;
  }>(
    `select user_message, user_attachments from runs
      where run_id = $1 and build_session_id = $2
        and organization_id = $3 and project_id = $4
        and status in ('failed', 'cancelled') for update`,
    [
      input.retryRunId,
      input.buildSessionId,
      input.scope.organizationId,
      input.scope.projectId,
    ]
  );
  const [original] = source.rows;
  if (!original || original.user_message === null) {
    throw new ConversationRetryUnavailableError();
  }
  return {
    attachments: PromptAttachmentSchema.array().parse(
      original.user_attachments ?? []
    ),
    message: original.user_message,
  };
}

export interface OutboxRecord {
  outboxId: string;
  payload: RunEventEnvelope;
  topic: string;
}

/** One outbox row a relay has taken responsibility for publishing. */
export interface OutboxClaim {
  outboxId: string;
  payload: unknown;
  topic: string;
}

export interface OutboxRepository {
  /**
   * Takes up to `limit` unpublished rows for this relay, skipping rows another
   * relay holds, so two relays never publish the same row. A claim that is not
   * marked published before its lease lapses becomes claimable again, which is
   * what keeps delivery at-least-once rather than at-most-once.
   */
  claim: (limit: number) => Promise<OutboxClaim[]>;
}

export interface ArtifactRecord {
  artifactId: string;
  createdAt: string;
  kind: string;
  manifestObjectKey: string;
  sha256: string;
  status: string;
  totalSize: number;
}

export interface DeploymentRecord {
  deploymentId: string;
  exposure: string;
  providerReference: string;
  sourceCheckpoint: string;
  status: string;
  updatedAt: string;
  url: string | null;
}

/**
 * A queued run a worker may claim, with everything the worker needs to scope
 * and restore it. The workspace and sandbox come from the run's own build
 * session and sandbox environment row, so a worker that was handed nothing but
 * a run identifier never has to invent either.
 */
export interface RunnableRun {
  buildSessionId: BuildSessionId;
  organizationId: OrganizationId;
  pendingMastraRunId: string | null;
  pendingToolCallId: string | null;
  projectId: ProjectId;
  runId: RunId;
  sandboxEnvironmentId: SandboxEnvironmentId;
  userAttachments: PromptAttachment[];
  userMessage: string | null;
  workspaceUri: string;
}

/** The durable run row, as the execution plane reads it. */
export interface RunRecord {
  buildSessionId: BuildSessionId;
  createdAt: string;
  organizationId: OrganizationId;
  projectId: ProjectId;
  runId: RunId;
  status: RunStatus;
  updatedAt: string;
}

/**
 * The terminal outcome a worker reports for a run. It is the worker's word for
 * what happened, not the ledger's status: `RunStatus` has no `succeeded`, so a
 * successful finish is recorded as `completed`.
 */
export type RunFinishStatus = "succeeded" | "failed" | "cancelled";

/** One worker's hold on a run, as committed to `run_leases`. */
export interface RunLeaseGrant {
  expiresAt: Date;
  leaseId: string;
}

/**
 * The statuses a run cannot leave. A terminal run is never claimed, and the
 * first terminal outcome stands: a late completion neither overwrites it nor
 * counts as having applied.
 */
const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled"] as const;

/** The ledger's status for each outcome a worker can report. */
const FINISHED_RUN_STATUS = {
  cancelled: "cancelled",
  failed: "failed",
  succeeded: "completed",
} as const satisfies Record<RunFinishStatus, RunStatus>;

/**
 * Arbitrary but stable advisory-lock key for this schema's migrations. Any
 * value works as long as every migrator in the fleet uses the same one.
 */
const MIGRATION_LOCK_KEY = 8_274_196_301_552_001;

/**
 * How long one relay's claim on an outbox row is honoured before another relay
 * may take it. Long enough that a publish and its mark complete well inside it,
 * short enough that a relay that dies mid-batch does not stall the topic.
 */
const OUTBOX_CLAIM_LEASE_MS = 60_000;

/**
 * A migration's DDL needs an access-exclusive lock on every table it changes.
 * Waiting for it indefinitely stalls all writers behind the migration, and a
 * writer that already holds a read lock while it upgrades past the queued
 * request deadlocks instead of waiting, which Postgres resolves by killing one
 * of the two. Giving up on the lock quickly keeps writers moving, and the
 * retry around the migration finishes it once the writer in the way committed.
 */
const MIGRATION_LOCK_TIMEOUT_MS = 5000;

/** Bounded, so a migration cannot spin forever against a permanently busy table. */
const MIGRATION_ATTEMPTS = 6;

/** Linear backoff, so replicas that start together do not retry in lockstep. */
const MIGRATION_RETRY_DELAY_MS = 250;

/**
 * `lock_not_available` is our own lock timeout, `deadlock_detected` is Postgres
 * breaking the cycle for us, and two concurrent `create table if not exists`
 * can still race into a duplicate object or a duplicate system-catalog key.
 */
const RETRYABLE_MIGRATION_CODES = new Set(["40P01", "55P03", "23505", "42P07"]);

function isRetryableMigrationError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  const { code } = error;
  return typeof code === "string" && RETRYABLE_MIGRATION_CODES.has(code);
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function estimateDataUrlBytes(data: string): number {
  const encoded = data.slice(data.indexOf(",") + 1);
  let padding = 0;
  if (encoded.endsWith("==")) {
    padding = 2;
  } else if (encoded.endsWith("=")) {
    padding = 1;
  }
  return Math.floor((encoded.length * 3) / 4) - padding;
}

function toBuildSession(row: Record<string, unknown>): BuildSession {
  return BuildSessionSchema.parse({
    buildSessionId: row.build_session_id,
    createdAt: asIso(row.created_at as Date),
    organizationId: row.organization_id,
    projectId: row.project_id,
    runId: row.run_id,
    sandboxEnvironmentId: row.sandbox_environment_id,
    stage: row.stage,
    status: row.status,
    updatedAt: asIso(row.updated_at as Date),
    userSessionId: row.user_session_id,
  });
}

function toSandboxEnvironment(
  row: Record<string, unknown>
): SandboxEnvironment {
  return SandboxEnvironmentSchema.parse({
    buildSessionId: row.build_session_id,
    createdAt: asIso(row.created_at as Date),
    organizationId: row.organization_id,
    projectId: row.project_id,
    sandboxEnvironmentId: row.sandbox_environment_id,
    status: row.status,
    updatedAt: asIso(row.updated_at as Date),
    workspaceUri: row.workspace_uri,
  });
}

export interface ProjectStateStore {
  allocateBuildSession: (input: {
    attachments?: PromptAttachment[];
    idempotencyKey: string;
    message?: string;
    scope: TenantScope;
    userSessionId: SessionId;
  }) => Promise<BuildSessionAllocation>;
  answerRunQuestion: (input: {
    answer: string;
    buildSessionId: BuildSessionId;
    requestedByUserId: UserId;
    runId: RunId;
    scope: TenantScope;
    toolCallId: string;
  }) => Promise<"accepted" | "replayed" | "conflict">;
  appendConversationTurn: (input: {
    attachments?: PromptAttachment[];
    buildSessionId: BuildSessionId;
    idempotencyKey: string;
    message: string;
    scope: TenantScope;
  }) => Promise<{ runId: RunId; created: boolean }>;
  appendRunEvent: (input: {
    controllerRunId?: string;
    payload: Record<string, unknown>;
    runId: RunId;
    scope: TenantScope;
    type: RunEventType;
  }) => Promise<RunEventEnvelope>;
  audit: AuditRepository;
  /**
   * Takes the run lease and moves the run to `running` in one statement, so a
   * run is never running without a lease nor leased while queued. The lease is
   * taken only when the run has not reached a terminal status and no live lease
   * covers it, so a run abandoned by a dead worker becomes claimable again once
   * its lease lapses while two live holders can never both win. `undefined`
   * means another holder owns a live lease, or the run is already terminal.
   */
  beginRun: (input: {
    holder: string;
    runId: RunId;
    ttlMs: number;
  }) => Promise<RunLeaseGrant | undefined>;
  claimRunLease: (input: {
    holder: string;
    runId: RunId;
    scope: TenantScope;
    ttlMs: number;
  }) => Promise<RunLease | undefined>;
  close: () => Promise<void>;
  /**
   * Creates an organization and its owner membership, and records the audit
   * event that describes it, in one transaction: a tenant without an owner, or
   * an owner in a tenant nothing recorded, cannot exist.
   *
   * The organization identifier comes from the event's own `organizationId`
   * when the caller minted one and is generated here otherwise, so the stored
   * event always names the organization it was committed with.
   */
  createOrganizationWithOwner: (input: {
    audit: AuditEvent;
    name: string;
    userId: UserId;
  }) => Promise<CreateOrganizationResponse>;
  /**
   * Creates a project, its membership for the caller, and the audit event that
   * describes it, in one transaction.
   *
   * The project identifier comes from the event's own `projectId` when the
   * caller minted one and is generated here otherwise; the audit row is stamped
   * with `organizationId`, which is the scope the caller was authorized for.
   */
  createProject: (input: {
    audit: AuditEvent;
    name: string;
    organizationId: OrganizationId;
    role: ProjectRole;
    userId: UserId;
  }) => Promise<ProjectView>;
  /**
   * Ends the run: the terminal status and the release of the lease commit
   * together. Repeating the call converges rather than erroring, and a holder
   * whose lease was taken over cannot end the run at all.
   */
  finishRun: (input: {
    holder: string;
    leaseId: string;
    runId: RunId;
    status: RunFinishStatus;
  }) => Promise<boolean>;
  getBuildSession: (
    scope: TenantScope,
    buildSessionId: BuildSessionId
  ) => Promise<BuildSession | undefined>;
  /**
   * The run row, read through the caller's organization and project: a run
   * outside that tenant scope is not found rather than filtered afterwards, so
   * a caller cannot learn that another tenant's run exists.
   */
  getConversationRetry: (input: {
    buildSessionId: BuildSessionId;
    idempotencyKey: string;
    runId: RunId;
    scope: TenantScope;
  }) => Promise<RunId | undefined>;
  getRun: (input: {
    organizationId: OrganizationId;
    projectId: ProjectId;
    runId: RunId;
  }) => Promise<RunRecord | undefined>;
  /** Reads the durable cancellation request while a worker holds the run. */
  isRunCancellationRequested: (runId: RunId) => Promise<boolean>;
  listArtifacts: (scope: TenantScope) => Promise<ArtifactRecord[]>;
  listConversationEvents: (input: {
    buildSessionId: BuildSessionId;
    scope: TenantScope;
    after: number;
    limit: number;
  }) => Promise<RunEventEnvelope[]>;
  listConversationMessages: (input: {
    buildSessionId: BuildSessionId;
    scope: TenantScope;
  }) => Promise<ConversationMessage[]>;
  listConversations: (scope: TenantScope) => Promise<ConversationSummary[]>;
  /**
   * The caller's own organizations, for the session view. Membership is
   * resolved from the caller's identifier and nowhere else, so a caller cannot
   * ask about another user's tenancy.
   */
  listOrganizationMemberships: (input: {
    userId: UserId;
  }) => Promise<OrganizationSummary[]>;
  listPendingOutbox: (limit: number) => Promise<OutboxRecord[]>;
  listProjectsForUser: (input: {
    includeAll: boolean;
    organizationId: OrganizationId;
    userId: UserId;
  }) => Promise<ProjectSummary[]>;
  listRunEvents: (input: {
    afterSequence: number;
    limit: number;
    runId: RunId;
    scope: TenantScope;
  }) => Promise<RunEventEnvelope[]>;
  /**
   * The dispatch poll: runs that have not ended and that no live lease covers,
   * oldest first, so the worker fleet discovers work from PostgreSQL rather
   * than from a channel that can lose it. A run whose lease lapsed is still
   * listed — that is how work abandoned by a dead worker is picked up again —
   * because the claim, not the listing, decides the winner.
   */
  listRunnableRuns: (input: { limit: number }) => Promise<RunnableRun[]>;
  magicLinks: MagicLinkRepository;
  markOutboxPublished: (outboxIds: number[]) => Promise<void>;
  memberships: MembershipRepository;
  migrate: () => Promise<void>;
  outbox: OutboxRepository;
  rateLimiter: RateLimiter;
  recordArtifact: (
    manifest: ArtifactManifest,
    status: string
  ) => Promise<ArtifactRecord>;
  recordDeployment: (input: {
    deploymentId: string;
    exposure: string;
    providerReference: string;
    runId: RunId;
    scope: TenantScope;
    sourceCheckpoint: string;
    status: string;
    url: string | null;
  }) => Promise<DeploymentRecord>;
  releaseRunLease: (input: {
    leaseId: string;
    runId: RunId;
    scope: TenantScope;
  }) => Promise<boolean>;
  /**
   * Renames an organization and records the audit event that describes it, in
   * one transaction, so a rename nothing recorded cannot exist.
   *
   * Returns false when the organization does not exist, which is a refusal
   * rather than an error: the caller was authorized for an organization that is
   * gone, and there is nothing to report but that it did not happen.
   */
  renameOrganization: (input: {
    audit: AuditEvent;
    name: string;
    organizationId: OrganizationId;
  }) => Promise<boolean>;
  /**
   * Extends the lease the caller still holds, and only that one: the row must
   * still carry this holder and this lease id and must not have lapsed. A lease
   * that expired mid-run reports `false` instead of being silently revived, and
   * the lease id is kept, so a held lease stays releasable by the same id
   * across renewals.
   */
  renewRunLease: (input: {
    holder: string;
    leaseId: string;
    ttlMs: number;
  }) => Promise<boolean>;
  /** Records an authorized cancellation request for a non-terminal run. */
  requestRunCancellation: (input: {
    runId: RunId;
    scope: TenantScope;
    buildSessionId: BuildSessionId;
    requestedByUserId: UserId;
  }) => Promise<boolean>;
  retryConversationRun: (input: {
    buildSessionId: BuildSessionId;
    idempotencyKey: string;
    runId: RunId;
    scope: TenantScope;
  }) => Promise<{ runId: RunId; created: boolean }>;
  sessions: SessionRepository;
  setRunStatus: (input: {
    runId: RunId;
    scope: TenantScope;
    status: RunStatus;
  }) => Promise<boolean>;
  steering: RunSteeringRepository;
  takeRunAnswer: (input: {
    runId: RunId;
    scope: TenantScope;
    toolCallId: string;
  }) => Promise<string | undefined>;
  usage: UsageRepository;
  users: UserRepository;
}

async function insertRunEvent(
  client: PoolClient,
  input: {
    payload: Record<string, unknown>;
    runId: RunId;
    scope: TenantScope;
    type: RunEventType;
  }
): Promise<RunEventEnvelope> {
  const advanced = await client.query<{ sequence: string }>(
    `update runs
        set next_sequence = next_sequence + 1,
            updated_at = now()
      where run_id = $1
        and organization_id = $2
        and project_id = $3
      returning next_sequence - 1 as sequence`,
    [input.runId, input.scope.organizationId, input.scope.projectId]
  );

  const [advancedRow] = advanced.rows;
  if (!advancedRow) {
    throw new Error(
      "The run does not exist in this organization and project scope."
    );
  }

  const eventId = randomUUID();
  const sequence = Number(advancedRow.sequence);

  await client.query(
    `insert into run_events
       (run_id, sequence, event_id, organization_id, project_id, type, payload)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      input.runId,
      sequence,
      eventId,
      input.scope.organizationId,
      input.scope.projectId,
      input.type,
      JSON.stringify(input.payload),
    ]
  );

  const envelope = RunEventEnvelopeSchema.parse({
    eventId,
    occurredAt: new Date().toISOString(),
    organizationId: input.scope.organizationId,
    payload: input.payload,
    projectId: input.scope.projectId,
    runId: input.runId,
    schemaVersion: 1,
    sequence,
    type: input.type,
  });

  await client.query(
    `insert into outbox
       (topic, run_id, organization_id, project_id, event_id, payload)
     values ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      runEventTopic(input.runId),
      input.runId,
      input.scope.organizationId,
      input.scope.projectId,
      eventId,
      JSON.stringify(envelope),
    ]
  );

  return envelope;
}

async function loadBuildSession(
  client: PoolClient,
  scope: TenantScope,
  buildSessionId: string
): Promise<BuildSession | undefined> {
  const result = await client.query(
    `select * from build_sessions
      where build_session_id = $1
        and organization_id = $2
        and project_id = $3`,
    [buildSessionId, scope.organizationId, scope.projectId]
  );

  const [row] = result.rows;
  return row ? toBuildSession(row) : undefined;
}

async function loadSandboxEnvironment(
  client: PoolClient,
  scope: TenantScope,
  sandboxEnvironmentId: string
): Promise<SandboxEnvironment | undefined> {
  const result = await client.query(
    `select * from sandbox_environments
      where sandbox_environment_id = $1
        and organization_id = $2
        and project_id = $3`,
    [sandboxEnvironmentId, scope.organizationId, scope.projectId]
  );

  const [row] = result.rows;
  return row ? toSandboxEnvironment(row) : undefined;
}

async function requireAllocation(
  client: PoolClient,
  scope: TenantScope,
  buildSessionId: string,
  created: boolean
): Promise<BuildSessionAllocation> {
  const buildSession = await loadBuildSession(client, scope, buildSessionId);
  if (!buildSession) {
    throw new Error(
      "The referenced build session does not exist in this tenant scope."
    );
  }

  const sandbox = await loadSandboxEnvironment(
    client,
    scope,
    buildSession.sandboxEnvironmentId as string
  );
  if (!sandbox) {
    throw new Error(
      "The build session has no sandbox environment in this tenant scope."
    );
  }

  return { buildSession, created, sandbox };
}

export function createProjectStateStore(config: {
  connectionString: string;
  maxConnections?: number;
  pool?: Pool;
  /** Redis used for rate-limit counters; defaults to `REDIS_URL`. */
  redisUrl?: string;
  sessionIdleTtlMs?: number;
}): ProjectStateStore {
  const pool =
    config.pool ??
    new Pool({
      connectionString: config.connectionString,
      max: config.maxConnections ?? 10,
    });

  const sessions = createSessionRepository(pool, {
    idleTtlMs: config.sessionIdleTtlMs ?? 1000 * 60 * 60 * 24 * 14,
  });
  const memberships = createMembershipRepository(pool);
  const rateLimiter = createRateLimiter({
    url: config.redisUrl ?? process.env.REDIS_URL,
  });
  const audit = createAuditRepository(pool);
  const magicLinks = createMagicLinkRepository(pool);
  const users = createUserRepository(pool);

  async function withTransaction<T>(
    run: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const usage = createUsageRepository(pool, { withTransaction });
  const steering = createRunSteeringRepository({
    appendEvent: insertRunEvent,
    withTransaction,
  });

  async function allocateBuildSession(input: {
    attachments?: PromptAttachment[];
    idempotencyKey: string;
    message?: string;
    scope: TenantScope;
    userSessionId: SessionId;
  }): Promise<BuildSessionAllocation> {
    return await withTransaction(async (client) => {
      // Serialize conversation creation and idempotency replay in one project.
      await client.query(
        `select project_id from projects
          where organization_id = $1 and project_id = $2 for update`,
        [input.scope.organizationId, input.scope.projectId]
      );
      const replayed = await client.query<{ build_session_id: string }>(
        `select build_session_id from idempotency_records
          where organization_id = $1 and scope = $2 and idempotency_key = $3`,
        [
          input.scope.organizationId,
          "build-session.allocate",
          input.idempotencyKey,
        ]
      );

      const [replayedRow] = replayed.rows;
      if (replayedRow) {
        return await requireAllocation(
          client,
          input.scope,
          replayedRow.build_session_id,
          false
        );
      }

      const buildSessionId = randomUUID();
      const runId = randomUUID();
      const sandboxEnvironmentId = randomUUID();
      const workspaceUri = `sandbox://${sandboxEnvironmentId}/workspace`;

      await client.query(
        `insert into build_sessions
           (build_session_id, organization_id, project_id, user_session_id, run_id,
            sandbox_environment_id, workspace_uri, stage, status)
         values ($1, $2, $3, $4, $5, $6, $7, 'intake', 'provisioning')`,
        [
          buildSessionId,
          input.scope.organizationId,
          input.scope.projectId,
          input.userSessionId,
          runId,
          sandboxEnvironmentId,
          workspaceUri,
        ]
      );

      await client.query(
        `insert into sandbox_environments
           (sandbox_environment_id, organization_id, project_id, build_session_id,
            status, workspace_uri)
         values ($1, $2, $3, $4, 'allocating', $5)`,
        [
          sandboxEnvironmentId,
          input.scope.organizationId,
          input.scope.projectId,
          buildSessionId,
          workspaceUri,
        ]
      );

      await client.query(
        `insert into runs
           (run_id, organization_id, project_id, build_session_id, status, user_message, user_attachments)
         values ($1, $2, $3, $4, 'queued', $5, $6::jsonb)`,
        [
          runId,
          input.scope.organizationId,
          input.scope.projectId,
          buildSessionId,
          input.message ?? null,
          JSON.stringify(input.attachments ?? []),
        ]
      );

      await insertRunEvent(client, {
        payload: { buildSessionId, sandboxEnvironmentId, workspaceUri },
        runId: runId as RunId,
        scope: input.scope,
        type: "run.queued",
      });

      await client.query(
        `insert into idempotency_records
           (organization_id, scope, idempotency_key, build_session_id)
         values ($1, $2, $3, $4)`,
        [
          input.scope.organizationId,
          "build-session.allocate",
          input.idempotencyKey,
          buildSessionId,
        ]
      );

      return await requireAllocation(client, input.scope, buildSessionId, true);
    });
  }

  async function appendConversationTurn(input: {
    attachments?: PromptAttachment[];
    buildSessionId: BuildSessionId;
    idempotencyKey: string;
    message: string;
    retryRunId?: RunId;
    scope: TenantScope;
  }): Promise<{ runId: RunId; created: boolean }> {
    return await withTransaction(async (client) => {
      const session = await client.query<{ build_session_id: string }>(
        `select build_session_id from build_sessions
          where build_session_id = $1 and organization_id = $2 and project_id = $3
          for update`,
        [
          input.buildSessionId,
          input.scope.organizationId,
          input.scope.projectId,
        ]
      );
      if (session.rowCount !== 1) {
        throw new Error("Conversation not found in this project.");
      }

      const replay = await client.query<{
        run_id: string;
        retry_source: string | null;
      }>(
        `select keys.run_id, event.payload->>'retryOfRunId' as retry_source
           from conversation_turn_keys keys
           left join run_events event on event.run_id = keys.run_id
             and event.organization_id = keys.organization_id
             and event.project_id = keys.project_id and event.sequence = 1
          where keys.organization_id = $1 and keys.project_id = $2
            and keys.build_session_id = $3 and keys.idempotency_key = $4`,
        [
          input.scope.organizationId,
          input.scope.projectId,
          input.buildSessionId,
          input.idempotencyKey,
        ]
      );
      if (replay.rows[0]) {
        if (
          input.retryRunId &&
          replay.rows[0].retry_source !== input.retryRunId
        ) {
          throw new ConversationRetryUnavailableError();
        }
        return {
          created: false,
          runId: RunIdSchema.parse(replay.rows[0].run_id),
        };
      }

      const active = await client.query(
        `select 1 from runs where build_session_id = $1
          and organization_id = $2 and project_id = $3
          and status in ('queued', 'running', 'awaiting_approval') limit 1`,
        [
          input.buildSessionId,
          input.scope.organizationId,
          input.scope.projectId,
        ]
      );
      if (active.rowCount !== 0) {
        throw new ConversationBusyError();
      }

      const { message, attachments } = await resolveConversationPrompt(
        client,
        input
      );

      const runId = RunIdSchema.parse(randomUUID());
      await client.query(
        `insert into runs
           (run_id, organization_id, project_id, build_session_id, status, user_message, user_attachments)
         values ($1, $2, $3, $4, 'queued', $5, $6::jsonb)`,
        [
          runId,
          input.scope.organizationId,
          input.scope.projectId,
          input.buildSessionId,
          message,
          JSON.stringify(attachments),
        ]
      );
      await client.query(
        `update build_sessions set run_id = $2, status = 'ready', updated_at = now()
          where build_session_id = $1`,
        [input.buildSessionId, runId]
      );
      await client.query(
        `insert into conversation_turn_keys
           (organization_id, project_id, build_session_id, idempotency_key, run_id)
         values ($1, $2, $3, $4, $5)`,
        [
          input.scope.organizationId,
          input.scope.projectId,
          input.buildSessionId,
          input.idempotencyKey,
          runId,
        ]
      );
      await insertRunEvent(client, {
        payload: {
          buildSessionId: input.buildSessionId,
          ...(input.retryRunId ? { retryOfRunId: input.retryRunId } : {}),
        },
        runId,
        scope: input.scope,
        type: "run.queued",
      });
      return { created: true, runId };
    });
  }

  async function retryConversationRun(input: {
    buildSessionId: BuildSessionId;
    idempotencyKey: string;
    runId: RunId;
    scope: TenantScope;
  }) {
    return await appendConversationTurn({
      buildSessionId: input.buildSessionId,
      idempotencyKey: conversationRetryKey(input),
      message: "",
      retryRunId: input.runId,
      scope: input.scope,
    });
  }

  async function getConversationRetry(input: {
    buildSessionId: BuildSessionId;
    idempotencyKey: string;
    runId: RunId;
    scope: TenantScope;
  }): Promise<RunId | undefined> {
    const replay = await pool.query<{ run_id: string }>(
      `select keys.run_id from conversation_turn_keys keys
         join runs r on r.run_id = keys.run_id
           and r.build_session_id = keys.build_session_id
           and r.organization_id = keys.organization_id
           and r.project_id = keys.project_id
         join run_events event on event.run_id = keys.run_id
           and event.organization_id = keys.organization_id
           and event.project_id = keys.project_id and event.sequence = 1
        where keys.organization_id = $1 and keys.project_id = $2
          and keys.build_session_id = $3 and keys.idempotency_key = $4
          and event.type = 'run.queued' and event.payload->>'retryOfRunId' = $5`,
      [
        input.scope.organizationId,
        input.scope.projectId,
        input.buildSessionId,
        conversationRetryKey(input),
        input.runId,
      ]
    );
    const [row] = replay.rows;
    return row ? RunIdSchema.parse(row.run_id) : undefined;
  }

  async function listConversations(
    scope: TenantScope
  ): Promise<ConversationSummary[]> {
    const result = await pool.query(
      `select bs.build_session_id, bs.created_at, bs.updated_at, bs.status,
              bs.run_id, r.status as run_status,
              (select left(trim(first_run.user_message), 120)
                 from runs first_run
                where first_run.build_session_id = bs.build_session_id
                  and first_run.user_message is not null
                order by first_run.created_at, first_run.run_id limit 1) as title
         from build_sessions bs
         join runs r on r.run_id = bs.run_id
        where bs.organization_id = $1 and bs.project_id = $2
        order by bs.updated_at desc, bs.build_session_id desc`,
      [scope.organizationId, scope.projectId]
    );
    return result.rows.map((row) =>
      ConversationSummarySchema.parse({
        buildSessionId: row.build_session_id,
        createdAt: asIso(row.created_at as Date),
        latestRunId: row.run_id,
        pendingRunId:
          row.run_status === "queued" ||
          row.run_status === "running" ||
          row.run_status === "awaiting_approval"
            ? row.run_id
            : null,
        status: row.status,
        title: row.title ?? null,
        updatedAt: asIso(row.updated_at as Date),
      })
    );
  }

  async function listConversationMessages(input: {
    buildSessionId: BuildSessionId;
    scope: TenantScope;
  }): Promise<ConversationMessage[]> {
    // `source_id` is the agent platform's own message id, which is what lets a
    // client place the message it already holds where the work around it
    // happened: the ledger records when a message ended, and a step's text is
    // written before the tool calls it announces.
    const result = await pool.query(
      `select id, role, text, created_at, source_id, reasoning, run_id, user_attachments from (
         select r.run_id::text as id, 'user'::text as role,
                r.user_message as text, r.created_at, null::text as source_id,
                null::text as reasoning, 0 as position, r.run_id,
                r.user_attachments
           from runs r
          where r.build_session_id = $1 and r.organization_id = $2
            and r.project_id = $3 and r.user_message is not null
         union all
         select e.event_id::text, 'assistant'::text,
                case when e.payload ? 'snapshot' then coalesce((
                  select string_agg(part->>'text', E'\\n\\n' order by ord)
                  from jsonb_array_elements(e.payload->'snapshot'->'parts') with ordinality as parts(part, ord)
                  where part->>'type' = 'text'), '') else e.payload->>'text' end,
                e.occurred_at, e.payload->>'messageId',
                case when e.payload ? 'snapshot' then (
                  select string_agg(part->>'text', E'\\n\\n' order by ord)
                  from jsonb_array_elements(e.payload->'snapshot'->'parts') with ordinality as parts(part, ord)
                  where part->>'type' = 'reasoning') else e.payload->>'reasoning' end,
                1, e.run_id, null::jsonb
           from (
             select distinct on (e.run_id, e.payload->>'messageId') e.*
             from run_events e join runs r on r.run_id = e.run_id
             where r.build_session_id = $1 and r.organization_id = $2
               and r.project_id = $3 and e.organization_id = $2 and e.project_id = $3
               and e.payload->>'kind' in ('message_end', 'message_snapshot')
               and e.payload->>'role' = 'assistant'
             order by e.run_id, e.payload->>'messageId', e.sequence desc
           ) e
       ) messages order by created_at, position, id`,
      [input.buildSessionId, input.scope.organizationId, input.scope.projectId]
    );
    return result.rows.map((row) =>
      ConversationMessageSchema.parse({
        attachments: PromptAttachmentSchema.array()
          .parse(row.user_attachments ?? [])
          .map(
            (attachment): ConversationAttachment => ({
              filename: attachment.filename,
              mediaType: attachment.mediaType,
              sizeBytes: estimateDataUrlBytes(attachment.data),
            })
          ),
        createdAt: asIso(row.created_at as Date),
        id: row.id,
        reasoning: (row.reasoning as string | null) ?? null,
        role: row.role,
        runId: row.run_id,
        sourceId: (row.source_id as string | null) ?? null,
        text: row.text,
      })
    );
  }

  async function appendRunEvent(input: {
    controllerRunId?: string;
    payload: Record<string, unknown>;
    runId: RunId;
    scope: TenantScope;
    type: RunEventType;
  }): Promise<RunEventEnvelope> {
    return await withTransaction(async (client) => {
      if (
        input.type === "approval.requested" &&
        input.payload.kind === "tool_suspended" &&
        input.payload.toolName === "ask_user"
      ) {
        if (
          typeof input.payload.toolCallId !== "string" ||
          !input.controllerRunId
        ) {
          throw new Error(
            "A suspended question requires its controller run identity."
          );
        }
        const updated = await client.query(
          `update runs set status = 'awaiting_approval',
             pending_tool_call_id = $4, pending_mastra_run_id = $5,
             pending_answer = null,
             pending_answered_by = null, updated_at = now()
           where run_id = $1 and organization_id = $2 and project_id = $3
             and status = 'running'`,
          [
            input.runId,
            input.scope.organizationId,
            input.scope.projectId,
            input.payload.toolCallId,
            input.controllerRunId,
          ]
        );
        if (updated.rowCount !== 1) {
          throw new Error("The run cannot be suspended for this question.");
        }
      }
      return await insertRunEvent(client, input);
    });
  }

  async function answerRunQuestion(input: {
    answer: string;
    buildSessionId: BuildSessionId;
    requestedByUserId: UserId;
    runId: RunId;
    scope: TenantScope;
    toolCallId: string;
  }): Promise<"accepted" | "replayed" | "conflict"> {
    return await withTransaction(async (client) => {
      const result = await client.query<{
        pending_answer: string | null;
        pending_tool_call_id: string | null;
        status: RunStatus;
      }>(
        `select status, pending_tool_call_id, pending_answer from runs
          where run_id = $1 and organization_id = $2 and project_id = $3
            and build_session_id = $4 for update`,
        [
          input.runId,
          input.scope.organizationId,
          input.scope.projectId,
          input.buildSessionId,
        ]
      );
      const [run] = result.rows;
      if (
        run?.status !== "awaiting_approval" ||
        run.pending_tool_call_id !== input.toolCallId
      ) {
        return "conflict";
      }
      if (run.pending_answer !== null) {
        return run.pending_answer === input.answer ? "replayed" : "conflict";
      }
      await client.query(
        `update runs set pending_answer = $2, pending_answered_by = $3,
           updated_at = now() where run_id = $1`,
        [input.runId, input.answer, input.requestedByUserId]
      );
      await insertRunEvent(client, {
        payload: {
          kind: "answer_submitted",
          requestedByUserId: input.requestedByUserId,
          toolCallId: input.toolCallId,
        },
        runId: input.runId,
        scope: input.scope,
        type: "approval.resolved",
      });
      return "accepted";
    });
  }

  async function takeRunAnswer(input: {
    runId: RunId;
    scope: TenantScope;
    toolCallId: string;
  }): Promise<string | undefined> {
    return await withTransaction(async (client) => {
      const values = [
        input.runId,
        input.scope.organizationId,
        input.scope.projectId,
        input.toolCallId,
      ];
      const result = await client.query<{ pending_answer: string }>(
        `select pending_answer from runs
          where run_id = $1 and organization_id = $2 and project_id = $3
            and status = 'awaiting_approval' and pending_tool_call_id = $4
            and pending_answer is not null and cancellation_requested_at is null
          for update`,
        values
      );
      const answer = result.rows[0]?.pending_answer;
      if (answer === undefined) {
        return;
      }
      await client.query(
        `update runs set status = 'running', pending_tool_call_id = null,
         pending_answer = null, pending_answered_by = null,
         pending_mastra_run_id = null, updated_at = now()
         where run_id = $1`,
        [input.runId]
      );
      return answer;
    });
  }

  async function requestRunCancellation(input: {
    runId: RunId;
    scope: TenantScope;
    buildSessionId: BuildSessionId;
    requestedByUserId: UserId;
  }): Promise<boolean> {
    return await withTransaction(async (client) => {
      const result = await client.query<{
        cancellation_requested_at: Date | null;
        status: RunStatus;
      }>(
        `select cancellation_requested_at, status from runs
          where run_id = $1 and organization_id = $2 and project_id = $3
            and build_session_id = $4
          for update`,
        [
          input.runId,
          input.scope.organizationId,
          input.scope.projectId,
          input.buildSessionId,
        ]
      );
      const [run] = result.rows;
      if (
        !run ||
        run.status === "completed" ||
        run.status === "failed" ||
        run.status === "cancelled"
      ) {
        return false;
      }
      if (run.cancellation_requested_at !== null) {
        return true;
      }

      await client.query(
        `update runs set cancellation_requested_at = now(), updated_at = now()
          where run_id = $1`,
        [input.runId]
      );
      await insertRunEvent(client, {
        payload: { requestedByUserId: input.requestedByUserId },
        runId: input.runId,
        scope: input.scope,
        type: "run.cancel.requested",
      });
      return true;
    });
  }

  async function isRunCancellationRequested(runId: RunId): Promise<boolean> {
    const result = await pool.query(
      `select cancellation_requested_at is not null as requested
         from runs where run_id = $1`,
      [runId]
    );
    return result.rows[0]?.requested === true;
  }

  /**
   * The run's dispatch poll: the runs a claim would accept, oldest first. A run
   * is offered while it has not reached a terminal status and no live lease
   * covers it, which is exactly the predicate `beginRun` applies, so the poll
   * and the claim agree about what is runnable.
   *
   * A lapsed lease is therefore still offered — that is the only way a run
   * abandoned by a worker that died is ever picked up again — and rejection
   * here would be a decision made against a snapshot the claim is about to act
   * on anyway. Ordering is by creation, oldest first, with the run id breaking
   * ties so a fleet of workers polling the same window walks runs in the same
   * order.
   *
   * The joins are tenant-qualified on both sides, so a listing can never pair a
   * run with another tenant's build session or sandbox, and they are inner
   * joins, so a run whose session or sandbox row is missing is not offered as
   * runnable work the worker could not start.
   */
  async function listRunnableRuns(input: {
    limit: number;
  }): Promise<RunnableRun[]> {
    const result = await pool.query(
      `select r.run_id,
              r.organization_id,
              r.project_id,
              r.build_session_id,
              bs.sandbox_environment_id,
              se.workspace_uri,
              r.user_message,
              r.user_attachments,
              r.pending_tool_call_id,
              r.pending_mastra_run_id
         from runs r
         join build_sessions bs
           on bs.build_session_id = r.build_session_id
          and bs.organization_id = r.organization_id
          and bs.project_id = r.project_id
         join sandbox_environments se
           on se.sandbox_environment_id = bs.sandbox_environment_id
          and se.organization_id = r.organization_id
          and se.project_id = r.project_id
        where r.status <> all($2::text[])
          and not exists (
            select 1 from runs occupied
             where occupied.organization_id = r.organization_id
               and occupied.project_id = r.project_id
               and occupied.run_id <> r.run_id
               and occupied.status in ('running', 'awaiting_approval')
          )
          and (r.status <> 'awaiting_approval'
            or (r.pending_tool_call_id is not null and r.pending_mastra_run_id is not null))
          and not exists (
            select 1
              from run_leases lease
             where lease.run_id = r.run_id
               and lease.expires_at > now()
          )
        order by r.created_at asc, r.run_id asc
        limit $1`,
      [input.limit, [...TERMINAL_RUN_STATUSES]]
    );

    return result.rows.map((row) => ({
      buildSessionId: BuildSessionIdSchema.parse(row.build_session_id),
      organizationId: OrganizationIdSchema.parse(row.organization_id),
      pendingMastraRunId: row.pending_mastra_run_id ?? null,
      pendingToolCallId: row.pending_tool_call_id ?? null,
      projectId: ProjectIdSchema.parse(row.project_id),
      runId: RunIdSchema.parse(row.run_id),
      sandboxEnvironmentId: SandboxEnvironmentIdSchema.parse(
        row.sandbox_environment_id
      ),
      userAttachments: PromptAttachmentSchema.array().parse(
        row.user_attachments ?? []
      ),
      userMessage:
        typeof row.user_message === "string" ? row.user_message : null,
      workspaceUri: SandboxEnvironmentSchema.shape.workspaceUri.parse(
        row.workspace_uri
      ),
    }));
  }

  /**
   * The run row through the caller's tenant scope. Both the organization and
   * the project are in the predicate, so a run belonging to another tenant —
   * or to another project of the caller's own organization — is absent from the
   * result rather than fetched and filtered, which is what keeps a caller from
   * learning that it exists.
   */
  async function getRun(input: {
    organizationId: OrganizationId;
    projectId: ProjectId;
    runId: RunId;
  }): Promise<RunRecord | undefined> {
    const result = await pool.query(
      `select run_id, organization_id, project_id, build_session_id, status,
              created_at, updated_at
         from runs
        where run_id = $1
          and organization_id = $2
          and project_id = $3`,
      [input.runId, input.organizationId, input.projectId]
    );

    const [row] = result.rows;
    if (!row) {
      return undefined;
    }

    return {
      buildSessionId: BuildSessionIdSchema.parse(row.build_session_id),
      createdAt: asIso(row.created_at as Date),
      organizationId: OrganizationIdSchema.parse(row.organization_id),
      projectId: ProjectIdSchema.parse(row.project_id),
      runId: RunIdSchema.parse(row.run_id),
      status: RunStatusSchema.parse(row.status),
      updatedAt: asIso(row.updated_at as Date),
    };
  }

  /**
   * The claim. Taking the lease and moving the run to `running` is one
   * statement, so no observer ever sees a leased run that is still queued or a
   * running run without the lease that authorises it.
   *
   * The lease is written only for a run that has not reached a terminal status,
   * and against an existing lease only when that lease has lapsed. A run left
   * `running` by a worker that died is therefore reclaimable once its lease
   * expires, and the winner's lease id replaces the dead holder's — recovery
   * without ever letting two holders own one run. A live lease held by anyone,
   * including the caller itself, yields no row: `beginRun` takes or renews
   * nothing that exists, and a holder that wants more time renews it instead.
   */
  async function beginRun(input: {
    holder: string;
    runId: RunId;
    ttlMs: number;
  }): Promise<RunLeaseGrant | undefined> {
    return await withTransaction(async (client) => {
      const project = await client.query<{
        organization_id: string;
        project_id: string;
      }>(
        `select p.organization_id, p.project_id from runs r
           join projects p on p.organization_id = r.organization_id
            and p.project_id = r.project_id
          where r.run_id = $1 for update of p`,
        [input.runId]
      );
      const [projectRow] = project.rows;
      if (!projectRow) {
        return;
      }
      const competing = await client.query(
        `select 1 from runs where organization_id = $1 and project_id = $2
          and run_id <> $3 and status in ('running', 'awaiting_approval') limit 1`,
        [projectRow.organization_id, projectRow.project_id, input.runId]
      );
      if (competing.rowCount !== 0) {
        return;
      }
      const result = await client.query<{ expires_at: Date; lease_id: string }>(
        `with claimed as (
         insert into run_leases (run_id, lease_id, holder, expires_at)
         select r.run_id, $2::uuid, $3::text,
                now() + make_interval(secs => $4::double precision)
           from runs r
          where r.run_id = $1::uuid
            and r.status <> all($5::text[])
         on conflict (run_id) do update
            set lease_id = excluded.lease_id,
                holder = excluded.holder,
                expires_at = excluded.expires_at,
                updated_at = now()
          where run_leases.expires_at <= now()
         returning lease_id, expires_at
       )
       update runs
          set status = case when runs.status = 'awaiting_approval'
            then 'awaiting_approval' else 'running' end, updated_at = now()
         from claimed
        where runs.run_id = $1::uuid
          and runs.status <> all($5::text[])
       returning claimed.lease_id, claimed.expires_at`,
        [
          input.runId,
          randomUUID(),
          input.holder,
          input.ttlMs / 1000,
          [...TERMINAL_RUN_STATUSES],
        ]
      );

      const [row] = result.rows;
      if (!row) {
        return;
      }

      await client.query(
        `update build_sessions bs set status = 'running', updated_at = now()
         from runs r where r.run_id = $1 and bs.build_session_id = r.build_session_id`,
        [input.runId]
      );
      await client.query(
        `update sandbox_environments se set status = 'running', updated_at = now()
         from runs r where r.run_id = $1 and se.build_session_id = r.build_session_id`,
        [input.runId]
      );

      return { expiresAt: row.expires_at, leaseId: row.lease_id };
    });
  }

  /**
   * Extends a live lease in place. Every part of the identity is matched — the
   * lease id, the holder, and the fact that it has not already lapsed — so a
   * renewal can never revive a lease another worker may already have taken
   * over, and an expired one is reported as `false` for the holder to act on
   * instead of being quietly extended. The lease id survives the renewal, which
   * is what lets the holder release or finish with the id it was granted.
   */
  async function renewRunLease(input: {
    holder: string;
    leaseId: string;
    ttlMs: number;
  }): Promise<boolean> {
    const result = await pool.query(
      `update run_leases
          set expires_at = now() + make_interval(secs => $3::double precision),
              updated_at = now()
        where lease_id = $1::uuid
          and holder = $2::text
          and expires_at > now()
        returning run_id`,
      [input.leaseId, input.holder, input.ttlMs / 1000]
    );

    return result.rowCount === 1;
  }

  /**
   * The run's end. Releasing the lease and writing the terminal status are one
   * transaction, so a run is never left terminal while a live lease still
   * covers it, nor running after it has ended.
   *
   * The release matches only the caller's own lease identity, and the status
   * write is refused while any live lease remains, so a holder whose lease
   * lapsed and was taken over cannot end someone else's run. The call is
   * idempotent: a repeat after a crash finds the lease already gone and the run
   * already at the requested status and still reports success, while a run that
   * ended differently — the first terminal outcome stands — reports `false`
   * rather than reporting work that did not happen.
   */
  async function finishRun(input: {
    holder: string;
    leaseId: string;
    runId: RunId;
    status: RunFinishStatus;
  }): Promise<boolean> {
    const status = FINISHED_RUN_STATUS[input.status];

    return await withTransaction(async (client) => {
      await client.query(
        `delete from run_leases
          where run_id = $1
            and lease_id = $2
            and holder = $3`,
        [input.runId, input.leaseId, input.holder]
      );

      await client.query(
        `update runs
            set status = $2, updated_at = now()
          where run_id = $1
            and status <> all($3::text[])
            and not exists (
              select 1
                from run_leases lease
               where lease.run_id = $1
                 and lease.expires_at > now()
            )`,
        [input.runId, status, [...TERMINAL_RUN_STATUSES]]
      );

      const current = await client.query<{
        build_session_id: string;
        status: string;
      }>("select build_session_id, status from runs where run_id = $1", [
        input.runId,
      ]);
      const [finished] = current.rows;
      if (finished?.status !== status) {
        return false;
      }
      await client.query(
        `update build_sessions
            set status = $2, updated_at = now()
          where build_session_id = $1 and run_id = $3`,
        [
          finished.build_session_id,
          status === "completed" ? "ready" : "blocked",
          input.runId,
        ]
      );
      await client.query(
        `update sandbox_environments
            set status = 'destroyed', updated_at = now()
          where build_session_id = $1`,
        [finished.build_session_id]
      );
      return true;
    });
  }

  /**
   * The event is written through this transaction's client rather than the
   * pool, which is what makes an organization, its owner membership, and the
   * record of its creation one atomic change: a failure anywhere in it rolls
   * back all three, so neither an ownerless tenant nor an unrecorded one can
   * survive. The identifier is taken from the event when the caller already
   * minted it, and the event is stored with whichever identifier this
   * transaction committed.
   */
  async function createOrganizationWithOwner(input: {
    audit: AuditEvent;
    name: string;
    userId: UserId;
  }): Promise<CreateOrganizationResponse> {
    return await withTransaction(async (client) => {
      const organizationId =
        input.audit.organizationId ?? OrganizationIdSchema.parse(randomUUID());

      await client.query(
        "insert into organizations (organization_id, name) values ($1, $2)",
        [organizationId, input.name]
      );

      await client.query(
        `insert into organization_memberships
           (organization_id, user_id, role, status)
         values ($1, $2, 'owner', 'active')`,
        [organizationId, input.userId]
      );

      await recordWith(client, { ...input.audit, organizationId });

      return CreateOrganizationResponseSchema.parse({
        membershipRole: "owner",
        name: input.name,
        organizationId,
      });
    });
  }

  /**
   * The rename and its audit row commit together, so a rename that nothing
   * recorded cannot exist, and a rename of an organization that is gone reports
   * that it did not happen rather than inventing a success.
   */
  async function renameOrganization(input: {
    audit: AuditEvent;
    name: string;
    organizationId: OrganizationId;
  }): Promise<boolean> {
    return await withTransaction(async (client) => {
      const updated = await client.query(
        "update organizations set name = $2 where organization_id = $1",
        [input.organizationId, input.name]
      );
      if (updated.rowCount !== 1) {
        return false;
      }
      await recordWith(client, input.audit);
      return true;
    });
  }

  /**
   * Project, membership, and audit row commit together, as organization
   * creation does. The project identifier is taken from the event when the
   * caller minted it, and the audit row is stamped with the organization the
   * caller was authorized for rather than with whatever the event named, so a
   * trail entry cannot describe a project in an organization the creation did
   * not use.
   */
  async function createProject(input: {
    audit: AuditEvent;
    name: string;
    organizationId: OrganizationId;
    role: ProjectRole;
    userId: UserId;
  }): Promise<ProjectView> {
    return await withTransaction(async (client) => {
      const projectId =
        input.audit.projectId ?? ProjectIdSchema.parse(randomUUID());

      await client.query(
        `insert into projects (project_id, organization_id, name)
         values ($1, $2, $3)`,
        [projectId, input.organizationId, input.name]
      );

      await client.query(
        `insert into project_memberships
           (organization_id, project_id, user_id, role, status)
         values ($1, $2, $3, $4, 'active')`,
        [input.organizationId, projectId, input.userId, input.role]
      );

      await recordWith(client, {
        ...input.audit,
        organizationId: input.organizationId,
        projectId,
      });

      return ProjectViewSchema.parse({
        name: input.name,
        organizationId: input.organizationId,
        projectId,
        role: input.role,
      });
    });
  }

  async function claimRunLease(input: {
    holder: string;
    runId: RunId;
    scope: TenantScope;
    ttlMs: number;
  }): Promise<RunLease | undefined> {
    const result = await pool.query<{
      expires_at: Date;
      holder: string;
      lease_id: string;
      run_id: string;
    }>(
      `insert into run_leases (run_id, lease_id, holder, expires_at)
       select r.run_id, $3::uuid, $4::text,
              now() + make_interval(secs => $5::double precision)
         from runs r
        where r.run_id = $1::uuid
          and r.organization_id = $2::uuid
          and r.project_id = $6::uuid
       on conflict (run_id) do update
          set lease_id = excluded.lease_id,
              holder = excluded.holder,
              expires_at = excluded.expires_at,
              updated_at = now()
        where run_leases.expires_at <= now()
           or run_leases.holder = excluded.holder
       returning lease_id, holder, expires_at, run_id`,
      [
        input.runId,
        input.scope.organizationId,
        randomUUID(),
        input.holder,
        input.ttlMs / 1000,
        input.scope.projectId,
      ]
    );

    const [row] = result.rows;
    if (!row) {
      return undefined;
    }

    return RunLeaseSchema.parse({
      expiresAt: asIso(row.expires_at),
      holder: row.holder,
      leaseId: row.lease_id,
      runId: row.run_id,
    });
  }

  async function releaseRunLease(input: {
    leaseId: string;
    runId: RunId;
    scope: TenantScope;
  }): Promise<boolean> {
    const result = await pool.query(
      `delete from run_leases lease
        using runs r
        where lease.run_id = r.run_id
          and lease.run_id = $1
          and lease.lease_id = $2
          and r.organization_id = $3
          and r.project_id = $4
        returning lease.run_id`,
      [
        input.runId,
        input.leaseId,
        input.scope.organizationId,
        input.scope.projectId,
      ]
    );

    return result.rowCount === 1;
  }

  async function setRunStatus(input: {
    runId: RunId;
    scope: TenantScope;
    status: RunStatus;
  }): Promise<boolean> {
    const result = await pool.query(
      `update runs
          set status = $4, updated_at = now()
        where run_id = $1 and organization_id = $2 and project_id = $3`,
      [
        input.runId,
        input.scope.organizationId,
        input.scope.projectId,
        input.status,
      ]
    );

    return result.rowCount === 1;
  }

  async function listConversationEvents(input: {
    buildSessionId: BuildSessionId;
    scope: TenantScope;
    after: number;
    limit: number;
  }): Promise<RunEventEnvelope[]> {
    const result = await pool.query(
      `select e.* from run_events e join runs r on r.run_id = e.run_id
       and r.organization_id = e.organization_id and r.project_id = e.project_id
       where r.build_session_id = $1 and e.organization_id = $2 and e.project_id = $3
       order by r.created_at, r.run_id, e.sequence limit $4 offset $5`,
      [
        input.buildSessionId,
        input.scope.organizationId,
        input.scope.projectId,
        Math.min(input.limit, 500),
        input.after,
      ]
    );
    return result.rows.map((row) =>
      RunEventEnvelopeSchema.parse({
        eventId: row.event_id,
        occurredAt: asIso(row.occurred_at as Date),
        organizationId: row.organization_id,
        payload: row.payload,
        projectId: row.project_id,
        runId: row.run_id,
        schemaVersion: 1,
        sequence: Number(row.sequence),
        type: row.type,
      })
    );
  }

  async function listRunEvents(input: {
    afterSequence: number;
    limit: number;
    runId: RunId;
    scope: TenantScope;
  }): Promise<RunEventEnvelope[]> {
    const result = await pool.query(
      `select run_id, sequence, event_id, organization_id, project_id,
              type, payload, occurred_at
         from run_events
        where run_id = $1
          and organization_id = $2
          and project_id = $3
          and sequence > $4
        order by sequence asc
        limit $5`,
      [
        input.runId,
        input.scope.organizationId,
        input.scope.projectId,
        input.afterSequence,
        input.limit,
      ]
    );

    return result.rows.map((row) =>
      RunEventEnvelopeSchema.parse({
        eventId: row.event_id,
        occurredAt: asIso(row.occurred_at as Date),
        organizationId: row.organization_id,
        payload: row.payload,
        projectId: row.project_id,
        runId: row.run_id,
        schemaVersion: 1,
        sequence: Number(row.sequence),
        type: row.type,
      })
    );
  }

  async function listPendingOutbox(limit: number): Promise<OutboxRecord[]> {
    const result = await pool.query<{
      outbox_id: string;
      payload: unknown;
      topic: string;
    }>(
      `select outbox_id, topic, payload
         from outbox
        where published_at is null
        order by outbox_id asc
        limit $1`,
      [limit]
    );

    return result.rows.map((row) => ({
      outboxId: String(row.outbox_id),
      payload: RunEventEnvelopeSchema.parse(row.payload),
      topic: row.topic,
    }));
  }

  async function markOutboxPublished(outboxIds: number[]): Promise<void> {
    if (outboxIds.length === 0) {
      return;
    }

    await pool.query(
      `update outbox
          set published_at = now()
        where outbox_id = any($1::bigint[])
          and published_at is null`,
      [outboxIds]
    );
  }

  /**
   * Takes rows for one relay. `for update skip locked` makes the read and the
   * mark one transaction, so a row is either this relay's or invisible to the
   * other relay running the same statement, never both. The mark is what makes
   * the claim outlive the transaction; the lease in the predicate is what lets
   * a relay that died mid-batch be recovered by the next one.
   */
  async function claimOutbox(limit: number): Promise<OutboxClaim[]> {
    return await withTransaction(async (client) => {
      const result = await client.query<{
        outbox_id: string;
        payload: unknown;
        topic: string;
      }>(
        `select outbox_id, topic, payload
           from outbox
          where published_at is null
            and (claimed_at is null
                 or claimed_at < now() - make_interval(secs => $2::double precision))
          order by outbox_id asc
          limit $1
          for update skip locked`,
        [limit, OUTBOX_CLAIM_LEASE_MS / 1000]
      );

      const claimed = result.rows.map((row) => ({
        outboxId: String(row.outbox_id),
        payload: row.payload,
        topic: row.topic,
      }));

      if (claimed.length > 0) {
        await client.query(
          `update outbox
              set claimed_at = now()
            where outbox_id = any($1::bigint[])`,
          [claimed.map(({ outboxId }) => Number(outboxId))]
        );
      }

      return claimed;
    });
  }

  async function recordArtifact(
    manifest: ArtifactManifest,
    status: string
  ): Promise<ArtifactRecord> {
    const result = await pool.query(
      `insert into artifacts
         (artifact_id, organization_id, project_id, build_session_id, run_id,
          kind, manifest_object_key, sha256, total_size, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning artifact_id, kind, manifest_object_key, sha256, total_size,
                 status, created_at`,
      [
        manifest.artifactId,
        manifest.organizationId,
        manifest.projectId,
        manifest.buildSessionId,
        manifest.runId,
        manifest.kind,
        `organizations/${manifest.organizationId}/projects/${manifest.projectId}/artifacts/${manifest.artifactId}/manifest.json`,
        manifest.files[0]?.sha256 ?? "",
        manifest.totalSize,
        status,
      ]
    );

    const [row] = result.rows;
    if (!row) {
      throw new Error("Artifact insert returned no row.");
    }

    return {
      artifactId: row.artifact_id,
      createdAt: asIso(row.created_at as Date),
      kind: row.kind,
      manifestObjectKey: row.manifest_object_key,
      sha256: row.sha256,
      status: row.status,
      totalSize: Number(row.total_size),
    };
  }

  async function listArtifacts(scope: TenantScope): Promise<ArtifactRecord[]> {
    const result = await pool.query(
      `select artifact_id, kind, manifest_object_key, sha256, total_size,
              status, created_at
         from artifacts
        where organization_id = $1 and project_id = $2
        order by created_at desc`,
      [scope.organizationId, scope.projectId]
    );

    return result.rows.map((row) => ({
      artifactId: row.artifact_id,
      createdAt: asIso(row.created_at as Date),
      kind: row.kind,
      manifestObjectKey: row.manifest_object_key,
      sha256: row.sha256,
      status: row.status,
      totalSize: Number(row.total_size),
    }));
  }

  /**
   * Only active memberships are listed. An invited or suspended membership is
   * not a tenancy the caller can act in, and the session view has no field that
   * could qualify it, so offering one would present an organization that every
   * authorization decision afterwards refuses.
   */
  async function listOrganizationMemberships(input: {
    userId: UserId;
  }): Promise<OrganizationSummary[]> {
    const result = await pool.query(
      `select o.organization_id, o.name, m.role
         from organization_memberships m
         join organizations o on o.organization_id = m.organization_id
        where m.user_id = $1
          and m.status = 'active'
        order by o.created_at asc, o.organization_id asc`,
      [input.userId]
    );

    return result.rows.map((row) =>
      OrganizationSummarySchema.parse({
        name: row.name,
        organizationId: row.organization_id,
        role: row.role,
      })
    );
  }

  async function listProjectsForUser(input: {
    includeAll: boolean;
    organizationId: OrganizationId;
    userId: UserId;
  }): Promise<ProjectSummary[]> {
    const result = await pool.query(
      `select p.organization_id, p.project_id, p.name
         from projects p
        where p.organization_id = $1
          and ($3::boolean or exists (
            select 1 from project_memberships m
             where m.organization_id = p.organization_id
               and m.project_id = p.project_id
               and m.user_id = $2 and m.status = 'active'
          ))
        order by p.created_at desc, p.project_id desc`,
      [input.organizationId, input.userId, input.includeAll]
    );
    return result.rows.map((row) =>
      ProjectSummarySchema.parse({
        name: row.name,
        organizationId: row.organization_id,
        projectId: row.project_id,
      })
    );
  }

  async function recordDeployment(input: {
    deploymentId: string;
    exposure: string;
    providerReference: string;
    runId: RunId;
    scope: TenantScope;
    sourceCheckpoint: string;
    status: string;
    url: string | null;
  }): Promise<DeploymentRecord> {
    const result = await pool.query(
      `insert into deployments
         (deployment_id, organization_id, project_id, run_id, status, exposure,
          url, provider_reference, source_checkpoint)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning deployment_id, exposure, provider_reference, source_checkpoint,
                 status, url, updated_at`,
      [
        input.deploymentId,
        input.scope.organizationId,
        input.scope.projectId,
        input.runId,
        input.status,
        input.exposure,
        input.url,
        input.providerReference,
        input.sourceCheckpoint,
      ]
    );

    const [row] = result.rows;
    if (!row) {
      throw new Error("Deployment insert returned no row.");
    }

    return {
      deploymentId: row.deployment_id,
      exposure: row.exposure,
      providerReference: row.provider_reference,
      sourceCheckpoint: row.source_checkpoint,
      status: row.status,
      updatedAt: asIso(row.updated_at as Date),
      url: row.url,
    };
  }

  async function getBuildSession(
    scope: TenantScope,
    buildSessionId: BuildSessionId
  ): Promise<BuildSession | undefined> {
    const client = await pool.connect();
    try {
      return await loadBuildSession(client, scope, buildSessionId);
    } finally {
      client.release();
    }
  }

  return {
    allocateBuildSession,
    answerRunQuestion,
    appendConversationTurn,
    appendRunEvent,
    audit,
    beginRun,
    claimRunLease,
    close: async () => {
      await rateLimiter.close();
      await pool.end();
    },
    createOrganizationWithOwner,
    createProject,
    finishRun,
    getBuildSession,
    getConversationRetry,
    getRun,
    isRunCancellationRequested,
    listArtifacts,
    listConversationEvents,
    listConversationMessages,
    listConversations,
    listOrganizationMemberships,
    listPendingOutbox,
    listProjectsForUser,
    listRunEvents,
    listRunnableRuns,
    magicLinks,
    markOutboxPublished,
    memberships,
    migrate: async () => {
      // `create table if not exists` is not concurrency-safe: two processes
      // racing the same DDL collide in the system catalog, so replicas starting
      // together serialize on a transaction-scoped advisory lock that releases
      // when the migration transaction ends. The retry covers the other half of
      // the problem: DDL takes an access-exclusive lock, and a writer that holds
      // a read lock while it upgrades past that queued request deadlocks with
      // the migration. Bounded lock waiting plus a retry keeps both moving.
      const attemptMigration = async (attempt: number): Promise<void> => {
        try {
          await withTransaction(async (client) => {
            await client.query(
              `set local lock_timeout = '${MIGRATION_LOCK_TIMEOUT_MS}ms'`
            );
            await client.query("select pg_advisory_xact_lock($1)", [
              MIGRATION_LOCK_KEY,
            ]);
            await client.query(PROJECT_STATE_MIGRATION_SQL);
            await client.query(RUN_STEERING_MIGRATION_SQL);
            await client.query(AUTH_SESSION_MIGRATION_SQL);
            await client.query(MEMBERSHIP_MIGRATION_SQL);
            await client.query(USAGE_MIGRATION_SQL);
            // Both reference the organization, project, and user tables above,
            // so they are applied after them in this same transaction.
            await client.query(AUTH_TOKEN_MIGRATION_SQL);
            await client.query(AUDIT_MIGRATION_SQL);
          });
        } catch (error) {
          if (
            attempt >= MIGRATION_ATTEMPTS ||
            !isRetryableMigrationError(error)
          ) {
            throw error;
          }

          await wait(MIGRATION_RETRY_DELAY_MS * attempt);
          await attemptMigration(attempt + 1);
        }
      };

      await attemptMigration(1);
    },
    outbox: { claim: claimOutbox },
    rateLimiter,
    recordArtifact,
    recordDeployment,
    releaseRunLease,
    renameOrganization,
    renewRunLease,
    requestRunCancellation,
    retryConversationRun,
    sessions,
    setRunStatus,
    steering,
    takeRunAnswer,
    usage,
    users,
  };
}
