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
 * starts at most `maxRunsPerPoll` candidates and holds at most
 * `maxConcurrentRuns` independent projects at a time,
 * the interval is fixed plus jitter so two workers do not synchronize their
 * reads, and consecutive database failures back off with a doubling delay up to
 * a ceiling instead of hammering a database that is already refusing.
 *
 * One run per project is deliberate: the sandbox
 * identity is derived from organization, project, and build session, so two
 * concurrent runs of one build session would contend for one container name and
 * one workspace volume. Each run has its own controller; a suspended question
 * retains its own lease without blocking discovery for another project.
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
  readonly #active = new Map<string, Promise<void>>();
  readonly #deps: RunWorkerDeps;
  #failures = 0;
  #stopReason: string | undefined;
  #timer: NodeJS.Timeout | undefined;
  #polling: Promise<void> | undefined;

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
    await this.#polling;
    await Promise.all(this.#active.values());
  }

  /** One pass over the runnable runs. Public so a test can drive it directly. */
  async poll(): Promise<void> {
    if (this.#polling !== undefined) {
      return await this.#polling;
    }
    const polling = this.#discover();
    this.#polling = polling;
    try {
      await polling;
    } finally {
      this.#polling = undefined;
    }
  }

  async #discover(): Promise<void> {
    const { config, executor, logger, stopSignal, store } = this.#deps;
    const slots = config.maxConcurrentRuns - this.#active.size;
    if (slots <= 0 || this.stopping || stopSignal.reason !== undefined) {
      return;
    }

    try {
      const candidates = await store.listRunnableRuns({
        limit: Math.min(config.maxRunsPerPoll, slots),
      });
      this.#failures = 0;

      for (const candidate of candidates) {
        if (this.#stopReason !== undefined || stopSignal.reason !== undefined) {
          break;
        }

        const fields = runLogFields(candidateScope(candidate));
        const projectKey = `${candidate.organizationId}:${candidate.projectId}`;
        if (this.#active.has(projectKey)) {
          continue;
        }
        logger.info("run.attempt.started", {
          ...fields,
          activeRuns: this.#active.size + 1,
          maxConcurrentRuns: config.maxConcurrentRuns,
        });
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
        const tracked = attempt.finally(() => {
          this.#active.delete(projectKey);
        });
        this.#active.set(projectKey, tracked);
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
