import type { RequestContext } from "@mastra/core/request-context";
import type { WorkspaceSandbox } from "@mastra/core/workspace";
import type { RunEventType } from "@reasonateai/contracts/execution-protocol";
import { RunLiveEventMapper } from "@reasonateai/cto-runtime/run-live-events";
import type { RunScope } from "@reasonateai/cto-runtime/run-scope";
import type {
  ProjectStateStore,
  RunFinishStatus,
  RunLeaseGrant,
  RunnableRun,
} from "@reasonateai/project-state/postgres";
import type {
  CheckpointReference,
  CheckpointStore,
  CheckpointWriteResult,
} from "@reasonateai/sandbox/checkpoint";
import {
  checkpointSandboxFor,
  removeWorkspaceVolume,
  restoreLatestCheckpoint,
  snapshotWorkspaceCheckpoint,
} from "./checkpoint.js";
import { describeFailure, type FailureDescription } from "./failure.js";
import { LeaseKeeper } from "./lease.js";
import { type Ledger, RunEventAppender } from "./ledger.js";
import type { LiveEventPublisher } from "./live-events.js";
import type { LogFields, Logger } from "./logger.js";
import {
  prepareRecoveredSandbox,
  recoveredWorkspaceExists,
  stopRecoveredSandbox,
} from "./recovery.js";
import {
  candidateScope,
  createRunRequestContext,
  runLogFields,
} from "./run-context.js";
import { runDirective } from "./run-directive.js";
import type { RunRuntime, RunSession, RuntimeFactory } from "./runtime.js";
import { startRunSteering } from "./steering.js";
import { createStopSignal, type StopSignal } from "./stop-signal.js";
import { settleWithin } from "./wait.js";
import { releaseBuildSandbox, workspaceVolumeName } from "./workspace.js";

/**
 * One run, from lease to ledger.
 *
 * The order below is the whole contract of the execution plane:
 *
 * 1. Claim the run under a lease. The claim is one conditional write, so of two
 *    workers polling over the same run exactly one proceeds and the other has
 *    no side effect at all.
 * 2. Restore the workspace from the project's latest checkpoint and drive the
 *    run through a controller session, appending every durable event as it is
 *    emitted and renewing the lease while the work is in flight.
 * 3. Snapshot, discard the sandbox, and end the run — state first, status last.
 *    A run is never left `running` without a lease on any path this worker
 *    controls, and no run is ever acknowledged before its state is durable.
 */

export interface RunExecutionConfig {
  holder: string;
  leaseTtlMs: number;
  renewIntervalMs: number;
  /** How long an aborted step may take to settle before teardown proceeds. */
  stopGraceMs: number;
  /** How long a question may wait for user answer before durably parking the run. */
  suspensionTimeoutMs?: number;
}

export type RunOutcome =
  | "cancelled"
  | "failed"
  | "parked"
  | "skipped"
  | "succeeded";

export interface RunExecutorDeps {
  checkpoints: CheckpointStore;
  config: RunExecutionConfig;
  ledger: Ledger;
  /** The run's live view: text as the model produces it. */
  live: LiveEventPublisher;
  logger: Logger;
  resolveSandbox: (input: {
    requestContext: RequestContext;
    scope: RunScope;
  }) => Promise<WorkspaceSandbox>;
  runtime: RuntimeFactory;
  store: ProjectStateStore;
}

/** The outcome a finished run is recorded under, as a ledger event. */
const TERMINAL_EVENT: Record<RunFinishStatus, RunEventType> = {
  cancelled: "run.cancelled",
  failed: "run.failed",
  succeeded: "run.completed",
};

type StopCause = "lease-lost" | "shutdown" | "user";
const CHECKPOINT_COMMIT_PATTERN = /^[a-f0-9]{40,64}$/;

type DriveResult =
  | { kind: "completed" }
  | { kind: "failed"; reason: string }
  | { kind: "stopped"; leaseLost: boolean; reason: string }
  | { kind: "parked"; reason: string; toolCallId: string };

/** The terminal status each way an attempt can end is recorded under. */
function finishStatusOf(driven: DriveResult): RunFinishStatus {
  if (driven.kind === "completed") {
    return "succeeded";
  }
  if (driven.kind === "stopped") {
    return driven.leaseLost ? "failed" : "cancelled";
  }
  return "failed";
}

