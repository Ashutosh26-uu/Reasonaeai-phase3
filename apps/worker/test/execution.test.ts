import type { RunEventEnvelope } from "@reasonateai/contracts/execution-protocol";
import type { RunId } from "@reasonateai/contracts/identity";
import type { ProjectStateStore } from "@reasonateai/project-state/postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createStopSignal } from "../src/stop-signal.js";
import {
  allocateRunFixture,
  containerCount,
  createExecutor,
  createHarness,
  type Harness,
  type RunFixture,
  removeRunArtifacts,
  scriptedRuntime,
  volumeCount,
} from "./support/harness.js";

const connectionString = process.env.DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

/**
 * The worker's whole promise in one query: a run is `running` only while a live
 * lease covers it. Any row here is a run nobody owns and nobody would retry.
 */
async function runningWithoutLease(
  harness: Harness,
  runId: RunId
): Promise<boolean> {
  const result = await harness.pool.query(
    `select r.run_id
       from runs r
       left join run_leases l on l.run_id = r.run_id
      where r.run_id = $1
        and r.status = 'running'
        and (l.run_id is null or l.expires_at <= now())`,
    [runId]
  );
  return result.rowCount === 1;
}

async function leaseRow(
  harness: Harness,
  runId: RunId
): Promise<{ holder: string; leaseId: string } | undefined> {
  const result = await harness.pool.query<{
    holder: string;
    lease_id: string;
  }>("select holder, lease_id from run_leases where run_id = $1", [runId]);
  const [row] = result.rows;
  return row === undefined
    ? undefined
    : { holder: row.holder, leaseId: row.lease_id };
}

async function runStatus(harness: Harness, fixture: RunFixture) {
  const run = await harness.store.getRun({
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    runId: fixture.candidate.runId,
  });
  return run?.status;
}

async function ledger(
  harness: Harness,
  fixture: RunFixture
): Promise<RunEventEnvelope[]> {
  return await harness.store.listRunEvents({
    afterSequence: 0,
    limit: 200,
    runId: fixture.candidate.runId,
    scope: fixture.scope,
  });
}

