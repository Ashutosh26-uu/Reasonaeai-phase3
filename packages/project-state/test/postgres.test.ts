import { randomUUID } from "node:crypto";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
  SessionIdSchema,
} from "@reasonateai/contracts/identity";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConversationBusyError,
  ConversationRetryUnavailableError,
  createProjectStateStore,
} from "../src/postgres.js";
import { deleteOrganizations } from "./support/database.js";

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
    await deleteOrganizations(pool, [organizationId, otherOrganizationId]);
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

  it("replays one key and creates separate project conversations for new keys", async () => {
    const first = await store.allocateBuildSession({
      idempotencyKey: "replay-key-0001",
      message: "Build a task tracker",
      scope,
      userSessionId,
    });
    const replay = await store.allocateBuildSession({
      idempotencyKey: "replay-key-0001",
      scope,
      userSessionId,
    });
    const second = await store.allocateBuildSession({
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

    expect(second.created).toBe(true);
    expect(second.buildSession.buildSessionId).not.toBe(
      first.buildSession.buildSessionId
    );
    const conversations = await store.listConversations(scope);
    expect(conversations.map((item) => item.buildSessionId)).toContain(
      first.buildSession.buildSessionId
    );
    expect(conversations.map((item) => item.buildSessionId)).toContain(
      second.buildSession.buildSessionId
    );
    expect(
      (
        await store.listConversationMessages({
          buildSessionId: first.buildSession.buildSessionId,
          scope,
        })
      )[0]?.text
    ).toBe("Build a task tracker");
    expect(
      (await store.listRunnableRuns({ limit: 100 })).find(
        (item) => item.runId === first.buildSession.runId
      )?.userMessage
    ).toBe("Build a task tracker");
  });

  it("stores follow-up turns idempotently and rejects overlapping runs", async () => {
    const allocated = await store.allocateBuildSession({
      idempotencyKey: "turn-key-0001",
      message: "Start the app",
      scope,
      userSessionId,
    });
    const { buildSessionId } = allocated.buildSession;
    await expect(
      store.appendConversationTurn({
        buildSessionId,
        idempotencyKey: "turn-key-0002",
        message: "Add search",
        scope,
      })
    ).rejects.toThrow("already has a run");
    await store.setRunStatus({
      runId: allocated.buildSession.runId,
      scope,
      status: "completed",
    });
    const first = await store.appendConversationTurn({
      buildSessionId,
      idempotencyKey: "turn-key-0002",
      message: "Add search",
      scope,
    });
    const replay = await store.appendConversationTurn({
      buildSessionId,
      idempotencyKey: "turn-key-0002",
      message: "Add search",
      scope,
    });
    expect(first.created).toBe(true);
    expect(replay).toEqual({ created: false, runId: first.runId });
    expect(
      (await store.listConversationMessages({ buildSessionId, scope })).map(
        (item) => item.text
      )
    ).toEqual(["Start the app", "Add search"]);
  });

  it("admits only one new retry under concurrent requests and rejects retry source substitution", async () => {
    const allocation = await store.allocateBuildSession({
      idempotencyKey: `retry-source-${randomUUID()}`,
      message: "Retry this generation",
      scope,
      userSessionId,
    });
    const { buildSessionId, runId } = allocation.buildSession;
    await store.setRunStatus({ runId, scope, status: "failed" });
    const request = { buildSessionId, runId, scope };
    const results = await Promise.allSettled([
      store.retryConversationRun({
        ...request,
        idempotencyKey: "retry-race-a",
      }),
      store.retryConversationRun({
        ...request,
        idempotencyKey: "retry-race-b",
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
      ConversationBusyError
    );
    const history = await store.listConversationMessages({
      buildSessionId,
      scope,
    });
    expect(history).toHaveLength(2);
    const retried = history.find((message) => message.runId !== runId);
    if (!retried?.runId) {
      throw new Error("The accepted retry was not recorded.");
    }
    await store.setRunStatus({
      runId: retried.runId,
      scope,
      status: "completed",
    });
    await expect(
      store.retryConversationRun({
        ...request,
        idempotencyKey: "retry-successful",
        runId: retried.runId,
      })
    ).rejects.toBeInstanceOf(ConversationRetryUnavailableError);
    const other = await store.allocateBuildSession({
      idempotencyKey: `retry-other-${randomUUID()}`,
      message: "Other conversation",
      scope,
      userSessionId,
    });
    await store.setRunStatus({
      runId: other.buildSession.runId,
      scope,
      status: "failed",
    });
    await expect(
      store.retryConversationRun({
        ...request,
        idempotencyKey: "retry-other-conversation",
        runId: other.buildSession.runId,
      })
    ).rejects.toBeInstanceOf(ConversationRetryUnavailableError);
    await expect(
      store.retryConversationRun({
        ...request,
        idempotencyKey: "retry-foreign-tenant",
        scope: foreignScope,
      })
    ).rejects.toThrow("Conversation not found");
    expect(
      await store.listConversationMessages({ buildSessionId, scope })
    ).toHaveLength(2);
  });

  it("keeps retry idempotency separate from normal turns and other retry sources", async () => {
    const allocation = await store.allocateBuildSession({
      idempotencyKey: `retry-key-scope-${randomUUID()}`,
      message: "Original generation",
      scope,
      userSessionId,
    });
    const { buildSessionId, runId } = allocation.buildSession;
    await store.setRunStatus({ runId, scope, status: "failed" });
    const idempotencyKey = "same-key-for-different-commands";
    const normal = await store.appendConversationTurn({
      buildSessionId,
      idempotencyKey,
      message: "A different request",
      scope,
    });
    await store.setRunStatus({ runId: normal.runId, scope, status: "failed" });
    const request = { buildSessionId, idempotencyKey, runId, scope };
    expect(await store.getConversationRetry(request)).toBeUndefined();
    const retried = await store.retryConversationRun(request);
    expect(retried.created).toBe(true);
    expect(retried.runId).not.toBe(normal.runId);
    expect(await store.getConversationRetry(request)).toBe(retried.runId);
    expect(
      await store.getConversationRetry({ ...request, runId: normal.runId })
    ).toBeUndefined();
    expect(
      await store.getConversationRetry({ ...request, scope: foreignScope })
    ).toBeUndefined();
    await store.setRunStatus({
      runId: retried.runId,
      scope,
      status: "completed",
    });
    const differentSource = await store.retryConversationRun({
      ...request,
      runId: normal.runId,
    });
    expect(differentSource.created).toBe(true);
    expect(differentSource.runId).not.toBe(retried.runId);
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

    // Every suite shares one database and the listing is a bounded window, so
    // assert on the two events this test appended: a run's queue row is written
    // with its ledger row, which is what makes delivery exactly once per event.
    const pending = await store.listPendingOutbox(500);
    const queuedEventIds = new Set([first.eventId, second.eventId]);
    const queued = pending.filter(
      ({ payload }) =>
        payload.runId === runId && queuedEventIds.has(payload.eventId)
    );
    expect(queued).toHaveLength(2);
    expect(queued.every(({ payload }) => payload.sequence > 0)).toBe(true);
    expect(
      queued.every(({ topic }) => topic === `reasonateai.run.events.${runId}`)
    ).toBe(true);

    await store.markOutboxPublished(
      queued.map(({ outboxId }) => Number(outboxId))
    );
    const remaining = await store.listPendingOutbox(500);
    expect(
      remaining.some(({ payload }) => queuedEventIds.has(payload.eventId))
    ).toBe(false);
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
});
