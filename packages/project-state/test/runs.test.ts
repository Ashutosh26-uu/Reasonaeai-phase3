import { randomUUID } from "node:crypto";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
  type RunId,
  SessionIdSchema,
} from "@reasonateai/contracts/identity";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BuildSessionAllocation,
  createProjectStateStore,
  type TenantScope,
} from "../src/postgres.js";
import { deleteOrganizations } from "./support/database.js";

const connectionString = process.env.DATABASE_URL;

const describeWithDatabase = connectionString ? describe : describe.skip;

/**
 * Expiry is the only thing that frees a run — nothing sweeps a lease — so a
 * test that needs a lapsed one moves the clock's effect rather than sleeping
 * through it and racing the scheduler.
 */
async function lapseLease(pool: Pool, runId: RunId): Promise<void> {
  await pool.query(
    `update run_leases
        set expires_at = now() - interval '1 second'
      where run_id = $1`,
    [runId]
  );
}

async function countLeases(pool: Pool, runId: RunId): Promise<number> {
  const result = await pool.query<{ count: number }>(
    "select count(*)::int as count from run_leases where run_id = $1",
    [runId]
  );

  return result.rows[0]?.count ?? 0;
}

describeWithDatabase("run dispatch", () => {
  const pool = new Pool({ connectionString });
  const store = createProjectStateStore({
    connectionString: connectionString as string,
  });

  const organizationId = OrganizationIdSchema.parse(randomUUID());
  const otherOrganizationId = OrganizationIdSchema.parse(randomUUID());
  const userSessionId = SessionIdSchema.parse(randomUUID());
  const fixtureRuns: RunId[] = [];
  let allocationCount = 0;

  beforeAll(async () => {
    await store.migrate();
    await pool.query(
      `insert into organizations (organization_id, name)
       select fixture_id, 'Run dispatch organization'
         from unnest($1::uuid[]) as fixture_id
       on conflict do nothing`,
      [[organizationId, otherOrganizationId]]
    );
  });

  afterAll(async () => {
    // The `run.queued` rows these fixtures queued are retired the way the relay
    // retires them: an update of this run's own rows, which is also what keeps
    // the suite from growing the unpublished window other tests claim from.
    const pending = await pool.query<{ outbox_id: string }>(
      `select outbox_id
         from outbox
        where run_id = any($1::uuid[])
          and published_at is null`,
      [fixtureRuns]
    );
    await store.markOutboxPublished(
      pending.rows.map(({ outbox_id }) => Number(outbox_id))
    );
    await deleteOrganizations(pool, [organizationId, otherOrganizationId]);
    await pool.end();
    await store.close();
  });

  /**
   * One project per run, because allocation adopts a project's active build
   * session: two allocations in one project would be one run.
   */
  async function queuedRun(): Promise<{
    allocation: BuildSessionAllocation;
    scope: TenantScope;
  }> {
    const projectId = ProjectIdSchema.parse(randomUUID());
    await pool.query(
      `insert into projects (project_id, organization_id, name)
       values ($1, $2, 'Run dispatch project')`,
      [projectId, organizationId]
    );

    const scope: TenantScope = { organizationId, projectId };
    allocationCount += 1;
    const allocation = await store.allocateBuildSession({
      idempotencyKey: `run-dispatch-key-${allocationCount}`,
      scope,
      userSessionId,
    });
    fixtureRuns.push(allocation.buildSession.runId);

    return { allocation, scope };
  }

  it("lists a queued run with the tenant, session, sandbox, and workspace to claim it", async () => {
    const { allocation, scope } = await queuedRun();

    const listed = await store.listRunnableRuns({ limit: 500 });

    expect(listed).toContainEqual({
      buildSessionId: allocation.buildSession.buildSessionId,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      runId: allocation.buildSession.runId,
      sandboxEnvironmentId: allocation.sandbox.sandboxEnvironmentId,
      workspaceUri: allocation.sandbox.workspaceUri,
    });
  });

  it("dispatches the oldest queued run first", async () => {
    const older = await queuedRun();
    const newer = await queuedRun();

    // Two runs allocated in the same instant would tie, and the run id would
    // then decide, so one is backdated to make the claimed order observable.
    await pool.query(
      "update runs set created_at = now() - interval '1 hour' where run_id = $1",
      [older.allocation.buildSession.runId]
    );

    const listed = await store.listRunnableRuns({ limit: 500 });
    const olderIndex = listed.findIndex(
      (run) => run.runId === older.allocation.buildSession.runId
    );
    const newerIndex = listed.findIndex(
      (run) => run.runId === newer.allocation.buildSession.runId
    );

    expect(olderIndex).toBeGreaterThanOrEqual(0);
    expect(newerIndex).toBeGreaterThan(olderIndex);
  });

  it("claims a queued run for exactly one of two concurrent workers", async () => {
    const { allocation, scope } = await queuedRun();
    const { runId } = allocation.buildSession;

    const [first, second] = await Promise.all([
      store.beginRun({ holder: "worker-a", runId, ttlMs: 60_000 }),
      store.beginRun({ holder: "worker-b", runId, ttlMs: 60_000 }),
    ]);

    expect([first, second].filter((grant) => grant !== undefined)).toHaveLength(
      1
    );

    const run = await store.getRun({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      runId,
    });
    expect(run?.status).toBe("running");

    // The winner's lease is exclusive, against other workers and against the
    // winner itself: more time comes from a renewal, never from a second claim.
    expect(
      await store.beginRun({ holder: "worker-c", runId, ttlMs: 60_000 })
    ).toBeUndefined();
    const winnerHolder = first ? "worker-a" : "worker-b";
    expect(
      await store.beginRun({ holder: winnerHolder, runId, ttlMs: 60_000 })
    ).toBeUndefined();
  });

  it("renews only the lease identity that still holds it, and keeps its id", async () => {
    const { allocation } = await queuedRun();
    const { runId } = allocation.buildSession;
    const grant = await store.beginRun({
      holder: "worker-a",
      runId,
      ttlMs: 60_000,
    });

    expect(grant).toBeDefined();
    const leaseId = grant?.leaseId ?? "";

    expect(
      await store.renewRunLease({ holder: "worker-b", leaseId, ttlMs: 60_000 })
    ).toBe(false);
    expect(
      await store.renewRunLease({
        holder: "worker-a",
        leaseId: randomUUID(),
        ttlMs: 60_000,
      })
    ).toBe(false);
    expect(
      await store.renewRunLease({ holder: "worker-a", leaseId, ttlMs: 60_000 })
    ).toBe(true);

    // A renewal is the same lease, so the granted id still ends the run.
    expect(
      await store.finishRun({
        holder: "worker-a",
        leaseId,
        runId,
        status: "succeeded",
      })
    ).toBe(true);
  });

  it("hands a lapsed lease to a second holder instead of extending it", async () => {
    const { allocation } = await queuedRun();
    const { runId } = allocation.buildSession;
    const first = await store.beginRun({
      holder: "worker-a",
      runId,
      ttlMs: 60_000,
    });

    expect(first).toBeDefined();
    const firstLeaseId = first?.leaseId ?? "";

    await lapseLease(pool, runId);

    expect(
      await store.renewRunLease({
        holder: "worker-a",
        leaseId: firstLeaseId,
        ttlMs: 60_000,
      })
    ).toBe(false);

    const second = await store.beginRun({
      holder: "worker-b",
      runId,
      ttlMs: 60_000,
    });
    expect(second).toBeDefined();
    expect(second?.leaseId).not.toBe(firstLeaseId);
  });

  it("refuses to end a run whose lease another holder took over", async () => {
    const { allocation, scope } = await queuedRun();
    const { runId } = allocation.buildSession;
    const abandoned = await store.beginRun({
      holder: "worker-a",
      runId,
      ttlMs: 60_000,
    });

    expect(abandoned).toBeDefined();
    const abandonedLeaseId = abandoned?.leaseId ?? "";

    await lapseLease(pool, runId);
    const takenOver = await store.beginRun({
      holder: "worker-b",
      runId,
      ttlMs: 60_000,
    });
    expect(takenOver).toBeDefined();

    expect(
      await store.finishRun({
        holder: "worker-a",
        leaseId: abandonedLeaseId,
        runId,
        status: "failed",
      })
    ).toBe(false);

    const run = await store.getRun({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      runId,
    });
    expect(run?.status).toBe("running");
    expect(await countLeases(pool, runId)).toBe(1);

    expect(
      await store.finishRun({
        holder: "worker-b",
        leaseId: takenOver?.leaseId ?? "",
        runId,
        status: "succeeded",
      })
    ).toBe(true);
  });

  it("ends a run idempotently and releases its lease", async () => {
    const { allocation, scope } = await queuedRun();
    const { runId } = allocation.buildSession;
    const grant = await store.beginRun({
      holder: "worker-a",
      runId,
      ttlMs: 60_000,
    });
    const leaseId = grant?.leaseId ?? "";
    const readScope = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      runId,
    };

    expect(
      await store.finishRun({
        holder: "worker-a",
        leaseId,
        runId,
        status: "succeeded",
      })
    ).toBe(true);
    expect(await countLeases(pool, runId)).toBe(0);
    expect((await store.getRun(readScope))?.status).toBe("completed");

    // A retry after a crash finds nothing left to release and the status it
    // asked for, so it converges instead of erroring.
    expect(
      await store.finishRun({
        holder: "worker-a",
        leaseId,
        runId,
        status: "succeeded",
      })
    ).toBe(true);

    // The first terminal outcome stands, and a late one is not reported as
    // having applied.
    expect(
      await store.finishRun({
        holder: "worker-a",
        leaseId,
        runId,
        status: "failed",
      })
    ).toBe(false);
    expect((await store.getRun(readScope))?.status).toBe("completed");
  });

  it("offers only runs that no live lease covers", async () => {
    const held = await queuedRun();
    const lapsed = await queuedRun();
    const running = await queuedRun();
    const abandoned = await queuedRun();

    await store.claimRunLease({
      holder: "worker-other",
      runId: held.allocation.buildSession.runId,
      scope: held.scope,
      ttlMs: 60_000,
    });
    await store.claimRunLease({
      holder: "worker-dead",
      runId: lapsed.allocation.buildSession.runId,
      scope: lapsed.scope,
      ttlMs: 60_000,
    });
    await lapseLease(pool, lapsed.allocation.buildSession.runId);
    await store.beginRun({
      holder: "worker-a",
      runId: running.allocation.buildSession.runId,
      ttlMs: 60_000,
    });
    const diedMidRun = await store.beginRun({
      holder: "worker-gone",
      runId: abandoned.allocation.buildSession.runId,
      ttlMs: 60_000,
    });
    expect(diedMidRun).toBeDefined();
    await lapseLease(pool, abandoned.allocation.buildSession.runId);

    const listed = (await store.listRunnableRuns({ limit: 500 })).map(
      (run) => run.runId
    );

    expect(listed).not.toContain(held.allocation.buildSession.runId);
    expect(listed).not.toContain(running.allocation.buildSession.runId);
    // A lapsed lease must not hide work: the claim is what decides the winner.
    expect(listed).toContain(lapsed.allocation.buildSession.runId);
    expect(
      await store.beginRun({
        holder: "worker-b",
        runId: lapsed.allocation.buildSession.runId,
        ttlMs: 60_000,
      })
    ).toBeDefined();
    // A worker that dies mid-run leaves the run running under a lease nobody
    // renews, and the next worker has to be able to find it.
    expect(listed).toContain(abandoned.allocation.buildSession.runId);
    expect(
      await store.beginRun({
        holder: "worker-b",
        runId: abandoned.allocation.buildSession.runId,
        ttlMs: 60_000,
      })
    ).toBeDefined();
  });

  it("refuses to read a run outside the caller's organization or project", async () => {
    const { allocation, scope } = await queuedRun();
    const { runId } = allocation.buildSession;
    const otherProjectId = ProjectIdSchema.parse(randomUUID());
    await pool.query(
      `insert into projects (project_id, organization_id, name)
       values ($1, $2, 'Run dispatch sibling project')`,
      [otherProjectId, organizationId]
    );

    const own = await store.getRun({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      runId,
    });
    expect(own?.runId).toBe(runId);
    expect(own?.buildSessionId).toBe(allocation.buildSession.buildSessionId);
    expect(own?.status).toBe("queued");

    // Another project of the caller's own organization, and another
    // organization, are both outside the scope the run is read in.
    expect(
      await store.getRun({
        organizationId: scope.organizationId,
        projectId: otherProjectId,
        runId,
      })
    ).toBeUndefined();
    expect(
      await store.getRun({
        organizationId: otherOrganizationId,
        projectId: scope.projectId,
        runId,
      })
    ).toBeUndefined();
    expect(
      await store.getRun({
        organizationId: otherOrganizationId,
        projectId: otherProjectId,
        runId,
      })
    ).toBeUndefined();
  });
});