describeWithDatabase("run execution", () => {
  let harness: Harness;
  const volumes: string[] = [];

  beforeAll(async () => {
    harness = await createHarness({
      connectionString: connectionString as string,
    });
  });

  afterEach(async () => {
    await harness.cleanup();
    await Promise.all(volumes.splice(0).map(removeRunArtifacts));
  });

  afterAll(async () => {
    await harness.dispose();
  });

  async function fixture(): Promise<RunFixture> {
    const allocated = await allocateRunFixture(harness);
    volumes.push(allocated.volume);
    return allocated;
  }

  it("drives a claimed run, appends the ledger, and leaves no container or volume", async () => {
    const scripted = scriptedRuntime({
      events: [
        { type: "agent_start" },
        {
          args: { command: "npm test" },
          toolCallId: "call-1",
          toolName: "execute_command",
          type: "tool_start",
        },
      ],
    });
    const executor = createExecutor({
      harness,
      holder: "worker-happy",
      runtime: scripted.runtime,
    });
    const allocated = await fixture();

    const attempt = executor.execute(allocated.candidate, createStopSignal());
    const session = await scripted.waitForSession();
    await session.started;

    // The sandbox the agent works in is the real one, and it is up.
    expect(await containerCount(allocated.volume)).toBe(1);
    expect(await volumeCount(allocated.volume)).toBe(1);

    session.complete([{ reason: "complete", type: "agent_end" }]);
    expect(await attempt).toBe("succeeded");

    expect(await runStatus(harness, allocated)).toBe("completed");
    expect(await leaseRow(harness, allocated.candidate.runId)).toBeUndefined();
    expect(await runningWithoutLease(harness, allocated.candidate.runId)).toBe(
      false
    );

    const events = await ledger(harness, allocated);
    expect(events.map((event) => event.sequence)).toEqual(
      events.map((_, index) => index + 1)
    );
    expect(events[0]?.type).toBe("run.queued");
    expect(events.some((event) => event.type === "run.claimed")).toBe(true);
    expect(events.some((event) => event.type === "agent.started")).toBe(true);
    for (const event of events) {
      expect(event.runId).toBe(allocated.candidate.runId);
      expect(event.organizationId).toBe(allocated.organizationId);
      expect(event.projectId).toBe(allocated.projectId);
    }

    const terminal = events.at(-1);
    expect(terminal?.type).toBe("run.completed");
    const checkpointId = terminal?.payload.checkpointId;
    expect(typeof checkpointId).toBe("string");

    // What the run recorded is what the next run restores from.
    const latest = await harness.checkpoints.latest({
      organizationId: allocated.organizationId,
      projectId: allocated.projectId,
    });
    expect(latest?.checkpointId).toBe(checkpointId);

    expect(await containerCount(allocated.volume)).toBe(0);
    expect(await volumeCount(allocated.volume)).toBe(0);
  });

  it("executes a contested run once when two workers race it", async () => {
    const first = scriptedRuntime({ events: [{ type: "agent_start" }] });
    const second = scriptedRuntime({ events: [{ type: "agent_start" }] });
    const allocated = await fixture();
    const stopSignal = createStopSignal();

    const contested = Promise.all([
      createExecutor({
        harness,
        holder: "worker-race-a",
        runtime: first.runtime,
      }).execute(allocated.candidate, stopSignal),
      createExecutor({
        harness,
        holder: "worker-race-b",
        runtime: second.runtime,
      }).execute(allocated.candidate, stopSignal),
    ]);

    const session = await Promise.race([
      first.waitForSession(),
      second.waitForSession(),
    ]);
    await session.started;
    session.complete([{ reason: "complete", type: "agent_end" }]);
    const outcomes = await contested;

    // Exactly one worker did any work at all: the other had no side effect.
    expect(outcomes.filter((outcome) => outcome === "succeeded")).toHaveLength(
      1
    );
    expect(outcomes.filter((outcome) => outcome === "skipped")).toHaveLength(1);
    expect(first.initCalls() + second.initCalls()).toBe(1);
    expect(first.sessions.length + second.sessions.length).toBe(1);

    const claims = (await ledger(harness, allocated)).filter(
      (event) => event.type === "run.claimed"
    );
    expect(claims).toHaveLength(1);

    expect(await runStatus(harness, allocated)).toBe("completed");
    expect(await containerCount(allocated.volume)).toBe(0);
    expect(await volumeCount(allocated.volume)).toBe(0);
  });

  it("stops a run whose lease cannot be renewed and never leaves it running", async () => {
    const scripted = scriptedRuntime();
    const allocated = await fixture();
    // One operation refuses, which is what a lapsed or stolen lease looks like
    // to the worker: the store no longer honours the renewal.
    const refusing: ProjectStateStore = {
      ...harness.store,
      renewRunLease: async () => false,
    };
    const executor = createExecutor({
      harness,
      holder: "worker-lease",
      leaseTtlMs: 60_000,
      renewIntervalMs: 150,
      runtime: scripted.runtime,
      store: refusing,
    });

    const attempt = executor.execute(allocated.candidate, createStopSignal());
    const session = await scripted.waitForSession();
    await session.started;

    expect(await attempt).toBe("failed");
    expect(session.aborted).toBe(true);

    expect(await runStatus(harness, allocated)).toBe("failed");
    expect(await leaseRow(harness, allocated.candidate.runId)).toBeUndefined();
    expect(await runningWithoutLease(harness, allocated.candidate.runId)).toBe(
      false
    );

    const events = await ledger(harness, allocated);
    const terminal = events.at(-1);
    expect(terminal?.type).toBe("run.failed");
    expect(String(terminal?.payload.reason)).toContain("lease");

    expect(await containerCount(allocated.volume)).toBe(0);
    // The workspace was never snapshotted, so the volume still holds its work.
    expect(await volumeCount(allocated.volume)).toBe(1);
  });

  it("hands a taken-over run off instead of claiming its outcome", async () => {
    const scripted = scriptedRuntime();
    const allocated = await fixture();
    const executor = createExecutor({
      harness,
      holder: "worker-replaced",
      leaseTtlMs: 60_000,
      renewIntervalMs: 400,
      runtime: scripted.runtime,
    });

    const attempt = executor.execute(allocated.candidate, createStopSignal());
    const session = await scripted.waitForSession();
    await session.started;

    // Another worker has taken the run: the lease row is a different holder.
    await harness.pool.query(
      `update run_leases
          set holder = 'worker-takeover',
              lease_id = gen_random_uuid(),
              expires_at = now() + interval '60 seconds'
        where run_id = $1`,
      [allocated.candidate.runId]
    );

    expect(await attempt).toBe("failed");
    expect(session.aborted).toBe(true);

    // The run belongs to the holder that replaced this worker, so it is still
    // running, still leased, and the ledger carries no outcome this worker
    // could not have known.
    expect(await runStatus(harness, allocated)).toBe("running");
    const takenOver = await leaseRow(harness, allocated.candidate.runId);
    expect(takenOver?.holder).toBe("worker-takeover");
    expect(await runningWithoutLease(harness, allocated.candidate.runId)).toBe(
      false
    );

    const events = await ledger(harness, allocated);
    expect(
      events.filter((event) =>
        ["run.cancelled", "run.completed", "run.failed"].includes(event.type)
      )
    ).toHaveLength(0);
    expect(await containerCount(allocated.volume)).toBe(0);
    expect(await volumeCount(allocated.volume)).toBe(1);

    // The holder that took it over can end it, which is what proves the run was
    // recoverable rather than orphaned.
    const ended = await harness.store.finishRun({
      holder: "worker-takeover",
      leaseId: takenOver?.leaseId ?? "",
      runId: allocated.candidate.runId,
      status: "failed",
    });
    expect(ended).toBe(true);
    expect(await runStatus(harness, allocated)).toBe("failed");
    expect(await leaseRow(harness, allocated.candidate.runId)).toBeUndefined();
  });

  it("records a failed run's reason and finishes it as failed", async () => {
    const scripted = scriptedRuntime({ events: [{ type: "agent_start" }] });
    const executor = createExecutor({
      harness,
      holder: "worker-failure",
      runtime: scripted.runtime,
    });
    const allocated = await fixture();

    const attempt = executor.execute(allocated.candidate, createStopSignal());
    const session = await scripted.waitForSession();
    await session.started;
    session.crash("the provider refused the run");

    expect(await attempt).toBe("failed");
    expect(await runStatus(harness, allocated)).toBe("failed");
    expect(await leaseRow(harness, allocated.candidate.runId)).toBeUndefined();
    expect(await runningWithoutLease(harness, allocated.candidate.runId)).toBe(
      false
    );

    const terminal = (await ledger(harness, allocated)).at(-1);
    expect(terminal?.type).toBe("run.failed");
    expect(String(terminal?.payload.reason)).toContain(
      "the provider refused the run"
    );

    expect(await containerCount(allocated.volume)).toBe(0);
    expect(await volumeCount(allocated.volume)).toBe(0);
  });

  it("fails a run whose agent reported an error even though its send resolved", async () => {
    const scripted = scriptedRuntime({ events: [{ type: "agent_start" }] });
    const executor = createExecutor({
      harness,
      holder: "worker-agent-error",
      runtime: scripted.runtime,
    });
    const allocated = await fixture();

    const attempt = executor.execute(allocated.candidate, createStopSignal());
    const session = await scripted.waitForSession();
    await session.started;

    // A provider refusing the call is reported as an error event and then as an
    // aborted agent turn; the session still resolves, which is exactly the case a
    // worker cannot treat as success.
    session.complete([
      { error: new Error("the model is unavailable"), type: "error" },
      { reason: "error", type: "agent_end" },
    ]);

    expect(await attempt).toBe("failed");
    expect(await runStatus(harness, allocated)).toBe("failed");
    expect(await leaseRow(harness, allocated.candidate.runId)).toBeUndefined();
    expect(await runningWithoutLease(harness, allocated.candidate.runId)).toBe(
      false
    );

    const events = await ledger(harness, allocated);
    expect(events.some((event) => event.type === "run.completed")).toBe(false);
    const terminal = events.at(-1);
    expect(terminal?.type).toBe("run.failed");
    expect(String(terminal?.payload.reason)).toContain(
      "the model is unavailable"
    );
  });

  it("cancels the run in flight on shutdown and leaves no running run without a lease", async () => {
    const scripted = scriptedRuntime();
    const executor = createExecutor({
      harness,
      holder: "worker-shutdown",
      runtime: scripted.runtime,
    });
    const allocated = await fixture();
    const stopSignal = createStopSignal();

    const attempt = executor.execute(allocated.candidate, stopSignal);
    const session = await scripted.waitForSession();
    await session.started;
    expect(await containerCount(allocated.volume)).toBe(1);

    stopSignal.request("the worker received SIGTERM");
    expect(await attempt).toBe("cancelled");

    expect(session.aborted).toBe(true);
    expect(await runStatus(harness, allocated)).toBe("cancelled");
    expect(await leaseRow(harness, allocated.candidate.runId)).toBeUndefined();
    expect(await runningWithoutLease(harness, allocated.candidate.runId)).toBe(
      false
    );

    const terminal = (await ledger(harness, allocated)).at(-1);
    expect(terminal?.type).toBe("run.cancelled");
    expect(String(terminal?.payload.reason)).toContain("SIGTERM");

    expect(await containerCount(allocated.volume)).toBe(0);
    expect(await volumeCount(allocated.volume)).toBe(0);
  });
});