function logFinishedRun(input: {
  checkpointId?: string;
  fields: LogFields;
  logger: Logger;
  outcome: RunFinishStatus;
  reason: string | null;
}): void {
  const logFields = {
    ...input.fields,
    ...(input.checkpointId === undefined
      ? {}
      : { checkpointId: input.checkpointId }),
    outcome: input.outcome,
    ...(input.reason === null ? {} : { reason: input.reason }),
  };
  if (input.outcome === "failed") {
    input.logger.error("run.finished", logFields);
  } else {
    input.logger.info("run.finished", logFields);
  }
}

interface StopRequest {
  cause: StopCause;
  reason: string;
}

export class RunExecutor {
  readonly #deps: RunExecutorDeps;

  constructor(deps: RunExecutorDeps) {
    this.#deps = deps;
  }

  /**
   * Claims and executes one candidate. Returns `skipped` without any side effect
   * when another holder got there first or the run already ended.
   */
  async execute(
    candidate: RunnableRun,
    stopSignal: StopSignal
  ): Promise<RunOutcome> {
    const { config, ledger, logger, store } = this.#deps;
    const scope = candidateScope(candidate);
    const fields = runLogFields(scope);

    const lease = await store.beginRun({
      holder: config.holder,
      runId: scope.runId,
      ttlMs: config.leaseTtlMs,
    });
    if (lease === undefined) {
      logger.debug("run.not.taken", {
        ...fields,
        reason:
          "another holder owns a live lease, or the run has already ended",
      });
      return "skipped";
    }

    logger.info("run.claimed", {
      ...fields,
      leaseExpiresAt: lease.expiresAt.toISOString(),
    });
    await ledger.appendTransition({
      identity: scope,
      payload: {
        holder: config.holder,
        leaseExpiresAt: lease.expiresAt.toISOString(),
      },
      type: "run.claimed",
    });

    return await this.#executeClaimed(candidate, scope, lease, stopSignal);
  }

