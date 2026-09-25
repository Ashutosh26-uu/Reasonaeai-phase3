import type { ProjectStateStore } from "@reasonateai/project-state/postgres";
import type { WorkerConfig } from "./config.js";
import type { RunExecutor } from "./executor.js";
import { describeFailure } from "./failure.js";
import type { Logger } from "./logger.js";
import { candidateScope, runLogFields } from "./run-context.js";
import type { StopSignal } from "./stop-signal.js";

/**
 * The poll loop.
 *
 * The worker discovers work by asking PostgreSQL for runnable runs and claiming
 * one under a lease; Redis is only ever the live transport for the events those
 * claims produce. Polling is bounded on every axis that could grow: a poll
 * claims at most `maxRunsPerPoll` candidates, only one run executes at a time,
 * the interval is fixed plus jitter so two workers do not synchronize their
 * reads, and consecutive database failures back off with a doubling delay up to
 * a ceiling instead of hammering a database that is already refusing.
 *
 * One run at a time is deliberate rather than a simplification: the sandbox
 * identity is derived from organization, project, and build session, so two
 * concurrent runs of one build session would contend for one container name and
 * one workspace volume. Parallelism belongs at the worker-fleet level.
 */

const MAX_BACKOFF_DOUBLINGS = 4;
const MAX_POLL_DELAY_MS = 60_000;
const STOP_REASON = "the worker was asked to stop";

export interface RunWorkerDeps {
  config: WorkerConfig;
  executor: RunExecutor;
  logger: Logger;
  stopSignal: StopSignal;
  store: ProjectStateStore;
}

export class RunWorker {
  #active: Promise<void> | undefined;
  readonly #deps: RunWorkerDeps;
  #failures = 0;
  #stopReason: string | undefined;
  #timer: NodeJS.Timeout | undefined;

  constructor(deps: RunWorkerDeps) {
    this.#deps = deps;
  }

  get stopping(): boolean {
    return this.#stopReason !== undefined;
  }

  start(): void {
    this.#schedule(0);
  }

  /**
   * Stops scheduling and waits for the run in flight. The run ends because the
   * stop signal was requested before this call, not because of this call.
   */
  async stop(): Promise<void> {
    this.#stopReason = STOP_REASON;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#active;
  }

  /** One pass over the runnable runs. Public so a test can drive it directly. */
  async poll(): Promise<void> {
    const { config, executor, logger, stopSignal, store } = this.#deps;

    try {
      const candidates = await store.listRunnableRuns({
        limit: config.maxRunsPerPoll,
      });
      this.#failures = 0;

      for (const candidate of candidates) {
        if (this.#stopReason !== undefined || stopSignal.reason !== undefined) {
          break;
        }

        const fields = runLogFields(candidateScope(candidate));
        const attempt = executor.execute(candidate, stopSignal).then(
          (outcome) => {
            logger.info("run.attempt.finished", { ...fields, outcome });
          },
          (error: unknown) => {
            logger.error("run.attempt.crashed", {
              ...fields,
              failure: describeFailure(error).message,
            });
          }
        );
        this.#active = attempt;
        // biome-ignore lint/performance/noAwaitInLoops: one run at a time is the point; the sandbox identity is per build session
        await attempt;
        this.#active = undefined;
      }
    } catch (error) {
      this.#failures += 1;
      logger.error("worker.poll.failed", {
        consecutiveFailures: this.#failures,
        failure: describeFailure(error).message,
      });
    }
  }

  /**
   * Schedules the next poll. The timer is deliberately not unref'd: it is the
   * worker's heartbeat, and a process whose only pending work is the next poll
   * must stay alive to perform it.
   */
  #schedule(delayMs?: number): void {
    if (this.#stopReason !== undefined) {
      return;
    }

    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#tick().catch((error: unknown) => {
        this.#deps.logger.error("worker.poll.crashed", {
          failure: describeFailure(error).message,
        });
      });
    }, delayMs ?? this.#nextDelayMs());
  }

  async #tick(): Promise<void> {
    try {
      await this.poll();
    } finally {
      this.#schedule();
    }
  }

  /** The poll interval with jitter, doubled per consecutive failure to a ceiling. */
  #nextDelayMs(): number {
    const { config } = this.#deps;
    const interval =
      config.pollIntervalMs *
      2 ** Math.min(this.#failures, MAX_BACKOFF_DOUBLINGS);
    return (
      Math.min(interval, MAX_POLL_DELAY_MS) +
      Math.round(Math.random() * config.pollJitterMs)
    );
  }
}
