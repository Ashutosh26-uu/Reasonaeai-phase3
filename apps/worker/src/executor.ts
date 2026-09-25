import type { RequestContext } from "@mastra/core/request-context";
import type { WorkspaceSandbox } from "@mastra/core/workspace";
import type { RunEventType } from "@reasonateai/contracts/execution-protocol";
import type { RunScope } from "@reasonateai/cto-runtime/run-scope";
import type {
  ProjectStateStore,
  RunFinishStatus,
  RunnableRun,
} from "@reasonateai/project-state/postgres";
import type {
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
import type { LogFields, Logger } from "./logger.js";
import {
  candidateScope,
  createRunRequestContext,
  runLogFields,
} from "./run-context.js";
import { runDirective } from "./run-directive.js";
import type { RunSession, RuntimeFactory } from "./runtime.js";
import type { StopSignal } from "./stop-signal.js";
import { settleWithin } from "./wait.js";
import { workspaceVolumeName } from "./workspace.js";

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
}

export type RunOutcome = "cancelled" | "failed" | "skipped" | "succeeded";

export interface RunExecutorDeps {
  checkpoints: CheckpointStore;
  config: RunExecutionConfig;
  ledger: Ledger;
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

type StopCause = "lease-lost" | "shutdown";

type DriveResult =
  | { kind: "completed" }
  | { kind: "failed"; reason: string }
  | { kind: "stopped"; leaseLost: boolean; reason: string };

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

    const requestContext = createRunRequestContext(scope);
    let sandbox: WorkspaceSandbox | undefined;
    let driven: DriveResult;

    try {
      const runtime = this.#deps.runtime();
      await runtime.controller.init();
      const session = await runtime.controller.createSession({
        requestContext,
        resourceId: scope.projectId,
        scope: scope.buildSessionId,
      });

      sandbox = await this.#deps.resolveSandbox({ requestContext, scope });
      await sandbox.start?.();
      const restored = await restoreLatestCheckpoint({
        checkpoints: this.#deps.checkpoints,
        sandbox: checkpointSandboxFor(sandbox),
        scope,
      });
      logger.info("run.workspace.ready", {
        ...fields,
        restoredCheckpointId: restored?.checkpointId ?? null,
      });

      driven = await this.#drive({
        fields,
        lease,
        requestContext,
        scope,
        session,
        stopSignal,
      });
    } catch (error) {
      driven = { kind: "failed", reason: describeFailure(error).message };
    }

    return await this.#settle({
      driven,
      fields,
      leaseId: lease.leaseId,
      sandbox,
      scope,
    });
  }

  /**
   * Drives the session: subscribe, send the run's directive, and stop the step
   * the moment the lease is lost or the process is told to shut down.
   */
  async #drive(input: {
    fields: LogFields;
    lease: { expiresAt: Date; leaseId: string };
    requestContext: RequestContext;
    scope: RunScope;
    session: RunSession;
    stopSignal: StopSignal;
  }): Promise<DriveResult> {
    const { config, ledger, logger, store } = this.#deps;
    const { fields, scope } = input;

    let failure: FailureDescription | undefined;
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
      logger.warn(
        cause === "lease-lost" ? "run.lease.lost.stop" : "run.shutdown.stop",
        { ...fields, reason }
      );
      input.session.abortRun();
      settleStop?.({ cause, reason });
    };

    const unsubscribeStop = input.stopSignal.subscribe((reason) =>
      requestStop("shutdown", reason)
    );
    const keeper = new LeaseKeeper({
      expiresAt: input.lease.expiresAt,
      fields,
      holder: config.holder,
      leaseId: input.lease.leaseId,
      logger,
      onLost: (reason) => requestStop("lease-lost", reason),
      renew: async (renewal) => await store.renewRunLease(renewal),
      renewIntervalMs: config.renewIntervalMs,
      runId: scope.runId,
      ttlMs: config.leaseTtlMs,
    });
    const appends = new RunEventAppender({
      fields,
      identity: scope,
      ledger,
      logger,
    });
    const unsubscribeEvents = input.session.subscribe((event) => {
      appends.push(event, new Date());
    });

    // The directive goes out before the lease keeper is useful, but the send is
    // not awaited here: a stop request has to be able to win the race.
    const sending = input.session
      .sendMessage({
        content: runDirective({
          buildSessionId: scope.buildSessionId,
          runId: scope.runId,
        }),
        requestContext: input.requestContext,
        untilIdle: true,
      })
      .then(
        () => undefined,
        (error: unknown) => {
          failure = describeFailure(error);
        }
      );

    keeper.start();
    try {
      await Promise.race([sending, stopRequested]);
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
      await keeper.stop();
      unsubscribeStop();
      unsubscribeEvents();
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
    return { kind: "completed" };
  }

  /**
   * Ends the run: record the outcome, release the workspace, then move the run
   * to its terminal status. A run whose lease was lost is the exception — the
   * workspace belongs to whoever holds the lease now, and the outcome is only
   * recorded once the run is actually ended here.
   */
  async #settle(input: {
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
      if (!ended) {
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
    const failureReason =
      input.driven.kind === "failed" ? input.driven.reason : undefined;
    const stoppedReason =
      input.driven.kind === "stopped" ? input.driven.reason : undefined;
    const reason = failureReason ?? stoppedReason;

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
      fields,
      retainedReason:
        "the workspace checkpoint failed, so the volume holds the only copy of this run's work",
      sandbox: input.sandbox,
      scope,
      snapshot: true,
    });

    if (status === "succeeded") {
      await ledger.appendTransition({
        identity: scope,
        payload: {
          bytes: checkpoint?.bytes ?? null,
          checkpointId: checkpoint?.checkpointId ?? null,
          outcome: status,
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
    logger.info("run.finished", {
      ...fields,
      ...(checkpoint === undefined
        ? {}
        : { checkpointId: checkpoint.checkpointId }),
      outcome: status,
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
    fields: LogFields;
    retainedReason: string;
    sandbox: WorkspaceSandbox | undefined;
    scope: RunScope;
    snapshot: boolean;
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
          checkpoints: this.#deps.checkpoints,
          sandbox: checkpointSandboxFor(sandbox),
          scope,
        });
      } catch (error) {
        logger.error("run.checkpoint.failed", {
          ...fields,
          failure: describeFailure(error).message,
        });
      }
    }

    try {
      await sandbox.destroy?.();
    } catch (error) {
      logger.error("run.sandbox.destroy.failed", {
        ...fields,
        failure: describeFailure(error).message,
      });
    }

    if (written === undefined) {
      logger.warn("run.volume.retained", {
        ...fields,
        reason: input.retainedReason,
        volume: workspaceVolumeName(scope),
      });
      return;
    }

    await removeWorkspaceVolume(scope);
    return written;
  }
}
