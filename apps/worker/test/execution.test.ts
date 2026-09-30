import { randomUUID } from "node:crypto";
import type { AgentControllerEvent } from "@mastra/core/agent-controller";
import type { PromptAttachment } from "@reasonateai/contracts/execution";
import type { RunEventEnvelope } from "@reasonateai/contracts/execution-protocol";
import { type RunId, UserIdSchema } from "@reasonateai/contracts/identity";
import type { ProjectStateStore } from "@reasonateai/project-state/postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createStopSignal } from "../src/stop-signal.js";
import {
  allocateRunFixture,
  containerCount,
  createExecutor,
  createHarness,
  type Harness,
  type RunFixture,
  recordingLiveEvents,
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

/**
 * An assistant message as the controller streams it: the same id and role with
 * the text it has produced so far, updated in place.
 */
function streamed(id: string, text: string): AgentControllerMessage {
  return {
    content: { format: 2, parts: [{ text, type: "text" }] },
    createdAt: new Date(),
    id,
    role: "assistant",
  };
}

type AgentControllerMessage = Extract<
  AgentControllerEvent,
  { type: "message_update" }
>["message"];

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

  async function fixture(
    message?: string,
    attachments?: PromptAttachment[]
  ): Promise<RunFixture> {
    const allocated = await allocateRunFixture(harness, message, attachments);
    volumes.push(allocated.volume);
    return allocated;
  }

  it("forwards durable user attachments into the Mastra session", async () => {
    const attachment = {
      data: "data:image/png;base64,aGVsbG8=",
      filename: "wireframe.png",
      mediaType: "image/png",
    };
    const scripted = scriptedRuntime();
    const executor = createExecutor({
      harness,
      holder: "worker-attachments",
      runtime: scripted.runtime,
    });
    const allocated = await fixture("Inspect this screen", [attachment]);

    const attempt = executor.execute(allocated.candidate, createStopSignal());
    const session = await scripted.waitForSession();
    await session.started;
    expect(session.lastFiles).toEqual([attachment]);
    session.complete([{ reason: "complete", type: "agent_end" }]);

    expect(await attempt).toBe("succeeded");
  });

  it("keeps a suspended ask_user run leased, then resumes the same session with the answer", async () => {
    const scripted = scriptedRuntime({
      events: [
        {
          message: streamed("partial-answer", "I need one detail."),
          type: "message_update",
        },
      ],
    });
    const executor = createExecutor({
      harness,
      holder: "worker-question",
      runtime: scripted.runtime,
    });
    const allocated = await fixture("Choose a region");
    const attempt = executor.execute(allocated.candidate, createStopSignal());
    const session = await scripted.waitForSession();
    await session.started;
    session.complete([
      {
        args: { question: "Which region?" },
        resumeSchema: "string",
        suspendPayload: { question: "Which region?" },
        toolCallId: "ask-1",
        toolName: "ask_user",
        type: "tool_suspended",
      },
      { reason: "suspended", type: "agent_end" },
    ]);
    await vi.waitFor(async () => {
      expect(await runStatus(harness, allocated)).toBe("awaiting_approval");
    });
    expect(await leaseRow(harness, allocated.candidate.runId)).toBeDefined();
    expect(await containerCount(allocated.volume)).toBe(1);
    expect(
      (
        await harness.store.listConversationMessages({
          buildSessionId: allocated.buildSessionId,
          scope: allocated.scope,
        })
      ).some((message) => message.text === "I need one detail.")
    ).toBe(true);
    const runnables = await harness.store.listRunnableRuns({ limit: 64 });
    expect(
      runnables.some((run) => run.runId === allocated.candidate.runId)
    ).toBe(false);
    expect(
      await harness.store.answerRunQuestion({
        answer: "Europe",
        buildSessionId: allocated.buildSessionId,
        requestedByUserId: UserIdSchema.parse(randomUUID()),
        runId: allocated.candidate.runId,
        scope: allocated.scope,
        toolCallId: "ask-1",
      })
    ).toBe("accepted");
    await vi.waitFor(
      () => {
        expect(session.lastResumeData).toBe("Europe");
      },
      { timeout: 3000 }
    );
    expect(session.lastResumedToolCallId).toBe("ask-1");
    session.complete([{ reason: "complete", type: "agent_end" }]);
    expect(await attempt).toBe("succeeded");
    expect(await runStatus(harness, allocated)).toBe("completed");
    expect(session.sendCalls).toBe(1);
    expect(await leaseRow(harness, allocated.candidate.runId)).toBeUndefined();
  });

  it("publishes the text its agent streams as live deltas, and the ledger keeps the message", async () => {
    const scripted = scriptedRuntime({
      events: [
        {
          message: streamed("m-live", "Reading the router "),
          type: "message_update",
        },
        {
          message: streamed("m-live", "Reading the router of the app."),
          type: "message_update",
        },
        {
          message: streamed("m-live", "Reading the router of the app."),
          type: "message_end",
        },
        { reason: "complete", type: "agent_end" },
      ],
    });
    const live = recordingLiveEvents();
    const executor = createExecutor({
      harness,
      holder: "worker-live",
      live: live.publisher,
      runtime: scripted.runtime,
    });
    const allocated = await fixture("Trace the router");

    const attempt = executor.execute(allocated.candidate, createStopSignal());
    const session = await scripted.waitForSession();
    await session.started;
    session.complete([{ reason: "complete", type: "agent_end" }]);

    expect(await attempt).toBe("succeeded");

    // Two updates, one delta each: the second carries only what it added, and
    // the end of the message repeats nothing.
    expect(live.frames).toMatchObject([
      {
        kind: "message.snapshot",
        snapshot: {
          finished: false,
          parts: [{ text: "Reading the router " }],
          revision: 1,
        },
      },
      {
        kind: "message.snapshot",
        snapshot: {
          finished: false,
          parts: [{ text: "Reading the router of the app." }],
          revision: 2,
        },
      },
      {
        kind: "message.snapshot",
        snapshot: {
          finished: true,
          parts: [{ text: "Reading the router of the app." }],
          revision: 3,
        },
      },
    ]);

    // The durable record still holds the completed message once, which is what
    // a client that missed every delta reads.
    const events = await ledger(harness, allocated);
    expect(
      events.filter((event) => event.payload.kind === "message_snapshot")
    ).toHaveLength(2);
  });

  it("sends the user's saved prompt to the CTO", async () => {
    const scripted = scriptedRuntime();
    const executor = createExecutor({
      harness,
      holder: "worker-prompt",
      runtime: scripted.runtime,
    });
    const allocated = await fixture("Build a calendar with reminders");
    const attempt = executor.execute(allocated.candidate, createStopSignal());
    const session = await scripted.waitForSession();
    await session.started;
    expect(session.lastMessage).toBe("Build a calendar with reminders");
    session.complete([{ reason: "complete", type: "agent_end" }]);
    expect(await attempt).toBe("succeeded");
  });

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

  it("starts a fresh sandbox and restores the checkpoint for a follow-up turn", async () => {
    const allocated = await fixture("Create the first version");
    const first = scriptedRuntime();
    const firstAttempt = createExecutor({
      harness,
      holder: "worker-follow-up-first",
      runtime: first.runtime,
    }).execute(allocated.candidate, createStopSignal());
    const firstSession = await first.waitForSession();
    await firstSession.started;
    firstSession.complete([{ reason: "complete", type: "agent_end" }]);
    expect(await firstAttempt).toBe("succeeded");

    const turn = await harness.store.appendConversationTurn({
      buildSessionId: allocated.buildSessionId,
      idempotencyKey: randomUUID(),
      message: "Continue the same project",
      scope: allocated.scope,
    });
    const candidate = (
      await harness.store.listRunnableRuns({ limit: 32 })
    ).find((run) => run.runId === turn.runId);
    expect(candidate).toBeDefined();
    if (candidate === undefined) {
      return;
    }

    const second = scriptedRuntime();
    const secondAttempt = createExecutor({
      harness,
      holder: "worker-follow-up-second",
      runtime: second.runtime,
    }).execute(candidate, createStopSignal());
    const secondSession = await second.waitForSession();
    await secondSession.started;
    expect(secondSession.lastMessage).toBe("Continue the same project");
    secondSession.complete([{ reason: "complete", type: "agent_end" }]);
    expect(await secondAttempt).toBe("succeeded");
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

  it("aborts an active Mastra run after a durable user cancellation request", async () => {
    const scripted = scriptedRuntime();
    const executor = createExecutor({
      harness,
      holder: "worker-user-cancel",
      runtime: scripted.runtime,
    });
    const allocated = await fixture();
    const attempt = executor.execute(allocated.candidate, createStopSignal());
    const session = await scripted.waitForSession();
    await session.started;

    expect(
      await harness.store.requestRunCancellation({
        buildSessionId: allocated.candidate.buildSessionId,
        requestedByUserId: UserIdSchema.parse(randomUUID()),
        runId: allocated.candidate.runId,
        scope: allocated.scope,
      })
    ).toBe(true);
    expect(await attempt).toBe("cancelled");
    expect(session.aborted).toBe(true);
    expect(await runStatus(harness, allocated)).toBe("cancelled");
    expect(await leaseRow(harness, allocated.candidate.runId)).toBeUndefined();
    expect((await ledger(harness, allocated)).at(-1)?.type).toBe(
      "run.cancelled"
    );
  });
});
