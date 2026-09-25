import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import {
  type CreateOrganizationResponse,
  CreateOrganizationResponseSchema,
  type OrganizationSummary,
  OrganizationSummarySchema,
  type ProjectView,
  ProjectViewSchema,
} from "@reasonateai/contracts/auth";
import {
  type BuildSession,
  type BuildSessionId,
  BuildSessionIdSchema,
  BuildSessionSchema,
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
  projectId: ProjectId;
  runId: RunId;
  sandboxEnvironmentId: SandboxEnvironmentId;
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

const ACTIVE_BUILD_SESSION_STATUSES = [
  "provisioning",
  "ready",
  "running",
  "awaiting_approval",
  "blocked",
] as const;

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
    idempotencyKey: string;
    scope: TenantScope;
    userSessionId: SessionId;
  }) => Promise<BuildSessionAllocation>;
  appendRunEvent: (input: {
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
  getRun: (input: {
    organizationId: OrganizationId;
    projectId: ProjectId;
    runId: RunId;
  }) => Promise<RunRecord | undefined>;
  listArtifacts: (scope: TenantScope) => Promise<ArtifactRecord[]>;
  /**
   * The caller's own organizations, for the session view. Membership is
   * resolved from the caller's identifier and nowhere else, so a caller cannot
   * ask about another user's tenancy.
   */
  listOrganizationMemberships: (input: {
    userId: UserId;
  }) => Promise<OrganizationSummary[]>;
  listPendingOutbox: (limit: number) => Promise<OutboxRecord[]>;
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
  sessions: SessionRepository;
  setRunStatus: (input: {
    runId: RunId;
    scope: TenantScope;
    status: RunStatus;
  }) => Promise<boolean>;
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

  async function allocateBuildSession(input: {
    idempotencyKey: string;
    scope: TenantScope;
    userSessionId: SessionId;
  }): Promise<BuildSessionAllocation> {
    return await withTransaction(async (client) => {
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

      const active = await client.query<{ build_session_id: string }>(
        `select build_session_id from build_sessions
          where organization_id = $1
            and project_id = $2
            and status = any($3::text[])
          limit 1`,
        [
          input.scope.organizationId,
          input.scope.projectId,
          [...ACTIVE_BUILD_SESSION_STATUSES],
        ]
      );

      const [activeRow] = active.rows;
      if (activeRow) {
        await client.query(
          `insert into idempotency_records
             (organization_id, scope, idempotency_key, build_session_id)
           values ($1, $2, $3, $4)
           on conflict do nothing`,
          [
            input.scope.organizationId,
            "build-session.allocate",
            input.idempotencyKey,
            activeRow.build_session_id,
          ]
        );
        return await requireAllocation(
          client,
          input.scope,
          activeRow.build_session_id,
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
           (run_id, organization_id, project_id, build_session_id, status)
         values ($1, $2, $3, $4, 'queued')`,
        [
          runId,
          input.scope.organizationId,
          input.scope.projectId,
          buildSessionId,
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

  async function appendRunEvent(input: {
    payload: Record<string, unknown>;
    runId: RunId;
    scope: TenantScope;
    type: RunEventType;
  }): Promise<RunEventEnvelope> {
    return await withTransaction(
      async (client) => await insertRunEvent(client, input)
    );
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
              se.workspace_uri
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
      projectId: ProjectIdSchema.parse(row.project_id),
      runId: RunIdSchema.parse(row.run_id),
      sandboxEnvironmentId: SandboxEnvironmentIdSchema.parse(
        row.sandbox_environment_id
      ),
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
    const result = await pool.query<{ expires_at: Date; lease_id: string }>(
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
          set status = 'running', updated_at = now()
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
      return undefined;
    }

    return { expiresAt: row.expires_at, leaseId: row.lease_id };
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

      const current = await client.query<{ status: string }>(
        "select status from runs where run_id = $1",
        [input.runId]
      );

      return current.rows[0]?.status === status;
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
    getRun,
    listArtifacts,
    listOrganizationMemberships,
    listPendingOutbox,
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
    renewRunLease,
    sessions,
    setRunStatus,
    usage,
    users,
  };
}
