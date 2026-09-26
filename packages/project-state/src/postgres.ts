import { randomUUID } from "node:crypto";
import {
  type BuildSession,
  type BuildSessionId,
  BuildSessionSchema,
  type CheckpointId,
  type EvidenceId,
  type EvidenceKind,
  type EvidenceRecord,
  EvidenceRecordSchema,
  type EvidenceStatus,
  type FailureDetails,
  FailureDetailsSchema,
  type GitCheckpoint,
  GitCheckpointSchema,
  type PreviewId,
  type PreviewSession,
  PreviewSessionSchema,
  type PreviewStatus,
  type SandboxEnvironment,
  type SandboxEnvironmentId,
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
  runEventTopic,
} from "@reasonateai/contracts/execution-protocol";
import type {
  OrganizationId,
  ProjectId,
  RunId,
  SessionId,
} from "@reasonateai/contracts/identity";
import { Pool, type PoolClient } from "pg";
import { MEMBERSHIP_MIGRATION_SQL } from "./membership-schema.js";
import {
  createMembershipRepository,
  type MembershipRepository,
} from "./memberships.js";
import { PROJECT_STATE_MIGRATION_SQL } from "./schema.js";
import { AUTH_SESSION_MIGRATION_SQL } from "./session-schema.js";
import { createSessionRepository, type SessionRepository } from "./sessions.js";

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
  rollbackDeploymentId: string | null;
  sourceCheckpoint: string;
  status: string;
  updatedAt: string;
  url: string | null;
}

const ACTIVE_BUILD_SESSION_STATUSES = [
  "provisioning",
  "ready",
  "running",
  "awaiting_approval",
  "blocked",
] as const;

/**
 * Arbitrary but stable advisory-lock key for this schema's migrations. Any
 * value works as long as every migrator in the fleet uses the same one.
 */
const MIGRATION_LOCK_KEY = 8_274_196_301_552_001;

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

function toGitCheckpoint(row: Record<string, unknown>): GitCheckpoint {
  return GitCheckpointSchema.parse({
    author: row.author,
    buildSessionId: row.build_session_id,
    checkpointId: row.checkpoint_id,
    commitHash: row.commit_hash,
    message: row.message,
    occurredAt: asIso(row.created_at as Date),
    organizationId: row.organization_id,
    parentHash: row.parent_hash ?? null,
    projectId: row.project_id,
    runId: row.run_id,
  });
}

function toPreviewSession(row: Record<string, unknown>): PreviewSession {
  return PreviewSessionSchema.parse({
    buildSessionId: row.build_session_id,
    createdAt: asIso(row.created_at as Date),
    errorDetails: row.error_details
      ? FailureDetailsSchema.parse(row.error_details)
      : null,
    expiresAt: asIso(row.expires_at as Date),
    healthUrl: (row.health_url as string | null) ?? null,
    organizationId: row.organization_id,
    port: Number(row.port),
    previewId: row.preview_id,
    projectId: row.project_id,
    proxyUrl: (row.proxy_url as string | null) ?? null,
    sandboxEnvironmentId: row.sandbox_environment_id,
    sandboxId: row.sandbox_id,
    status: row.status,
    updatedAt: asIso(row.updated_at as Date),
  });
}

function toEvidenceRecord(row: Record<string, unknown>): EvidenceRecord {
  return EvidenceRecordSchema.parse({
    artifactId: row.artifact_id,
    buildSessionId: row.build_session_id ?? null,
    createdAt: asIso(row.created_at as Date),
    evidenceId: row.evidence_id,
    kind: row.kind,
    metadata: (row.metadata as Record<string, unknown> | null) ?? {},
    organizationId: row.organization_id,
    projectId: row.project_id,
    runId: row.run_id ?? null,
    status: row.status,
    summary: row.summary,
  });
}

