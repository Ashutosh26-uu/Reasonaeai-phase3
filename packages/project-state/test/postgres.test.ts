import { randomUUID } from "node:crypto";
import { ArtifactIdSchema } from "@reasonateai/contracts/execution-protocol";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
  SessionIdSchema,
} from "@reasonateai/contracts/identity";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProjectStateStore } from "../src/postgres.js";

const connectionString = process.env.DATABASE_URL;
const TENANT_SCOPE_ERROR = /tenant scope|does not exist/i;

const describeWithDatabase = connectionString ? describe : describe.skip;

describeWithDatabase("project state store", () => {
  const pool = new Pool({ connectionString });
  const store = createProjectStateStore({
    connectionString: connectionString as string,
  });

  const organizationId = OrganizationIdSchema.parse(randomUUID());
  const projectId = ProjectIdSchema.parse(randomUUID());
  const otherOrganizationId = OrganizationIdSchema.parse(randomUUID());
  const otherProjectId = ProjectIdSchema.parse(randomUUID());
  const userSessionId = SessionIdSchema.parse(randomUUID());
  const scope = { organizationId, projectId };
  const foreignScope = {
    organizationId: otherOrganizationId,
    projectId: otherProjectId,
  };

  beforeAll(async () => {
    await store.migrate();
    await pool.query(
      `insert into organizations (organization_id, name)
       select fixture_id, 'Test organization'
         from unnest($1::uuid[]) as fixture_id
       on conflict do nothing`,
      [[organizationId, otherOrganizationId]]
    );
    await pool.query(
      `insert into projects (project_id, organization_id, name)
       select fixture.project_id, fixture.organization_id, 'Test project'
         from unnest($1::uuid[], $2::uuid[])
              as fixture(project_id, organization_id)
       on conflict do nothing`,
      [
        [projectId, otherProjectId],
        [organizationId, otherOrganizationId],
      ]
    );
  });

  afterAll(async () => {
    await pool.query(
      "delete from organizations where organization_id = any($1::uuid[])",
      [[organizationId, otherOrganizationId]]
    );
    await pool.end();
    await store.close();
  });

  it("serializes concurrent migrations instead of colliding in the system catalog", async () => {
    const replica = createProjectStateStore({
      connectionString: connectionString as string,
    });

    try {
      await expect(
        Promise.all([
          store.migrate(),
          replica.migrate(),
          store.migrate(),
          replica.migrate(),
        ])
      ).resolves.toBeDefined();
    } finally {
      await replica.close();
    }
  });

  it("allocates once per idempotency key and reuses the active session on reconnect", async () => {
    const first = await store.allocateBuildSession({
      idempotencyKey: "replay-key-0001",
      scope,
      userSessionId,
    });
    const replay = await store.allocateBuildSession({
      idempotencyKey: "replay-key-0001",
      scope,
      userSessionId,
    });
    const reconnect = await store.allocateBuildSession({
      idempotencyKey: "replay-key-0002",
      scope,
      userSessionId,
    });

    expect(first.created).toBe(true);
    expect(first.buildSession.status).toBe("provisioning");
    expect(first.sandbox.workspaceUri).toBe(
      `sandbox://${first.sandbox.sandboxEnvironmentId}/workspace`
    );

    expect(replay.created).toBe(false);
    expect(replay.buildSession.buildSessionId).toBe(
      first.buildSession.buildSessionId
    );

    expect(reconnect.created).toBe(false);
    expect(reconnect.buildSession.buildSessionId).toBe(
      first.buildSession.buildSessionId
    );
    expect(reconnect.buildSession.runId).toBe(first.buildSession.runId);
  });

  it("refuses to resolve another tenant's build session", async () => {
    const allocation = await store.allocateBuildSession({
      idempotencyKey: "isolation-key-0001",
      scope,
      userSessionId,
    });

    expect(
      await store.getBuildSession(
        foreignScope,
        allocation.buildSession.buildSessionId
      )
    ).toBeUndefined();
    await expect(
      store.appendRunEvent({
        payload: {},
        runId: allocation.buildSession.runId,
        scope: foreignScope,
        type: "agent.progress",
      })
    ).rejects.toThrow(TENANT_SCOPE_ERROR);
  });

  it("orders the event ledger monotonically and queues each event for transport", async () => {
    const allocation = await store.allocateBuildSession({
      idempotencyKey: "sequence-key-0001",
      scope,
      userSessionId,
    });
    const { runId } = allocation.buildSession;

    const first = await store.appendRunEvent({
      payload: { step: "specification" },
      runId,
      scope,
      type: "agent.started",
    });
    const second = await store.appendRunEvent({
      payload: { step: "implementation" },
      runId,
      scope,
      type: "agent.progress",
    });

    expect(second.sequence).toBe(first.sequence + 1);

    const replayed = await store.listRunEvents({
      afterSequence: 0,
      limit: 100,
      runId,
      scope,
    });
    // The ledger is contiguous from 1; cursor 0 means "from the start".
    expect(replayed.map((event) => event.sequence)).toEqual(
      replayed.map((_, index) => index + 1)
    );
    expect(replayed.at(-1)?.sequence).toBe(second.sequence);

    const afterFirst = await store.listRunEvents({
      afterSequence: first.sequence,
      limit: 100,
      runId,
      scope,
    });
    expect(afterFirst.map((event) => event.type)).toEqual(["agent.progress"]);

    const pending = await store.listPendingOutbox(200);
    const queued = pending.filter(({ payload }) => payload.runId === runId);
    expect(queued.length).toBe(replayed.length);
    expect(queued.every(({ payload }) => payload.sequence > 0)).toBe(true);
    expect(
      queued.every(({ topic }) => topic === `reasonateai.run.events.${runId}`)
    ).toBe(true);

    await store.markOutboxPublished(
      queued.map(({ outboxId }) => Number(outboxId))
    );
    const remaining = await store.listPendingOutbox(200);
    expect(remaining.some(({ payload }) => payload.runId === runId)).toBe(
      false
    );
  });

  it("grants a run lease to exactly one holder and releases it explicitly", async () => {
    const allocation = await store.allocateBuildSession({
      idempotencyKey: "lease-key-0001",
      scope,
      userSessionId,
    });
    const { runId } = allocation.buildSession;

    const first = await store.claimRunLease({
      holder: "worker-a",
      runId,
      scope,
      ttlMs: 60_000,
    });
    const contended = await store.claimRunLease({
      holder: "worker-b",
      runId,
      scope,
      ttlMs: 60_000,
    });

    expect(first?.holder).toBe("worker-a");
    expect(contended).toBeUndefined();

    expect(
      await store.releaseRunLease({
        leaseId: first?.leaseId as string,
        runId,
        scope,
      })
    ).toBe(true);

    const reacquired = await store.claimRunLease({
      holder: "worker-b",
      runId,
      scope,
      ttlMs: 60_000,
    });
    expect(reacquired?.holder).toBe("worker-b");

    await store.setRunStatus({ runId, scope, status: "running" });
  });

  it("persists git checkpoints and respects tenant scoping", async () => {
    const allocation = await store.allocateBuildSession({
      idempotencyKey: "checkpoint-key-0001",
      scope,
      userSessionId,
    });

    const checkpoint = await store.recordCheckpoint({
      author: "CTO Agent",
      buildSessionId: allocation.buildSession.buildSessionId,
      commitHash: "1".repeat(40),
      message: "feat: initial commit",
      parentHash: null,
      runId: allocation.buildSession.runId,
      scope,
    });

    expect(checkpoint.commitHash).toBe("1".repeat(40));
    expect(checkpoint.author).toBe("CTO Agent");

    const fetched = await store.getCheckpoint(scope, checkpoint.checkpointId);
    expect(fetched?.checkpointId).toBe(checkpoint.checkpointId);

    const list = await store.listCheckpoints(
      scope,
      allocation.buildSession.buildSessionId
    );
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0]?.checkpointId).toBe(checkpoint.checkpointId);

    // Cross-tenant scope isolation test
    const foreignFetched = await store.getCheckpoint(
      foreignScope,
      checkpoint.checkpointId
    );
    expect(foreignFetched).toBeUndefined();

    const foreignList = await store.listCheckpoints(foreignScope);
    expect(
      foreignList.find((c) => c.checkpointId === checkpoint.checkpointId)
    ).toBeUndefined();
  });

  it("manages preview session lifecycle and emits preview events", async () => {
    const allocation = await store.allocateBuildSession({
      idempotencyKey: "preview-key-0001",
      scope,
      userSessionId,
    });

    const preview = await store.createPreview({
      buildSessionId: allocation.buildSession.buildSessionId,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      healthUrl: "http://localhost:3000/health",
      port: 3000,
      sandboxEnvironmentId: allocation.sandbox.sandboxEnvironmentId,
      sandboxId: "sandbox-preview-test-1",
      scope,
      status: "allocating",
    });

    expect(preview.status).toBe("allocating");
    expect(preview.port).toBe(3000);

    const updated = await store.updatePreviewStatus({
      healthUrl: "http://localhost:3000/health",
      previewId: preview.previewId,
      proxyUrl: "https://preview.reasonate.example",
      scope,
      status: "ready",
    });

    expect(updated.status).toBe("ready");
    expect(updated.proxyUrl).toBe("https://preview.reasonate.example");

    const fetched = await store.getPreview(scope, preview.previewId);
    expect(fetched?.status).toBe("ready");

    const activeList = await store.listActivePreviews(
      scope,
      allocation.buildSession.buildSessionId
    );
    expect(activeList.some((p) => p.previewId === preview.previewId)).toBe(
      true
    );

    // Cross-tenant scope isolation test
    expect(
      await store.getPreview(foreignScope, preview.previewId)
    ).toBeUndefined();

    // Updating non-existent or foreign preview throws error
    await expect(
      store.updatePreviewStatus({
        previewId: preview.previewId,
        scope: foreignScope,
        status: "stopped",
      })
    ).rejects.toThrow(TENANT_SCOPE_ERROR);
  });

  it("records runtime evidence linked to artifacts and verifies scope", async () => {
    const allocation = await store.allocateBuildSession({
      idempotencyKey: "evidence-key-0001",
      scope,
      userSessionId,
    });

    const artifactId = ArtifactIdSchema.parse(randomUUID());
    const artifact = await store.recordArtifact(
      {
        artifactId,
        buildSessionId: allocation.buildSession.buildSessionId,
        files: [
          {
            mediaType: "image/png",
            objectKey: "artifacts/screenshot.png",
            path: "screenshot.png",
            sha256: "e".repeat(64),
            size: 1024,
          },
        ],
        kind: "screenshot",
        occurredAt: new Date().toISOString(),
        organizationId,
        projectId,
        runId: allocation.buildSession.runId,
        schemaVersion: 1,
        totalSize: 1024,
      },
      "completed"
    );

    const evidence = await store.recordEvidence({
      artifactId: artifact.artifactId,
      buildSessionId: allocation.buildSession.buildSessionId,
      kind: "screenshot",
      metadata: { viewport: "1920x1080" },
      runId: allocation.buildSession.runId,
      scope,
      status: "passed",
      summary: "Full page visual verification",
    });

    expect(evidence.kind).toBe("screenshot");
    expect(evidence.summary).toBe("Full page visual verification");

    const fetched = await store.getEvidence(scope, evidence.evidenceId);
    expect(fetched?.evidenceId).toBe(evidence.evidenceId);

    const list = await store.listEvidence(scope, { kind: "screenshot" });
    expect(list.some((e) => e.evidenceId === evidence.evidenceId)).toBe(true);

    // Cross-tenant scope isolation
    expect(
      await store.getEvidence(foreignScope, evidence.evidenceId)
    ).toBeUndefined();
  });

  it("handles deployment creation and rollback with scope isolation", async () => {
    const allocation = await store.allocateBuildSession({
      idempotencyKey: "deployment-key-0001",
      scope,
      userSessionId,
    });

    const firstDeploymentId = randomUUID();
    const secondDeploymentId = randomUUID();

    const firstDeployment = await store.recordDeployment({
      deploymentId: firstDeploymentId,
      exposure: "public",
      providerReference: "cloud-run-v1",
      runId: allocation.buildSession.runId,
      scope,
      sourceCheckpoint: "c".repeat(40),
      status: "ready",
      url: "https://v1.example.com",
    });

    const secondDeployment = await store.recordDeployment({
      deploymentId: secondDeploymentId,
      exposure: "public",
      providerReference: "cloud-run-v2",
      runId: allocation.buildSession.runId,
      scope,
      sourceCheckpoint: "d".repeat(40),
      status: "ready",
      url: "https://v2.example.com",
    });

    expect(firstDeployment.status).toBe("ready");
    expect(secondDeployment.status).toBe("ready");

    const rollbackResult = await store.rollbackDeployment({
      deploymentId: secondDeployment.deploymentId,
      reason: "Regression in v2 release",
      scope,
      targetDeploymentId: firstDeployment.deploymentId,
    });

    expect(rollbackResult.activeDeployment.status).toBe("rolled_back");
    expect(rollbackResult.activeDeployment.rollbackDeploymentId).toBe(
      firstDeployment.deploymentId
    );
    expect(rollbackResult.rolledBackDeployment.deploymentId).toBe(
      firstDeployment.deploymentId
    );

    const fetchedActive = await store.getDeployment(
      scope,
      secondDeployment.deploymentId
    );
    expect(fetchedActive?.status).toBe("rolled_back");
    expect(fetchedActive?.rollbackDeploymentId).toBe(
      firstDeployment.deploymentId
    );

    // Attempting rollback with foreign scope fails
    await expect(
      store.rollbackDeployment({
        deploymentId: secondDeployment.deploymentId,
        reason: "Invalid tenant attempt",
        scope: foreignScope,
        targetDeploymentId: firstDeployment.deploymentId,
      })
    ).rejects.toThrow(TENANT_SCOPE_ERROR);
  });
});
