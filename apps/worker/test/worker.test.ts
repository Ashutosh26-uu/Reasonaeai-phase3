import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readWorkerConfig } from "../src/config.js";
import { createStopSignal } from "../src/stop-signal.js";
import { RunWorker } from "../src/worker.js";
import {
  allocateRunFixture,
  createExecutor,
  createHarness,
  type Harness,
  type RunFixture,
  removeRunArtifacts,
  scriptedRuntime,
  storeScopedTo,
} from "./support/harness.js";

const connectionString = process.env.DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

describeWithDatabase("run worker poll loop", () => {
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

  function config() {
    return readWorkerConfig({
      DATABASE_URL: connectionString as string,
      WORKER_LEASE_TTL_MS: "60000",
      WORKER_POLL_INTERVAL_MS: "250",
      WORKER_POLL_JITTER_MS: "10",
    });
  }

  it("discovers a queued run, claims it, and executes it once", async () => {
    const scripted = scriptedRuntime({ events: [{ type: "agent_start" }] });
    const allocated = await fixture();
    const stopSignal = createStopSignal();
    // Discovery is scoped to this suite's tenant: every other run in the
    // database belongs to another suite.
    const store = storeScopedTo({
      harness,
      organizationId: allocated.organizationId,
    });
    const worker = new RunWorker({
      config: config(),
      executor: createExecutor({
        harness,
        holder: "worker-poll",
        runtime: scripted.runtime,
        store,
      }),
      logger: harness.logger,
      stopSignal,
      store,
    });

    // Started, not driven by hand: this is the loop the process runs.
    worker.start();
    const session = await scripted.waitForSession();
    await session.started;
    session.complete([{ reason: "complete", type: "agent_end" }]);
    await worker.stop();

    expect(worker.stopping).toBe(true);
    expect(scripted.sessions.length).toBe(1);
    const run = await harness.store.getRun({
      organizationId: allocated.organizationId,
      projectId: allocated.projectId,
      runId: allocated.candidate.runId,
    });
    expect(run?.status).toBe("completed");

    // Nothing is runnable once the run has ended, so a second pass claims nothing.
    await worker.poll();
    expect(scripted.sessions.length).toBe(1);
  });

  it("leaves a run under a live lease to the worker that holds it", async () => {
    const scripted = scriptedRuntime();
    const allocated = await fixture();
    const held = await harness.store.beginRun({
      holder: "worker-other",
      runId: allocated.candidate.runId,
      ttlMs: 60_000,
    });
    expect(held).toBeDefined();

    const store = storeScopedTo({
      harness,
      organizationId: allocated.organizationId,
    });
    const worker = new RunWorker({
      config: config(),
      executor: createExecutor({
        harness,
        holder: "worker-poll",
        runtime: scripted.runtime,
        store,
      }),
      logger: harness.logger,
      stopSignal: createStopSignal(),
      store,
    });
    await worker.poll();

    expect(scripted.sessions).toHaveLength(0);
    const run = await harness.store.getRun({
      organizationId: allocated.organizationId,
      projectId: allocated.projectId,
      runId: allocated.candidate.runId,
    });
    expect(run?.status).toBe("running");

    await harness.store.finishRun({
      holder: "worker-other",
      leaseId: held?.leaseId ?? "",
      runId: allocated.candidate.runId,
      status: "failed",
    });
  });
});
