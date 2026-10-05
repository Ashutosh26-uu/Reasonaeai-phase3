import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AgentControllerEvent } from "@mastra/core/agent-controller";
import type { PromptAttachment } from "@reasonateai/contracts/execution";
import {
  RunCheckpointSchema,
  type RunEventEnvelope,
} from "@reasonateai/contracts/execution-protocol";
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
import {
  checkpointSandboxFor,
  restoreLatestCheckpoint,
} from "../src/checkpoint.js";
import { candidateScope, createRunRequestContext } from "../src/run-context.js";
import { createStopSignal } from "../src/stop-signal.js";
import { resolveBuildSandbox } from "../src/workspace.js";
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

function writeWorkspaceFile(volume: string, path: string, content: string) {
  const container = execFileSync(
    "docker",
    ["ps", "-q", "--filter", `volume=${volume}`],
    { encoding: "utf8" }
  ).trim();
  if (!container || container.includes("\n")) {
    throw new Error("Expected one run sandbox");
  }
  execFileSync("docker", [
    "exec",
    container,
    "node",
    "-e",
    "require('node:fs').writeFileSync(process.argv[1], process.argv[2]);",
    `/workspace/${path}`,
    content,
  ]);
}

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

  it("reclaims an expired suspended run from its durable controller identity", async () => {
    const allocated = await fixture("Ask for the region");
    const oldLease = await harness.store.beginRun({
      holder: "expired-worker",
      runId: allocated.candidate.runId,
      ttlMs: 100,
    });
    expect(oldLease).toBeDefined();
    await harness.store.appendRunEvent({
      controllerRunId: "stored-controller-run",
      payload: {
        kind: "tool_suspended",
        toolCallId: "ask-after-restart",
        toolName: "ask_user",
      },
      runId: allocated.candidate.runId,
      scope: allocated.scope,
      type: "approval.requested",
    });
    execFileSync("docker", ["volume", "create", allocated.volume]);
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    const candidate = (
      await harness.store.listRunnableRuns({ limit: 64 })
    ).find((item) => item.runId === allocated.candidate.runId);
    expect(candidate?.pendingToolCallId).toBe("ask-after-restart");
    expect(candidate?.pendingMastraRunId).toBe("stored-controller-run");
    if (!candidate) {
      throw new Error("The suspended run was not offered for recovery.");
    }
    const scripted = scriptedRuntime();
    const executor = createExecutor({
      harness,
      holder: "recovery-worker",
      runtime: scripted.runtime,
    });
    const attempt = executor.execute(candidate, createStopSignal());
    const session = await scripted.waitForSession();
    await vi.waitFor(() => {
      expect(session.recoveredSuspension).toEqual({
        runId: "stored-controller-run",
        toolCallId: "ask-after-restart",
        toolName: "ask_user",
      });
    });
    expect(
      await harness.store.answerRunQuestion({
        answer: "Europe",
        buildSessionId: allocated.buildSessionId,
        requestedByUserId: UserIdSchema.parse(randomUUID()),
        runId: allocated.candidate.runId,
        scope: allocated.scope,
        toolCallId: "ask-after-restart",
      })
    ).toBe("accepted");
    await vi.waitFor(
      () => {
        expect(session.lastResumeData).toBe("Europe");
      },
      { timeout: 3000 }
    );
    session.complete([{ reason: "complete", type: "agent_end" }]);
    expect(await attempt).toBe("succeeded");
    expect(session.sendCalls).toBe(0);
  });

  it("parks an unanswered suspended run upon suspension timeout, releasing lease and container, and resumes when answered", async () => {
    const allocated = await fixture("Configure environment");
    const scripted = scriptedRuntime();
    const executor = createExecutor({
      harness,
      holder: "worker-suspension-test",
      runtime: scripted.runtime,
      suspensionTimeoutMs: 300,
    });
    const attempt = executor.execute(allocated.candidate, createStopSignal());
    const session = await scripted.waitForSession();
    await session.started;
    session.complete([
      {
        args: { question: "Which region?" },
        resumeSchema: "string",
        suspendPayload: { question: "Which region?" },
        toolCallId: "ask-park-1",
        toolName: "ask_user",
        type: "tool_suspended",
      },
      { reason: "suspended", type: "agent_end" },
    ]);

    const outcome = await attempt;
    expect(outcome).toBe("parked");

    expect(await runStatus(harness, allocated)).toBe("awaiting_approval");
    expect(await leaseRow(harness, allocated.candidate.runId)).toBeUndefined();
    expect(await containerCount(allocated.volume)).toBe(0);

    const parkedRow = await harness.pool.query<{ parked_at: Date | null }>(
      "select parked_at from runs where run_id = $1",
      [allocated.candidate.runId]
    );
    expect(parkedRow.rows[0]?.parked_at).not.toBeNull();

    const events = await ledger(harness, allocated);
    const parkEvent = events.find((e) => e.type === "run.parked");
    expect(parkEvent).toBeDefined();
    expect(parkEvent?.payload).toMatchObject({
      toolCallId: "ask-park-1",
    });

    const runnablesBeforeAnswer = await harness.store.listRunnableRuns({
      limit: 64,
    });
    expect(
      runnablesBeforeAnswer.some(
        (run) => run.runId === allocated.candidate.runId
      )
    ).toBe(false);

    expect(
      await harness.store.answerRunQuestion({
        answer: "us-east-1",
        buildSessionId: allocated.buildSessionId,
        requestedByUserId: UserIdSchema.parse(randomUUID()),
        runId: allocated.candidate.runId,
        scope: allocated.scope,
        toolCallId: "ask-park-1",
      })
    ).toBe("accepted");

    const runnablesAfterAnswer = await harness.store.listRunnableRuns({
      limit: 64,
    });
    const resumedCandidate = runnablesAfterAnswer.find(
      (run) => run.runId === allocated.candidate.runId
    );
    expect(resumedCandidate).toBeDefined();
    if (resumedCandidate === undefined) {
      throw new Error("Expected resumedCandidate to be defined");
    }
    expect(resumedCandidate.pendingToolCallId).toBe("ask-park-1");

    const resumeScripted = scriptedRuntime();
    const resumeExecutor = createExecutor({
      harness,
      holder: "worker-resumer",
      runtime: resumeScripted.runtime,
    });
    const resumeAttempt = resumeExecutor.execute(
      resumedCandidate,
      createStopSignal()
    );
    const resumeSession = await resumeScripted.waitForSession();
    await vi.waitFor(
      () => {
        expect(resumeSession.lastResumeData).toBe("us-east-1");
      },
      { timeout: 3000 }
    );
    expect(resumeSession.lastResumedToolCallId).toBe("ask-park-1");
    resumeSession.complete([{ reason: "complete", type: "agent_end" }]);

    expect(await resumeAttempt).toBe("succeeded");
    expect(await runStatus(harness, allocated)).toBe("completed");
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
    expect(terminal?.payload.checkpoint).toMatchObject({
      baseCommit: null,
      checkpointId,
      status: "available",
    });

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
    writeWorkspaceFile(allocated.volume, "notes.txt", "first\nsecond\n");
    firstSession.complete([{ reason: "complete", type: "agent_end" }]);
    expect(await firstAttempt).toBe("succeeded");
    const firstCheckpoint = RunCheckpointSchema.parse(
      (await ledger(harness, allocated)).at(-1)?.payload.checkpoint
    );
    expect(firstCheckpoint).toMatchObject({
      added: 2,
      baseCommit: null,
      removed: 0,
      status: "available",
    });
    if (firstCheckpoint.status !== "available") {
      throw new Error("First turn has no measured checkpoint");
    }

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
    writeWorkspaceFile(allocated.volume, "notes.txt", "first\nupdated\n");
    writeWorkspaceFile(allocated.volume, "new.txt", "added\n");
    secondSession.complete([{ reason: "complete", type: "agent_end" }]);
    expect(await secondAttempt).toBe("succeeded");
    const secondEvents = await harness.store.listRunEvents({
      afterSequence: 0,
      limit: 200,
      runId: turn.runId,
      scope: allocated.scope,
    });
    expect(secondEvents.at(-1)?.payload.checkpoint).toMatchObject({
      added: 2,
      baseCommit: firstCheckpoint.commit,
      fileCount: 2,
      removed: 1,
      status: "available",
    });
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
    writeWorkspaceFile(
      allocated.volume,
      "partial.txt",
      "saved before failure\n"
    );
    session.crash("the provider refused the run");

    expect(await attempt).toBe("failed");
    expect(await runStatus(harness, allocated)).toBe("failed");
    expect(await leaseRow(harness, allocated.candidate.runId)).toBeUndefined();
    expect(await runningWithoutLease(harness, allocated.candidate.runId)).toBe(
      false
    );

    const terminal = (await ledger(harness, allocated)).at(-1);
    expect(terminal?.type).toBe("run.failed");
    expect(terminal?.payload.checkpoint).toMatchObject({
      added: 1,
      removed: 0,
      status: "available",
    });
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

    writeWorkspaceFile(
      allocated.volume,
      "partial.txt",
      "saved before cancellation\n"
    );
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
    expect(terminal?.payload.checkpoint).toMatchObject({
      added: 1,
      removed: 0,
      status: "available",
    });
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

  it("settles cancellation when checkpointed volume cleanup is refused", async () => {
    const scripted = scriptedRuntime();
    const executor = createExecutor({
      harness,
      holder: "worker-cleanup-cancel",
      runtime: scripted.runtime,
    });
    const allocated = await fixture();
    const stopSignal = createStopSignal();
    const attempt = executor.execute(allocated.candidate, stopSignal);
    const session = await scripted.waitForSession();
    await session.started;
    const blockerName = `reasonate-cleanup-test-${randomUUID()}`;
    let blockerStarted = false;
    try {
      execFileSync("docker", [
        "run",
        "--detach",
        "--rm",
        "--name",
        blockerName,
        "--network",
        "none",
        "--mount",
        `type=volume,source=${allocated.volume},target=/workspace,readonly`,
        "node:22",
        "sleep",
        "120",
      ]);
      blockerStarted = true;
      stopSignal.request("test cancellation with busy volume");
      expect(await attempt).toBe("cancelled");
      expect(await runStatus(harness, allocated)).toBe("cancelled");
      expect(
        await leaseRow(harness, allocated.candidate.runId)
      ).toBeUndefined();
      expect(await volumeCount(allocated.volume)).toBe(1);
      expect(
        harness
          .logs()
          .some(
            (line) =>
              line.includes("run.volume.cleanup.failed") &&
              line.includes(allocated.candidate.runId)
          )
      ).toBe(true);
      expect(
        (await ledger(harness, allocated)).at(-1)?.payload.checkpointId
      ).toEqual(expect.any(String));
    } finally {
      stopSignal.request("test cleanup");
      await attempt;
      if (blockerStarted) {
        execFileSync("docker", ["rm", "--force", blockerName]);
      }
    }
  });

  it("reconciles a durable worker cancellation after a crash without reviving its unanswered question", async () => {
    const allocated = await fixture();
    await harness.store.beginRun({
      holder: "worker-before-crash",
      runId: allocated.candidate.runId,
      ttlMs: 100,
    });
    await harness.store.appendRunEvent({
      controllerRunId: "controller-before-crash",
      payload: {
        kind: "tool_suspended",
        toolCallId: "cancelled-question",
        toolName: "ask_user",
      },
      runId: allocated.candidate.runId,
      scope: allocated.scope,
      type: "approval.requested",
    });
    await harness.store.appendRunEvent({
      payload: { outcome: "cancelled", reason: "the previous worker stopped" },
      runId: allocated.candidate.runId,
      scope: allocated.scope,
      type: "run.cancelled",
    });
    execFileSync("docker", ["volume", "create", allocated.volume]);
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    const candidate = (
      await harness.store.listRunnableRuns({ limit: 64 })
    ).find((run) => run.runId === allocated.candidate.runId);
    if (!candidate) {
      throw new Error("The interrupted run could not be reclaimed.");
    }
    expect(await runStatus(harness, allocated)).toBe("awaiting_approval");
    const scripted = scriptedRuntime();
    const unavailableCheckpoints = {
      ...harness.checkpoints,
      write: () => Promise.reject(new Error("Checkpoint store unavailable")),
    };
    await expect(
      createExecutor({
        harness: { ...harness, checkpoints: unavailableCheckpoints },
        holder: "worker-blocked-recovery",
        runtime: scripted.runtime,
      }).execute(candidate, createStopSignal())
    ).rejects.toThrow("Checkpoint store unavailable");
    expect(await runStatus(harness, allocated)).toBe("awaiting_approval");
    expect(await volumeCount(allocated.volume)).toBe(1);
    await expect(
      harness.store.retryConversationRun({
        buildSessionId: allocated.buildSessionId,
        idempotencyKey: randomUUID(),
        runId: candidate.runId,
        scope: allocated.scope,
      })
    ).rejects.toThrow();
    await harness.pool.query(
      `update run_leases set expires_at = now() - interval '1 second' where run_id = $1`,
      [candidate.runId]
    );
    const executor = createExecutor({
      harness,
      holder: "worker-after-crash",
      runtime: scripted.runtime,
    });
    expect(await executor.execute(candidate, createStopSignal())).toBe(
      "cancelled"
    );
    expect(scripted.initCalls()).toBe(0);
    expect(scripted.sessions).toHaveLength(0);
    expect(await runStatus(harness, allocated)).toBe("cancelled");
    expect(await leaseRow(harness, allocated.candidate.runId)).toBeUndefined();
    expect(await volumeCount(allocated.volume)).toBe(0);
    expect(
      harness
        .logs()
        .some(
          (line) =>
            line.includes("run.terminal.recovered") &&
            line.includes(candidate.runId)
        )
    ).toBe(true);
  });

  it("checkpoints interrupted tracked edits before a terminal retry restores the workspace", async () => {
    const allocated = await fixture("Create notes");
    const first = scriptedRuntime();
    const firstAttempt = createExecutor({
      harness,
      holder: "worker-original",
      runtime: first.runtime,
    }).execute(allocated.candidate, createStopSignal());
    const firstSession = await first.waitForSession();
    await firstSession.started;
    writeWorkspaceFile(allocated.volume, "notes.txt", "original\n");
    firstSession.complete([{ reason: "complete", type: "agent_end" }]);
    expect(await firstAttempt).toBe("succeeded");
    const interrupted = await harness.store.appendConversationTurn({
      buildSessionId: allocated.buildSessionId,
      idempotencyKey: randomUUID(),
      message: "Revise notes",
      scope: allocated.scope,
    });
    const interruptedCandidate = (
      await harness.store.listRunnableRuns({ limit: 64 })
    ).find((run) => run.runId === interrupted.runId);
    if (!interruptedCandidate) {
      throw new Error("The interrupted turn is not runnable.");
    }
    await harness.store.beginRun({
      holder: "worker-crashed",
      runId: interrupted.runId,
      ttlMs: 60_000,
    });
    const scope = candidateScope(interruptedCandidate);
    const sandbox = await resolveBuildSandbox({
      requestContext: createRunRequestContext(scope),
    });
    await sandbox.start?.();
    await restoreLatestCheckpoint({
      checkpoints: harness.checkpoints,
      sandbox: checkpointSandboxFor(sandbox),
      scope,
    });
    writeWorkspaceFile(allocated.volume, "notes.txt", "recovered edit\n");
    await harness.store.appendRunEvent({
      payload: {
        outcome: "cancelled",
        reason: "the worker crashed after recording cancellation",
      },
      runId: interrupted.runId,
      scope: allocated.scope,
      type: "run.cancelled",
    });
    await harness.pool.query(
      `update run_leases set expires_at = now() - interval '1 second' where run_id = $1`,
      [interrupted.runId]
    );
    const recovered = scriptedRuntime();
    expect(
      await createExecutor({
        harness,
        holder: "worker-recovery",
        runtime: recovered.runtime,
      }).execute(interruptedCandidate, createStopSignal())
    ).toBe("cancelled");
    expect(recovered.initCalls()).toBe(0);
    const retry = await harness.store.retryConversationRun({
      buildSessionId: allocated.buildSessionId,
      idempotencyKey: randomUUID(),
      runId: interrupted.runId,
      scope: allocated.scope,
    });
    const retryCandidate = (
      await harness.store.listRunnableRuns({ limit: 64 })
    ).find((run) => run.runId === retry.runId);
    if (!retryCandidate) {
      throw new Error("The retry is not runnable.");
    }
    const retryRuntime = scriptedRuntime();
    const retryStop = createStopSignal();
    const retryAttempt = createExecutor({
      harness,
      holder: "worker-retry",
      runtime: retryRuntime.runtime,
    }).execute(retryCandidate, retryStop);
    const retrySession = await retryRuntime.waitForSession();
    await retrySession.started;
    try {
      const container = execFileSync(
        "docker",
        ["ps", "-q", "--filter", `volume=${allocated.volume}`],
        { encoding: "utf8" }
      ).trim();
      expect(
        execFileSync(
          "docker",
          ["exec", container, "cat", "/workspace/notes.txt"],
          { encoding: "utf8" }
        )
      ).toBe("recovered edit\n");
      retrySession.complete([{ reason: "complete", type: "agent_end" }]);
      expect(await retryAttempt).toBe("succeeded");
    } finally {
      retryStop.request("test cleanup");
      await retryAttempt;
    }
  });

  it("preserves tracked edits on retry after ordinary cancellation checkpoint failure", async () => {
    const allocated = await fixture();
    const original = scriptedRuntime();
    const originalAttempt = createExecutor({
      harness,
      holder: "worker-retry-original",
      runtime: original.runtime,
    }).execute(allocated.candidate, createStopSignal());
    const originalSession = await original.waitForSession();
    await Promise.race([
      originalSession.started,
      originalAttempt.then((outcome) => {
        throw new Error(
          `Original ended before starting: ${outcome}\n${harness.logs().slice(-8).join("\n")}`
        );
      }),
    ]);
    writeWorkspaceFile(allocated.volume, "notes.txt", "original\n");
    originalSession.complete([{ reason: "complete", type: "agent_end" }]);
    expect(await originalAttempt).toBe("succeeded");
    const cancelled = await harness.store.appendConversationTurn({
      buildSessionId: allocated.buildSessionId,
      idempotencyKey: randomUUID(),
      message: "Revise notes",
      scope: allocated.scope,
    });
    const cancelledCandidate = (
      await harness.store.listRunnableRuns({ limit: 64 })
    ).find((run) => run.runId === cancelled.runId);
    if (!cancelledCandidate) {
      throw new Error("The cancellation fixture is not runnable.");
    }
    const cancellation = scriptedRuntime();
    const cancelStop = createStopSignal();
    const unavailable = {
      ...harness,
      checkpoints: {
        ...harness.checkpoints,
        write: () => Promise.reject(new Error("Checkpoint store unavailable")),
      },
    };
    const cancelAttempt = createExecutor({
      harness: unavailable,
      holder: "worker-cancel-checkpoint-failure",
      runtime: cancellation.runtime,
    }).execute(cancelledCandidate, cancelStop);
    const cancelSession = await cancellation.waitForSession();
    await Promise.race([
      cancelSession.started,
      cancelAttempt.then((outcome) => {
        throw new Error(
          `Cancellation ended before starting: ${outcome}\n${harness.logs().slice(-8).join("\n")}`
        );
      }),
    ]);
    writeWorkspaceFile(
      allocated.volume,
      "notes.txt",
      "preserved cancellation edit\n"
    );
    cancelStop.request("test cancellation");
    expect(await cancelAttempt).toBe("cancelled");
    expect(await volumeCount(allocated.volume)).toBe(1);
    const retry = await harness.store.retryConversationRun({
      buildSessionId: allocated.buildSessionId,
      idempotencyKey: randomUUID(),
      runId: cancelled.runId,
      scope: allocated.scope,
    });
    const candidate = (
      await harness.store.listRunnableRuns({ limit: 64 })
    ).find((run) => run.runId === retry.runId);
    if (!candidate) {
      throw new Error("The retry fixture is not runnable.");
    }
    const runtime = scriptedRuntime();
    const stop = createStopSignal();
    const attempt = createExecutor({
      harness,
      holder: "worker-retained-retry",
      runtime: runtime.runtime,
    }).execute(candidate, stop);
    const session = await runtime.waitForSession();
    await Promise.race([
      session.started,
      attempt.then((outcome) => {
        throw new Error(
          `Retry ended before starting: ${outcome}\n${harness.logs().slice(-8).join("\n")}`
        );
      }),
    ]);
    try {
      const container = execFileSync(
        "docker",
        ["ps", "-q", "--filter", `volume=${allocated.volume}`],
        { encoding: "utf8" }
      ).trim();
      expect(
        execFileSync(
          "docker",
          ["exec", container, "cat", "/workspace/notes.txt"],
          { encoding: "utf8" }
        )
      ).toBe("preserved cancellation edit\n");
      session.complete([{ reason: "complete", type: "agent_end" }]);
      expect(await attempt).toBe("succeeded");
      expect(
        harness
          .logs()
          .some(
            (line) =>
              line.includes("run.workspace.recovered") &&
              line.includes(candidate.runId)
          )
      ).toBe(true);
    } finally {
      stop.request("test cleanup");
      await attempt;
    }
  });
});