  async #executeClaimed(
    candidate: RunnableRun,
    scope: RunScope,
    lease: RunLeaseGrant,
    stopSignal: StopSignal
  ): Promise<RunOutcome> {
    const { config, logger, store } = this.#deps;
    const localStop = createStopSignal();
    const unsubscribe = stopSignal.subscribe((reason) =>
      localStop.request(reason)
    );
    const keeper = new LeaseKeeper({
      expiresAt: lease.expiresAt,
      fields: runLogFields(scope),
      holder: config.holder,
      leaseId: lease.leaseId,
      logger,
      onLost: (reason) => localStop.request(reason),
      renew: (renewal) => store.renewRunLease(renewal),
      renewIntervalMs: config.renewIntervalMs,
      runId: scope.runId,
      ttlMs: config.leaseTtlMs,
    });
    keeper.start();
    try {
      return await this.#executeWorkspace(
        candidate,
        scope,
        lease,
        localStop,
        keeper
      );
    } finally {
      await keeper.stop();
      unsubscribe();
    }
  }

  async #executeWorkspace(
    candidate: RunnableRun,
    scope: RunScope,
    lease: RunLeaseGrant,
    stopSignal: StopSignal,
    keeper: LeaseKeeper
  ): Promise<RunOutcome> {
    const { store, logger } = this.#deps;
    const fields = runLogFields(scope);
    const requestContext = createRunRequestContext(scope);
    let sandbox: WorkspaceSandbox | undefined;
    let baseCommit: string | null | undefined;
    let driven: DriveResult;
    let workspaceReady = false;

    const recordedOutcome = await this.#recordedOutcome(scope);
    if (recordedOutcome !== undefined) {
      return await this.#recoverRecordedTerminal({
        lease,
        outcome: recordedOutcome,
        requestContext,
        scope,
      });
    }
    try {
      const runtime = this.#deps.runtime();
      await runtime.controller.init();
      const { session, checkpointEmpty } = await this.#conversationSession(
        runtime,
        scope,
        requestContext
      );

      const recovery =
        candidate.pendingToolCallId && candidate.pendingMastraRunId
          ? {
              mastraRunId: candidate.pendingMastraRunId,
              toolCallId: candidate.pendingToolCallId,
            }
          : undefined;
      const retainedWorkspace = await recoveredWorkspaceExists(scope);
      if (recovery) {
        session.suspensions.register({
          runId: recovery.mastraRunId,
          toolCallId: recovery.toolCallId,
          toolName: candidate.pendingToolName ?? "ask_user",
        });
      }
      if (recovery || retainedWorkspace) {
        await prepareRecoveredSandbox(scope);
      }

      sandbox = await this.#deps.resolveSandbox({ requestContext, scope });
      await sandbox.start?.();
      await this.#checkpointRetainedWorkspace({
        retained: retainedWorkspace,
        sandbox,
        scope,
        suspended: recovery !== undefined,
      });
      const restored =
        recovery && retainedWorkspace
          ? undefined
          : await restoreLatestCheckpoint({
              checkpoints: this.#deps.checkpoints,
              sandbox: checkpointSandboxFor(sandbox),
              scope,
              store,
            });
      logger.info("run.workspace.ready", {
        ...fields,
        restoredCheckpointId: restored?.checkpointId ?? null,
      });
      baseCommit = await this.#resolveBaseCommit({
        recovery: recovery !== undefined,
        restored,
        sandbox,
      });
      if (!recovery) {
        const boundary = await snapshotWorkspaceCheckpoint({
          checkpoints: this.#deps.checkpoints,
          sandbox: checkpointSandboxFor(sandbox),
          scope,
        });
        await store.history.boundary(scope, scope.runId, boundary.checkpointId);
        if (checkpointEmpty) {
          baseCommit = await this.#resolveBaseCommit({
            recovery: false,
            restored: boundary,
            sandbox,
          });
        }
      }
      workspaceReady = true;

      driven = await this.#drive({
        fields,
        keeper,
        lease,
        message: candidate.userMessage,
        requestContext,
        ...(recovery === undefined ? {} : { resume: recovery }),
        scope,
        session,
        stopSignal,
        userAttachments: candidate.userAttachments,
      });
    } catch (error) {
      driven = { kind: "failed", reason: describeFailure(error).message };
    }

    if (driven.kind === "parked") {
      return await this.#park({
        baseCommit,
        driven,
        fields,
        leaseId: lease.leaseId,
        sandbox,
        scope,
      });
    }

    if (!workspaceReady && sandbox) {
      await this.#teardown({
        fields,
        retainedReason: "Workspace preparation failed; preserved for recovery.",
        sandbox,
        scope,
        snapshot: false,
      });
      sandbox = undefined;
    }
    return await this.#settle({
      baseCommit,
      driven,
      fields,
      leaseId: lease.leaseId,
      sandbox,
      scope,
    });
  }

  async #conversationSession(
    runtime: RunRuntime,
    scope: RunScope,
    requestContext: RequestContext
  ): Promise<{ session: RunSession; checkpointEmpty: boolean }> {
    const { store } = this.#deps;
    const head = await store.history.head(scope, scope.buildSessionId);
    const threadId = head?.threadId ?? scope.buildSessionId;
    const resourceId =
      threadId === scope.buildSessionId
        ? scope.projectId
        : `${scope.organizationId}:${scope.projectId}:${scope.buildSessionId}:${threadId}`;
    if (threadId !== scope.buildSessionId) {
      if (!runtime.prepareHistory) {
        throw new Error(
          "The runtime cannot rebuild retained conversation context."
        );
      }
      await runtime.prepareHistory({
        buildSessionId: scope.buildSessionId,
        resourceId,
        runId: scope.runId,
        scope,
        store,
        threadId,
      });
    }
    const session = await runtime.controller.createSession({
      requestContext,
      resourceId,
      scope: scope.buildSessionId,
      threadId,
    });
    return { checkpointEmpty: head?.checkpointEmpty ?? false, session };
  }

  async #resolveBaseCommit(input: {
    recovery: boolean;
    restored: CheckpointReference | undefined;
    sandbox: WorkspaceSandbox;
  }): Promise<string | null> {
    if (input.restored === undefined && !input.recovery) {
      return null;
    }
    const head = await checkpointSandboxFor(input.sandbox).runCommand({
      args: ["rev-parse", "HEAD"],
      command: "git",
      cwd: "/workspace",
    });
    if (
      head.exitCode === 0 &&
      CHECKPOINT_COMMIT_PATTERN.test(head.stdout.trim())
    ) {
      return head.stdout.trim();
    }
    if (input.recovery) {
      return null;
    }
    throw new Error("The restored checkpoint commit could not be verified.");
  }

  async #checkpointRetainedWorkspace(input: {
    retained: boolean;
    suspended: boolean;
    sandbox: WorkspaceSandbox;
    scope: RunScope;
  }): Promise<void> {
    if (!input.retained || input.suspended) {
      return;
    }
    const checkpoint = await snapshotWorkspaceCheckpoint({
      checkpoints: this.#deps.checkpoints,
      sandbox: checkpointSandboxFor(input.sandbox),
      scope: input.scope,
    });
    this.#deps.logger.warn("run.workspace.recovered", {
      ...runLogFields(input.scope),
      checkpointId: checkpoint.checkpointId,
      reason:
        "Retained workspace edits were checkpointed before restoring project state.",
    });
  }

  async #recoverRecordedTerminal(input: {
    lease: { expiresAt: Date; leaseId: string };
    outcome: RunFinishStatus;
    requestContext: RequestContext;
    scope: RunScope;
  }): Promise<RunOutcome> {
    const { config, ledger, logger, store } = this.#deps;
    const { scope } = input;
    const fields = runLogFields(scope);
    let leaseLost = false;
    const keeper = new LeaseKeeper({
      expiresAt: input.lease.expiresAt,
      fields,
      holder: config.holder,
      leaseId: input.lease.leaseId,
      logger,
      onLost: () => {
        leaseLost = true;
      },
      renew: async (renewal) => await store.renewRunLease(renewal),
      renewIntervalMs: config.renewIntervalMs,
      runId: scope.runId,
      ttlMs: config.leaseTtlMs,
    });
    let sandbox: WorkspaceSandbox | undefined;
    let checkpoint: CheckpointWriteResult | undefined;
    keeper.start();
    try {
      const retained = await recoveredWorkspaceExists(scope);
      await stopRecoveredSandbox(scope);
      releaseBuildSandbox(scope);
      if (retained) {
        sandbox = await this.#deps.resolveSandbox({
          requestContext: input.requestContext,
          scope,
        });
        await sandbox.start?.();
        // Never restore an older checkpoint over the previous worker's edits.
        checkpoint = await snapshotWorkspaceCheckpoint({
          checkpoints: this.#deps.checkpoints,
          sandbox: checkpointSandboxFor(sandbox),
          scope,
        });
        await store.history.publish(
          scope,
          scope.buildSessionId,
          checkpoint.checkpointId,
          { leaseId: input.lease.leaseId, runId: scope.runId }
        );
        await ledger.appendTransition({
          identity: scope,
          payload: {
            bytes: checkpoint.bytes,
            checkpointId: checkpoint.checkpointId,
            ...(checkpoint.checkpoint === undefined
              ? {}
              : { checkpoint: checkpoint.checkpoint }),
            outcome: input.outcome,
            reason: "Recovered the interrupted worker's terminal workspace.",
          },
          type: TERMINAL_EVENT[input.outcome],
        });
      }
      if (leaseLost) {
        throw new Error("The terminal recovery lost its run lease.");
      }
    } catch (error) {
      logger.error("run.terminal.recovery.blocked", {
        ...fields,
        failure: describeFailure(error).message,
        reason:
          "The retained workspace must be checkpointed before retry is permitted.",
        volume: workspaceVolumeName(scope),
      });
      throw error;
    } finally {
      if (sandbox !== undefined && !leaseLost) {
        await this.#teardown({
          fields,
          retainedReason:
            "terminal recovery retains the workspace until cleanup can be confirmed",
          sandbox,
          scope,
          snapshot: false,
        });
        if (checkpoint !== undefined) {
          try {
            await removeWorkspaceVolume(scope);
          } catch (error) {
            logger.error("run.volume.cleanup.failed", {
              ...fields,
              checkpointId: checkpoint.checkpointId,
              failure: describeFailure(error).message,
              volume: workspaceVolumeName(scope),
            });
          }
        }
      }
      await keeper.stop();
    }
    if (leaseLost) {
      throw new Error("The terminal recovery lost its run lease.");
    }
    const ended = await store.finishRun({
      holder: config.holder,
      leaseId: input.lease.leaseId,
      runId: scope.runId,
      status: input.outcome,
    });
    logger.warn("run.terminal.recovered", {
      ...fields,
      checkpointId: checkpoint?.checkpointId ?? null,
      ended,
      outcome: input.outcome,
    });
    return ended ? input.outcome : "failed";
  }

  async #recordedOutcome(
    scope: RunScope
  ): Promise<RunFinishStatus | undefined> {
    let afterSequence = 0;
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: the next ledger cursor depends on the previous page
      const events = await this.#deps.store.listRunEvents({
        afterSequence,
        limit: 200,
        runId: scope.runId,
        scope,
      });
      for (const event of events) {
        const { outcome } = event.payload;
        if (
          (outcome === "cancelled" ||
            outcome === "failed" ||
            outcome === "succeeded") &&
          event.type === TERMINAL_EVENT[outcome]
        ) {
          return outcome;
        }
        afterSequence = event.sequence;
      }
      if (events.length < 200) {
        return;
      }
    }
  }

  /**
   * Drives the session: subscribe, send the run's directive, and stop the step
   * the moment the lease is lost or the process is told to shut down.
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: lease, cancellation, event persistence, and suspension must share one run lifecycle
  async #drive(input: {
    fields: LogFields;
    lease: { expiresAt: Date; leaseId: string };
    message: string | null;
    userAttachments: RunnableRun["userAttachments"];
    requestContext: RequestContext;
    resume?: { toolCallId: string };
    scope: RunScope;
    session: RunSession;
    stopSignal: StopSignal;
    keeper: LeaseKeeper;
  }): Promise<DriveResult> {
    const { config, ledger, logger, store } = this.#deps;
    const { fields, scope } = input;

    let failure: FailureDescription | undefined;
    let pendingQuestion: string | undefined = input.resume?.toolCallId;
    let stop: StopRequest | undefined;
    let settleStop: ((request: StopRequest) => void) | undefined;
    const stopRequested = new Promise<StopRequest>((resolve) => {
      settleStop = resolve;
    });
    const requestStop = (cause: StopCause, reason: string): void => {
      if (stop !== undefined) {
        return;
      }
      stop = { cause, reason };
      let event = "run.shutdown.stop";
      if (cause === "lease-lost") {
        event = "run.lease.lost.stop";
      } else if (cause === "user") {
        event = "run.cancel.requested";
      }
      logger.warn(event, { ...fields, reason });
      input.session.abortRun();
      settleStop?.({ cause, reason });
    };

    const unsubscribeStop = input.stopSignal.subscribe((reason) =>
      requestStop(input.keeper.lost ? "lease-lost" : "shutdown", reason)
    );
    let cancellationPoll: NodeJS.Timeout | undefined;
    let cancellationCheckInFlight = false;
    const checkCancellation = async () => {
      if (stop !== undefined || cancellationCheckInFlight) {
        return;
      }
      cancellationCheckInFlight = true;
      try {
        if (await store.isRunCancellationRequested(scope.runId)) {
          requestStop("user", "the user stopped this run");
        }
      } catch (error) {
        logger.warn("run.cancel.poll.failed", {
          ...fields,
          failure: describeFailure(error).message,
        });
      } finally {
        cancellationCheckInFlight = false;
      }
    };
    const appends = new RunEventAppender({
      fields,
      identity: scope,
      ledger,
      logger,
    });
    // The same controller events feed both views: the ledger records what the
    // run did, and the live channel carries the text it is writing now.
    const live = new RunLiveEventMapper({ scope });
    const unsubscribeEvents = input.session.subscribe((event) => {
      const at = new Date();
      const isSuspension =
        event.type === "tool_suspended" &&
        (event.toolName === "ask_user" || event.toolName === "submit_plan");
      const controllerRunId = isSuspension
        ? (input.session.run.getRunId() ?? undefined)
        : undefined;
      if (isSuspension) {
        pendingQuestion = event.toolCallId;
      }
      if (
        event.type !== "message_start" &&
        event.type !== "message_update" &&
        event.type !== "message_end"
      ) {
        appends.push(event, at, controllerRunId);
      }
      const delta = live.map(event, at);
      if (delta !== undefined) {
        if (delta.kind === "message.snapshot") {
          appends.pushSnapshot(delta.snapshot, at);
        }
        this.#deps.live.publish(delta);
      }
    });

    // The directive goes out before the lease keeper is useful, but the send is
    // not awaited here: a stop request has to be able to win the race.
    await checkCancellation();
    cancellationPoll = setInterval(() => {
      checkCancellation().catch((error: unknown) => {
        logger.error("run.cancel.poll.crashed", {
          ...fields,
          failure: describeFailure(error).message,
        });
      });
    }, 500);
    const sending =
      stop === undefined && input.resume === undefined
        ? input.session
            .sendMessage({
              content:
                input.message ??
                runDirective({
                  buildSessionId: scope.buildSessionId,
                  runId: scope.runId,
                }),
              ...(input.userAttachments.length > 0
                ? { files: input.userAttachments }
                : {}),
              requestContext: input.requestContext,
              untilIdle: true,
            })
            .then(
              () => undefined,
              (error: unknown) => {
                failure = describeFailure(error);
              }
            )
        : Promise.resolve();

    const steering = startRunSteering({
      holder: config.holder,
      leaseId: input.lease.leaseId,
      logger,
      onFailure: (reason) => requestStop("shutdown", reason),
      requestContext: input.requestContext,
      scope,
      session: input.session,
      store,
    });
    try {
      await Promise.race([sending, stopRequested]);
      if (pendingQuestion) {
        for (const snapshot of live.snapshots()) {
          appends.pushSnapshot(snapshot, new Date(), true);
        }
      }
      await appends.drain();
      const suspensionTimeoutMs = config.suspensionTimeoutMs ?? 600_000;
      while (stop === undefined && failure === undefined && pendingQuestion) {
        const toolCallId = pendingQuestion;
        logger.info("run.question.waiting", { ...fields, toolCallId });
        let answer: string | undefined;
        const waitStartedAt = Date.now();
        while (stop === undefined && answer === undefined) {
          if (Date.now() - waitStartedAt >= suspensionTimeoutMs) {
            logger.warn("run.question.timeout", {
              ...fields,
              reason: "Suspension timeout expired waiting for user answer",
              timeoutMs: suspensionTimeoutMs,
              toolCallId,
            });
            break;
          }
          // biome-ignore lint/performance/noAwaitInLoops: the worker must wait for this answer before resuming the controller
          await Promise.race([
            new Promise<void>((resolve) =>
              setTimeout(
                resolve,
                Math.min(
                  500,
                  Math.max(
                    10,
                    suspensionTimeoutMs - (Date.now() - waitStartedAt)
                  )
                )
              )
            ),
            stopRequested,
          ]);
          if (stop === undefined) {
            answer = await store.takeRunAnswer({
              runId: scope.runId,
              scope,
              toolCallId,
            });
          }
        }
        if (stop !== undefined) {
          break;
        }
        if (answer === undefined) {
          return {
            kind: "parked",
            reason: "suspension timeout expired while waiting for user answer",
            toolCallId,
          };
        }
        pendingQuestion = undefined;
        logger.info("run.question.resuming", { ...fields, toolCallId });
        const resuming = input.session.resumeToolCall({
          requestContext: input.requestContext,
          resumeData: answer,
          toolCallId,
        });
        await Promise.race([resuming, stopRequested]);
        if (stop === undefined) {
          await resuming;
          if (pendingQuestion) {
            for (const snapshot of live.snapshots()) {
              appends.pushSnapshot(snapshot, new Date(), true);
            }
          }
          await appends.drain();
        }
      }
      if (stop !== undefined) {
        const settled = await settleWithin(sending, config.stopGraceMs);
        if (!settled) {
          logger.warn("run.stop.timeout", {
            ...fields,
            graceMs: config.stopGraceMs,
            reason:
              "the interrupted step did not settle inside the grace window",
          });
        }
      }
    } finally {
      clearInterval(cancellationPoll);
      try {
        await steering.stop();
      } catch (error) {
        failure = describeFailure(error);
      }
      unsubscribeStop();
      unsubscribeEvents();
      for (const frame of live.finish()) {
        if (frame.kind === "message.snapshot") {
          appends.pushSnapshot(frame.snapshot, new Date());
        }
        this.#deps.live.publish(frame);
      }
      await appends.drain();
    }

    if (stop !== undefined) {
      return {
        kind: "stopped",
        leaseLost: stop.cause === "lease-lost",
        reason: stop.reason,
      };
    }
    if (failure !== undefined) {
      return { kind: "failed", reason: failure.message };
    }

    // The session resolving is not by itself success: a run whose agent ended on
    // a provider error resolves its send while the controller reports a failure,
    // and that verdict is durable in the ledger. The controller's last terminal
    // word decides the run.
    const verdict = appends.verdict();
    if (verdict?.type === "run.failed") {
      return {
        kind: "failed",
        reason: verdict.reason ?? "the run's agent reported a failure",
      };
    }
    if (verdict?.type === "run.cancelled") {
      return {
        kind: "stopped",
        leaseLost: false,
        reason: verdict.reason ?? "the run's controller aborted it",
      };
    }
    if (verdict?.type !== "run.completed") {
      return {
        kind: "failed",
        reason: "the controller stopped without completing the run",
      };
    }
    return { kind: "completed" };
  }

  /**
   * Parks an unanswered suspended run: captures a Git checkpoint snapshot,
   * marks the run as durably parked in the store, records run.parked on the
   * ledger, gracefully releases the PostgreSQL run lease, and destroys the
   * active container to release host resources and worker concurrency slots.
   */
  async #park(input: {
    baseCommit?: string | null | undefined;
    driven: { kind: "parked"; reason: string; toolCallId: string };
    fields: LogFields;
    leaseId: string;
    sandbox: WorkspaceSandbox | undefined;
    scope: RunScope;
  }): Promise<RunOutcome> {
    const { ledger, logger, store } = this.#deps;
    const { driven, fields, scope, sandbox } = input;

    // 1. Transition run state to durably parked awaiting_approval in PostgreSQL
    await store.parkRunSuspension({ runId: scope.runId, scope });

    // 2. Capture a Git checkpoint snapshot of the mutable workspace
    let checkpoint: CheckpointWriteResult | undefined;
    if (sandbox !== undefined) {
      try {
        checkpoint = await snapshotWorkspaceCheckpoint({
          ...(input.baseCommit === undefined
            ? {}
            : { baseCommit: input.baseCommit }),
          checkpoints: this.#deps.checkpoints,
          sandbox: checkpointSandboxFor(sandbox),
          scope,
        });
      } catch (error) {
        logger.error("run.park.checkpoint.failed", {
          ...fields,
          failure: describeFailure(error).message,
        });
      }
    }

    // Append run.parked event to durable ledger
    if (checkpoint) {
      await store.history.publish(
        scope,
        scope.buildSessionId,
        checkpoint.checkpointId,
        { leaseId: input.leaseId, runId: scope.runId }
      );
    }
    await ledger.appendTransition({
      identity: scope,
      payload: {
        bytes: checkpoint?.bytes ?? null,
        checkpointId: checkpoint?.checkpointId ?? null,
        reason: driven.reason,
        toolCallId: driven.toolCallId,
      },
      type: "run.parked",
    });

    // 3. Gracefully release the PostgreSQL run lease
    try {
      await store.releaseRunLease({
        leaseId: input.leaseId,
        runId: scope.runId,
        scope,
      });
    } catch (error) {
      logger.warn("run.park.lease.release.failed", {
        ...fields,
        failure: describeFailure(error).message,
      });
    }

    // 4. Clean up / stop the active Docker container to free host CPU/memory
    if (sandbox !== undefined) {
      try {
        await sandbox.destroy?.();
      } catch (error) {
        logger.error("run.sandbox.destroy.failed", {
          ...fields,
          failure: describeFailure(error).message,
        });
      } finally {
        releaseBuildSandbox(scope);
      }
    }

    logger.info("run.parked", {
      ...fields,
      checkpointId: checkpoint?.checkpointId ?? null,
      toolCallId: driven.toolCallId,
    });

    // 5. Release worker process loop slot (returned to caller)
    return "parked";
  }

  /**
   * Ends the run: record the outcome, release the workspace, then move the run
   * to its terminal status. A run whose lease was lost is the exception — the
   * workspace belongs to whoever holds the lease now, and the outcome is only
   * recorded once the run is actually ended here.
   */
  async #settle(input: {
    baseCommit: string | null | undefined;
    driven: DriveResult;
    fields: LogFields;
    leaseId: string;
    sandbox: WorkspaceSandbox | undefined;
    scope: RunScope;
  }): Promise<RunOutcome> {
    const { config, ledger, logger, store } = this.#deps;
    const { fields, scope } = input;

    if (input.driven.kind === "stopped" && input.driven.leaseLost) {
      await this.#teardown({
        fields,
        retainedReason:
          "the lease moved to another worker, which mounts this same volume",
        sandbox: input.sandbox,
        scope,
        snapshot: false,
      });
      const ended = await store.finishRun({
        holder: config.holder,
        leaseId: input.leaseId,
        runId: scope.runId,
        status: "failed",
      });
      if (ended === false) {
        logger.warn("run.handed.off", {
          ...fields,
          reason: input.driven.reason,
        });
        return "failed";
      }
      await ledger.appendTransition({
        identity: scope,
        payload: { outcome: "failed", reason: input.driven.reason },
        type: TERMINAL_EVENT.failed,
      });
      logger.info("run.failed", { ...fields, reason: input.driven.reason });
      return "failed";
    }

    const status: RunFinishStatus = finishStatusOf(input.driven);
    let reason: string | null = null;
    if (input.driven.kind === "failed" || input.driven.kind === "stopped") {
      ({ reason } = input.driven);
    }

    // The reason is committed before the workspace is touched, so a teardown
    // that hangs cannot lose why the run ended.
    if (status !== "succeeded") {
      await ledger.appendTransition({
        identity: scope,
        payload: { outcome: status, reason: reason ?? "the run was stopped" },
        type: TERMINAL_EVENT[status],
      });
    }

    const checkpoint = await this.#teardown({
      baseCommit: input.baseCommit,
      fields,
      leaseId: input.leaseId,
      retainedReason:
        "the workspace checkpoint failed, so the volume holds the only copy of this run's work",
      sandbox: input.sandbox,
      scope,
      snapshot: true,
    });
    if (status === "succeeded" || checkpoint !== undefined) {
      await ledger.appendTransition({
        identity: scope,
        payload: {
          bytes: checkpoint?.bytes ?? null,
          checkpointId: checkpoint?.checkpointId ?? null,
          ...(checkpoint?.checkpoint === undefined
            ? {}
            : { checkpoint: checkpoint.checkpoint }),
          outcome: status,
          reason,
        },
        type: TERMINAL_EVENT[status],
      });
    }

    const ended = await store.finishRun({
      holder: config.holder,
      leaseId: input.leaseId,
      runId: scope.runId,
      status,
    });
    if (!ended) {
      logger.error("run.finish.rejected", {
        ...fields,
        reason:
          "the run is no longer held by this worker, or it already ended differently",
        status,
      });
    }
    logFinishedRun({
      ...(checkpoint === undefined
        ? {}
        : { checkpointId: checkpoint.checkpointId }),
      fields,
      logger,
      outcome: status,
      reason,
    });

    if (status === "cancelled") {
      return "cancelled";
    }
    return status === "succeeded" ? "succeeded" : "failed";
  }

  /**
   * Snapshots when asked, destroys the container, and removes the volume only
   * once the bytes are in the checkpoint store. Order matters: a volume removed
   * after a failed snapshot is the only copy of the run's work.
   */
  async #teardown(input: {
    baseCommit?: string | null | undefined;
    fields: LogFields;
    retainedReason: string;
    sandbox: WorkspaceSandbox | undefined;
    scope: RunScope;
    snapshot: boolean;
    leaseId?: string;
  }): Promise<CheckpointWriteResult | undefined> {
    const { logger } = this.#deps;
    const { fields, scope, sandbox } = input;
    if (sandbox === undefined) {
      return;
    }

    let written: CheckpointWriteResult | undefined;
    if (input.snapshot) {
      try {
        written = await snapshotWorkspaceCheckpoint({
          ...(input.baseCommit === undefined
            ? {}
            : { baseCommit: input.baseCommit }),
          checkpoints: this.#deps.checkpoints,
          sandbox: checkpointSandboxFor(sandbox),
          scope,
        });
        await this.#deps.store.history.publish(
          scope,
          scope.buildSessionId,
          written.checkpointId,
          { leaseId: input.leaseId ?? "", runId: scope.runId }
        );
        if (written.checkpoint?.status === "unavailable") {
          logger.warn("run.checkpoint.diff.unavailable", {
            ...fields,
            checkpointId: written.checkpoint.checkpointId,
            reason: written.checkpoint.reason,
          });
        }
      } catch (error) {
        written = undefined;
        logger.error("run.checkpoint.failed", {
          ...fields,
          failure: describeFailure(error).message,
        });
      }
    }

    const previewLease = await this.#deps.store.previews
      .getBySession(scope.buildSessionId)
      .catch(() => undefined);
    const retainForPreview =
      previewLease?.status === "starting" || previewLease?.status === "ready";

    if (retainForPreview) {
      logger.info("run.sandbox.retained_for_preview", {
        ...fields,
        previewId: previewLease.previewId,
      });
    } else {
      try {
        await sandbox.destroy?.();
      } catch (error) {
        logger.error("run.sandbox.destroy.failed", {
          ...fields,
          failure: describeFailure(error).message,
        });
      }
    }
    // Drop only this process-local adapter. The next run attaches to the
    // retained container while the conversation still owns an active preview.
    releaseBuildSandbox(scope);

    if (written === undefined || retainForPreview) {
      logger.warn("run.volume.retained", {
        ...fields,
        reason: retainForPreview
          ? "an active app preview owns the same run sandbox"
          : input.retainedReason,
        volume: workspaceVolumeName(scope),
      });
      return written;
    }

    try {
      await removeWorkspaceVolume(scope);
    } catch (error) {
      logger.error("run.volume.cleanup.failed", {
        ...fields,
        checkpointId: written.checkpointId,
        failure: describeFailure(error).message,
        volume: workspaceVolumeName(scope),
      });
    }
    return written;
  }
}