function toDeploymentRecord(row: Record<string, unknown>): DeploymentRecord {
  return {
    deploymentId: row.deployment_id as string,
    exposure: row.exposure as string,
    providerReference: row.provider_reference as string,
    rollbackDeploymentId: (row.rollback_deployment_id as string | null) ?? null,
    sourceCheckpoint: row.source_checkpoint as string,
    status: row.status as string,
    updatedAt: asIso(row.updated_at as Date),
    url: (row.url as string | null) ?? null,
  };
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
  claimRunLease: (input: {
    holder: string;
    runId: RunId;
    scope: TenantScope;
    ttlMs: number;
  }) => Promise<RunLease | undefined>;
  close: () => Promise<void>;
  createPreview: (input: {
    buildSessionId: BuildSessionId;
    errorDetails?: FailureDetails | null;
    expiresAt: string;
    healthUrl?: string | null;
    port: number;
    proxyUrl?: string | null;
    sandboxEnvironmentId: SandboxEnvironmentId;
    sandboxId: string;
    scope: TenantScope;
    status: PreviewStatus;
  }) => Promise<PreviewSession>;
  getBuildSession: (
    scope: TenantScope,
    buildSessionId: BuildSessionId
  ) => Promise<BuildSession | undefined>;
  getCheckpoint: (
    scope: TenantScope,
    checkpointId: CheckpointId | string
  ) => Promise<GitCheckpoint | undefined>;
  getDeployment: (
    scope: TenantScope,
    deploymentId: string
  ) => Promise<DeploymentRecord | undefined>;
  getEvidence: (
    scope: TenantScope,
    evidenceId: EvidenceId | string
  ) => Promise<EvidenceRecord | undefined>;
  getPreview: (
    scope: TenantScope,
    previewId: PreviewId | string
  ) => Promise<PreviewSession | undefined>;
  listActivePreviews: (
    scope: TenantScope,
    buildSessionId?: BuildSessionId
  ) => Promise<PreviewSession[]>;
  listArtifacts: (scope: TenantScope) => Promise<ArtifactRecord[]>;
  listCheckpoints: (
    scope: TenantScope,
    buildSessionId?: BuildSessionId
  ) => Promise<GitCheckpoint[]>;
  listDeployments: (scope: TenantScope) => Promise<DeploymentRecord[]>;
  listEvidence: (
    scope: TenantScope,
    filters?: {
      buildSessionId?: BuildSessionId;
      kind?: EvidenceKind;
      runId?: RunId;
    }
  ) => Promise<EvidenceRecord[]>;
  listPendingOutbox: (limit: number) => Promise<OutboxRecord[]>;
  listRunEvents: (input: {
    afterSequence: number;
    limit: number;
    runId: RunId;
    scope: TenantScope;
  }) => Promise<RunEventEnvelope[]>;
  markOutboxPublished: (outboxIds: number[]) => Promise<void>;
  memberships: MembershipRepository;
  migrate: () => Promise<void>;
  recordArtifact: (
    manifest: ArtifactManifest,
    status: string
  ) => Promise<ArtifactRecord>;
  recordCheckpoint: (input: {
    author: string;
    buildSessionId: BuildSessionId;
    commitHash: string;
    message: string;
    parentHash?: string | null;
    runId: RunId;
    scope: TenantScope;
  }) => Promise<GitCheckpoint>;
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
  recordEvidence: (input: {
    artifactId: string;
    buildSessionId?: BuildSessionId | null;
    kind: EvidenceKind;
    metadata?: Record<string, unknown>;
    runId?: RunId | null;
    scope: TenantScope;
    status: EvidenceStatus;
    summary: string;
  }) => Promise<EvidenceRecord>;
  releaseRunLease: (input: {
    leaseId: string;
    runId: RunId;
    scope: TenantScope;
  }) => Promise<boolean>;
  rollbackDeployment: (input: {
    deploymentId: string;
    reason: string;
    scope: TenantScope;
    targetDeploymentId: string;
  }) => Promise<{
    activeDeployment: DeploymentRecord;
    rolledBackDeployment: DeploymentRecord;
  }>;
  sessions: SessionRepository;
  setRunStatus: (input: {
    runId: RunId;
    scope: TenantScope;
    status: RunStatus;
  }) => Promise<boolean>;
  updatePreviewStatus: (input: {
    errorDetails?: FailureDetails | null;
    healthUrl?: string | null;
    previewId: PreviewId | string;
    proxyUrl?: string | null;
    scope: TenantScope;
    status: PreviewStatus;
  }) => Promise<PreviewSession>;
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
                 status, url, rollback_deployment_id, updated_at`,
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

    return toDeploymentRecord(row);
  }

  async function recordCheckpoint(input: {
    author: string;
    buildSessionId: BuildSessionId;
    commitHash: string;
    message: string;
    parentHash?: string | null;
    runId: RunId;
    scope: TenantScope;
  }): Promise<GitCheckpoint> {
    return await withTransaction(async (client) => {
      const checkpointId = randomUUID();
      const result = await client.query(
        `insert into checkpoints
           (checkpoint_id, organization_id, project_id, build_session_id, run_id,
            commit_hash, parent_hash, message, author)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         returning *`,
        [
          checkpointId,
          input.scope.organizationId,
          input.scope.projectId,
          input.buildSessionId,
          input.runId,
          input.commitHash,
          input.parentHash ?? null,
          input.message,
          input.author,
        ]
      );

      const [row] = result.rows;
      if (!row) {
        throw new Error("Checkpoint insert returned no row.");
      }

      const checkpoint = toGitCheckpoint(row);

      await insertRunEvent(client, {
        payload: {
          author: checkpoint.author,
          buildSessionId: checkpoint.buildSessionId,
          checkpointId: checkpoint.checkpointId,
          commitHash: checkpoint.commitHash,
          message: checkpoint.message,
          parentHash: checkpoint.parentHash,
        },
        runId: input.runId,
        scope: input.scope,
        type: "checkpoint.created",
      });

      return checkpoint;
    });
  }

  async function listCheckpoints(
    scope: TenantScope,
    buildSessionId?: BuildSessionId
  ): Promise<GitCheckpoint[]> {
    const params: unknown[] = [scope.organizationId, scope.projectId];
    let query = `select * from checkpoints
                  where organization_id = $1 and project_id = $2`;
    if (buildSessionId) {
      params.push(buildSessionId);
      query += " and build_session_id = $3";
    }
    query += " order by created_at desc";

    const result = await pool.query(query, params);
    return result.rows.map(toGitCheckpoint);
  }

  async function getCheckpoint(
    scope: TenantScope,
    checkpointId: CheckpointId | string
  ): Promise<GitCheckpoint | undefined> {
    const result = await pool.query(
      `select * from checkpoints
        where checkpoint_id = $1
          and organization_id = $2
          and project_id = $3`,
      [checkpointId, scope.organizationId, scope.projectId]
    );
    const [row] = result.rows;
    return row ? toGitCheckpoint(row) : undefined;
  }

  function resolvePreviewEventType(status: PreviewStatus): RunEventType {
    if (status === "failed") {
      return "preview.failed";
    }
    if (status === "ready") {
      return "preview.ready";
    }
    return "preview.updated";
  }

  async function findPreviewWithRunId(
    client: {
      query: <T = Record<string, unknown>>(
        q: string,
        params: unknown[]
      ) => Promise<{ rows: T[] }>;
    },
    scope: TenantScope,
    previewId: PreviewId | string
  ) {
    const existing = await client.query<{
      run_id: string;
      health_url: string | null;
      proxy_url: string | null;
      error_details: unknown;
    }>(
      `select p.*, b.run_id from previews p
         join build_sessions b on p.build_session_id = b.build_session_id
        where p.preview_id = $1
          and p.organization_id = $2
          and p.project_id = $3`,
      [previewId, scope.organizationId, scope.projectId]
    );

    const [existingRow] = existing.rows;
    if (!existingRow) {
      throw new Error("Preview session does not exist in scope.");
    }
    return existingRow;
  }

  async function createPreview(input: {
    buildSessionId: BuildSessionId;
    errorDetails?: FailureDetails | null;
    expiresAt: string;
    healthUrl?: string | null;
    port: number;
    proxyUrl?: string | null;
    sandboxEnvironmentId: SandboxEnvironmentId;
    sandboxId: string;
    scope: TenantScope;
    status: PreviewStatus;
  }): Promise<PreviewSession> {
    return await withTransaction(async (client) => {
      const sessionResult = await client.query<{ run_id: string }>(
        `select run_id from build_sessions
          where build_session_id = $1 and organization_id = $2 and project_id = $3`,
        [
          input.buildSessionId,
          input.scope.organizationId,
          input.scope.projectId,
        ]
      );
      const [sessionRow] = sessionResult.rows;
      if (!sessionRow) {
        throw new Error("Referenced build session does not exist in scope.");
      }

      const previewId = randomUUID();
      const result = await client.query(
        `insert into previews
           (preview_id, organization_id, project_id, build_session_id,
            sandbox_environment_id, sandbox_id, port, status, health_url,
            proxy_url, error_details, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::timestamptz)
         returning *`,
        [
          previewId,
          input.scope.organizationId,
          input.scope.projectId,
          input.buildSessionId,
          input.sandboxEnvironmentId,
          input.sandboxId,
          input.port,
          input.status,
          input.healthUrl ?? null,
          input.proxyUrl ?? null,
          input.errorDetails ? JSON.stringify(input.errorDetails) : null,
          input.expiresAt,
        ]
      );

      const [row] = result.rows;
      if (!row) {
        throw new Error("Preview insert returned no row.");
      }

      const preview = toPreviewSession(row);

      const eventType = resolvePreviewEventType(input.status);

      await insertRunEvent(client, {
        payload: {
          buildSessionId: preview.buildSessionId,
          port: preview.port,
          previewId: preview.previewId,
          sandboxId: preview.sandboxId,
          status: preview.status,
        },
        runId: sessionRow.run_id as RunId,
        scope: input.scope,
        type: eventType,
      });

      return preview;
    });
  }

  async function getPreview(
    scope: TenantScope,
    previewId: PreviewId | string
  ): Promise<PreviewSession | undefined> {
    const result = await pool.query(
      `select * from previews
        where preview_id = $1
          and organization_id = $2
          and project_id = $3`,
      [previewId, scope.organizationId, scope.projectId]
    );
    const [row] = result.rows;
    return row ? toPreviewSession(row) : undefined;
  }

  async function updatePreviewStatus(input: {
    errorDetails?: FailureDetails | null;
    healthUrl?: string | null;
    previewId: PreviewId | string;
    proxyUrl?: string | null;
    scope: TenantScope;
    status: PreviewStatus;
  }): Promise<PreviewSession> {
    return await withTransaction(async (client) => {
      const existingRow = await findPreviewWithRunId(
        client,
        input.scope,
        input.previewId
      );

      const healthUrl =
        input.healthUrl === undefined
          ? existingRow.health_url
          : input.healthUrl;
      const proxyUrl =
        input.proxyUrl === undefined ? existingRow.proxy_url : input.proxyUrl;
      const errorDetails =
        input.errorDetails === undefined
          ? existingRow.error_details
          : input.errorDetails;

      const result = await client.query(
        `update previews
            set status = $4,
                health_url = $5,
                proxy_url = $6,
                error_details = $7::jsonb,
                updated_at = now()
          where preview_id = $1
            and organization_id = $2
            and project_id = $3
          returning *`,
        [
          input.previewId,
          input.scope.organizationId,
          input.scope.projectId,
          input.status,
          healthUrl ?? null,
          proxyUrl ?? null,
          errorDetails ? JSON.stringify(errorDetails) : null,
        ]
      );

      const [row] = result.rows;
      if (!row) {
        throw new Error("Preview update returned no row.");
      }

      const preview = toPreviewSession(row);
      const eventType = resolvePreviewEventType(input.status);

      await insertRunEvent(client, {
        payload: {
          buildSessionId: preview.buildSessionId,
          healthUrl: preview.healthUrl,
          port: preview.port,
          previewId: preview.previewId,
          proxyUrl: preview.proxyUrl,
          status: preview.status,
        },
        runId: existingRow.run_id as RunId,
        scope: input.scope,
        type: eventType,
      });

      return preview;
    });
  }

  async function listActivePreviews(
    scope: TenantScope,
    buildSessionId?: BuildSessionId
  ): Promise<PreviewSession[]> {
    const params: unknown[] = [scope.organizationId, scope.projectId];
    let query = `select * from previews
                  where organization_id = $1 and project_id = $2`;
    if (buildSessionId) {
      params.push(buildSessionId);
      query += " and build_session_id = $3";
    }
    query += " order by created_at desc";

    const result = await pool.query(query, params);
    return result.rows.map(toPreviewSession);
  }

  async function recordEvidence(input: {
    artifactId: string;
    buildSessionId?: BuildSessionId | null;
    kind: EvidenceKind;
    metadata?: Record<string, unknown>;
    runId?: RunId | null;
    scope: TenantScope;
    status: EvidenceStatus;
    summary: string;
  }): Promise<EvidenceRecord> {
    return await withTransaction(async (client) => {
      const evidenceId = randomUUID();
      const result = await client.query(
        `insert into evidence
           (evidence_id, organization_id, project_id, build_session_id, run_id,
            artifact_id, kind, summary, status, metadata)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
         returning *`,
        [
          evidenceId,
          input.scope.organizationId,
          input.scope.projectId,
          input.buildSessionId ?? null,
          input.runId ?? null,
          input.artifactId,
          input.kind,
          input.summary,
          input.status,
          JSON.stringify(input.metadata ?? {}),
        ]
      );

      const [row] = result.rows;
      if (!row) {
        throw new Error("Evidence insert returned no row.");
      }

      const evidence = toEvidenceRecord(row);

      if (input.runId) {
        await insertRunEvent(client, {
          payload: {
            artifactId: evidence.artifactId,
            evidenceId: evidence.evidenceId,
            kind: evidence.kind,
            status: evidence.status,
            summary: evidence.summary,
          },
          runId: input.runId,
          scope: input.scope,
          type: "evidence.recorded",
        });
      }

      return evidence;
    });
  }

  async function listEvidence(
    scope: TenantScope,
    filters?: {
      buildSessionId?: BuildSessionId;
      kind?: EvidenceKind;
      runId?: RunId;
    }
  ): Promise<EvidenceRecord[]> {
    const params: unknown[] = [scope.organizationId, scope.projectId];
    let query = `select * from evidence
                  where organization_id = $1 and project_id = $2`;

    if (filters?.buildSessionId) {
      params.push(filters.buildSessionId);
      query += ` and build_session_id = $${params.length}`;
    }
    if (filters?.runId) {
      params.push(filters.runId);
      query += ` and run_id = $${params.length}`;
    }
    if (filters?.kind) {
      params.push(filters.kind);
      query += ` and kind = $${params.length}`;
    }

    query += " order by created_at desc";
    const result = await pool.query(query, params);
    return result.rows.map(toEvidenceRecord);
  }

  async function getEvidence(
    scope: TenantScope,
    evidenceId: EvidenceId | string
  ): Promise<EvidenceRecord | undefined> {
    const result = await pool.query(
      `select * from evidence
        where evidence_id = $1
          and organization_id = $2
          and project_id = $3`,
      [evidenceId, scope.organizationId, scope.projectId]
    );
    const [row] = result.rows;
    return row ? toEvidenceRecord(row) : undefined;
  }

  async function getDeployment(
    scope: TenantScope,
    deploymentId: string
  ): Promise<DeploymentRecord | undefined> {
    const result = await pool.query(
      `select * from deployments
        where deployment_id = $1
          and organization_id = $2
          and project_id = $3`,
      [deploymentId, scope.organizationId, scope.projectId]
    );
    const [row] = result.rows;
    return row ? toDeploymentRecord(row) : undefined;
  }

  async function listDeployments(
    scope: TenantScope
  ): Promise<DeploymentRecord[]> {
    const result = await pool.query(
      `select * from deployments
        where organization_id = $1 and project_id = $2
        order by created_at desc`,
      [scope.organizationId, scope.projectId]
    );
    return result.rows.map(toDeploymentRecord);
  }

  async function rollbackDeployment(input: {
    deploymentId: string;
    reason: string;
    scope: TenantScope;
    targetDeploymentId: string;
  }): Promise<{
    activeDeployment: DeploymentRecord;
    rolledBackDeployment: DeploymentRecord;
  }> {
    return await withTransaction(async (client) => {
      const activeRes = await client.query<{ run_id: string }>(
        `select * from deployments
          where deployment_id = $1
            and organization_id = $2
            and project_id = $3`,
        [input.deploymentId, input.scope.organizationId, input.scope.projectId]
      );
      const [activeRow] = activeRes.rows;
      if (!activeRow) {
        throw new Error("Active deployment does not exist in tenant scope.");
      }

      const targetRes = await client.query(
        `select * from deployments
          where deployment_id = $1
            and organization_id = $2
            and project_id = $3`,
        [
          input.targetDeploymentId,
          input.scope.organizationId,
          input.scope.projectId,
        ]
      );
      const [targetRow] = targetRes.rows;
      if (!targetRow) {
        throw new Error(
          "Target rollback deployment does not exist in tenant scope."
        );
      }

      const updateRes = await client.query(
        `update deployments
            set status = 'rolled_back',
                rollback_deployment_id = $4,
                updated_at = now()
          where deployment_id = $1
            and organization_id = $2
            and project_id = $3
          returning *`,
        [
          input.deploymentId,
          input.scope.organizationId,
          input.scope.projectId,
          input.targetDeploymentId,
        ]
      );

      const [updatedActiveRow] = updateRes.rows;

      const activeDeployment = toDeploymentRecord(updatedActiveRow);
      const rolledBackDeployment = toDeploymentRecord(targetRow);

      await insertRunEvent(client, {
        payload: {
          deploymentId: activeDeployment.deploymentId,
          reason: input.reason,
          targetDeploymentId: rolledBackDeployment.deploymentId,
        },
        runId: activeRow.run_id as RunId,
        scope: input.scope,
        type: "deployment.rolled_back",
      });

      return { activeDeployment, rolledBackDeployment };
    });
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
    claimRunLease,
    close: async () => {
      await pool.end();
    },
    createPreview,
    getBuildSession,
    getCheckpoint,
    getDeployment,
    getEvidence,
    getPreview,
    listActivePreviews,
    listArtifacts,
    listCheckpoints,
    listDeployments,
    listEvidence,
    listPendingOutbox,
    listRunEvents,
    markOutboxPublished,
    memberships,
    migrate: async () => {
      await withTransaction(async (client) => {
        await client.query("select pg_advisory_xact_lock($1)", [
          MIGRATION_LOCK_KEY,
        ]);
        await client.query(PROJECT_STATE_MIGRATION_SQL);
        await client.query(AUTH_SESSION_MIGRATION_SQL);
        await client.query(MEMBERSHIP_MIGRATION_SQL);
      });
    },
    recordArtifact,
    recordCheckpoint,
    recordDeployment,
    recordEvidence,
    releaseRunLease,
    rollbackDeployment,
    sessions,
    setRunStatus,
    updatePreviewStatus,
  };
}
