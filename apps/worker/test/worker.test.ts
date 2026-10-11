import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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

  it("starts an independent project while a question is unanswered and respects capacity", async () => {
    const first = await fixture();
    const second = await fixture();
    const third = await fixture();
    const fixtures = [first, second, third];
    const fixtureRunIds = new Set(fixtures.map((item) => item.candidate.runId));
    const store = {
      ...harness.store,
      listRunnableRuns: async ({ limit }: { limit: number }) =>
        (await harness.store.listRunnableRuns({ limit: 64 }))
          .filter((run) => fixtureRunIds.has(run.runId))
          .slice(0, limit),
    };
    const scripted = scriptedRuntime();
    const stopSignal = createStopSignal();
    const worker = new RunWorker({
      config: config(),
      executor: createExecutor({
        harness,
        holder: "worker-fairness",
        runtime: scripted.runtime,
        store,
      }),
      logger: harness.logger,
      stopSignal,
      store,
    });
    try {
      await worker.poll();
      const firstSession = await scripted.waitForSession();
      await firstSession.started;
      firstSession.complete([
        {
          args: { question: "Which region?" },
          resumeSchema: "string",
          suspendPayload: { question: "Which region?" },
          toolCallId: "fairness-question",
          toolName: "ask_user",
          type: "tool_suspended",
        },
        { reason: "suspended", type: "agent_end" },
      ]);
      await vi.waitFor(
        async () => {
          const run = await harness.store.getRun({
            ...first.scope,
            runId: first.candidate.runId,
          });
          expect(run?.status).toBe("awaiting_approval");
        },
        { timeout: 15_000 }
      );

      await Promise.all([worker.poll(), worker.poll()]);
      await vi.waitFor(() => expect(scripted.sessions).toHaveLength(2), {
        timeout: 15_000,
      });
      const [, secondSession] = scripted.sessions;
      if (!secondSession) {
        throw new Error("The independent project did not start.");
      }
      await secondSession.started;
      await worker.poll();
      expect(scripted.sessions).toHaveLength(2);
      expect(
        (
          await harness.store.getRun({
            ...third.scope,
            runId: third.candidate.runId,
          })
        )?.status
      ).toBe("queued");

      secondSession.complete([{ reason: "complete", type: "agent_end" }]);
      await vi.waitFor(
        async () => {
          expect(
            (
              await harness.store.getRun({
                ...second.scope,
                runId: second.candidate.runId,
              })
            )?.status
          ).toBe("completed");
        },
        { timeout: 15_000 }
      );
      await worker.poll();
      await vi.waitFor(() => expect(scripted.sessions).toHaveLength(3), {
        timeout: 15_000,
      });
      const [, , thirdSession] = scripted.sessions;
      if (!thirdSession) {
        throw new Error("The released slot did not accept queued work.");
      }
      await thirdSession.started;
      thirdSession.complete([{ reason: "complete", type: "agent_end" }]);
    } finally {
      stopSignal.request("test shutdown");
      await worker.stop();
    }
    expect(
      (
        await harness.store.getRun({
          ...first.scope,
          runId: first.candidate.runId,
        })
      )?.status
    ).toBe("cancelled");
  });
});
