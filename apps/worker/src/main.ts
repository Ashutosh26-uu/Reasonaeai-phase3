import {
  createProjectStateStore,
  type ProjectStateStore,
} from "@reasonateai/project-state/postgres";
import { createGitCheckpointStore } from "@reasonateai/sandbox/checkpoint";
import { readWorkerConfig, type WorkerConfig } from "./config.js";
import { RunExecutor } from "./executor.js";
import { describeFailure } from "./failure.js";
import { createLedger } from "./ledger.js";
import {
  createLiveEventPublisher,
  type LiveEventPublisher,
} from "./live-events.js";
import { createLogger, type Logger } from "./logger.js";
import { createCtoRuntimeFactory } from "./runtime.js";
import { createStopSignal, type StopSignal } from "./stop-signal.js";
import { settleWithin } from "./wait.js";
import { RunWorker } from "./worker.js";
import { resolveBuildSandbox } from "./workspace.js";

/**
 * The execution plane's entry point.
 *
 * The composition is the same one the API's chat harness performs — the build
 * workspace, the sandbox facts, the checkpoint store, the CTO runtime — with
 * the harness replaced by the poll loop, the terminal by the run ledger, and
 * the lease replaced by the run's own lease. The worker does not apply
 * migrations: schema changes are a separately observable deployment step, and a
 * worker that raced the API's migration on start would be doing deployment work
 * with execution credentials.
 */

/**
 * SIGINT and SIGTERM end the process in a defined order: stop accepting work,
 * end the run in flight so no run is left `running` without a lease, close the
 * pool, exit. The grace window is what makes the process exitable — a step that
 * refuses to settle is abandoned rather than waited on forever.
 */
function installShutdown(input: {
  config: WorkerConfig;
  live: LiveEventPublisher;
  logger: Logger;
  stopSignal: StopSignal;
  store: ProjectStateStore;
  worker: RunWorker;
}): void {
  let requested = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (requested) {
      return;
    }
    requested = true;
    input.logger.info("worker.shutdown.requested", { signal });
    input.stopSignal.request(`the worker received ${signal}`);

    const settled = await settleWithin(
      input.worker.stop(),
      input.config.shutdownGraceMs
    );
    if (!settled) {
      input.logger.error("worker.shutdown.timeout", {
        graceMs: input.config.shutdownGraceMs,
        reason:
          "the run in flight did not finish before the grace window closed",
      });
    }

    try {
      // After the run has settled, so the deltas it produced are the ones
      // written rather than abandoned with the queue.
      await input.live.close();
    } catch (error) {
      input.logger.error("worker.shutdown.live.failed", {
        failure: describeFailure(error).message,
      });
    }

    try {
      await input.store.close();
    } catch (error) {
      input.logger.error("worker.shutdown.close.failed", {
        failure: describeFailure(error).message,
      });
    }

    input.logger.info("worker.stopped", { settled });
    if (!settled) {
      process.exit(1);
    }
  };

  const onSignal = (signal: string): void => {
    shutdown(signal).catch((error: unknown) => {
      input.logger.error("worker.shutdown.failed", {
        failure: describeFailure(error).message,
      });
      process.exit(1);
    });
  };

  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));
}

/**
 * Startup failures are ordinary: a missing `DATABASE_URL` or an incoherent
 * interval must stop the process with a message naming the field, not with a
 * stack an operator has to read to find the field name.
 */
function main(): void {
  const config = readWorkerConfig();
  const logger = createLogger({ level: config.logLevel });
  const store = createProjectStateStore({
    connectionString: config.databaseUrl,
    ...(config.redisUrl === undefined ? {} : { redisUrl: config.redisUrl }),
  });
  const stopSignal = createStopSignal();
  const live = createLiveEventPublisher({
    logger,
    redisUrl: config.redisUrl,
  });
  const executor = new RunExecutor({
    checkpoints: createGitCheckpointStore({ root: config.checkpointRoot }),
    config: {
      holder: config.holder,
      leaseTtlMs: config.leaseTtlMs,
      renewIntervalMs: config.renewIntervalMs,
      stopGraceMs: config.stopGraceMs,
      suspensionTimeoutMs: config.suspensionTimeoutMs,
    },
    ledger: createLedger({ store }),
    live,
    logger,
    resolveSandbox: async ({ requestContext }) =>
      await resolveBuildSandbox({ requestContext }),
    runtime: createCtoRuntimeFactory({
      databaseUrl: config.databaseUrl,
      model: config.model,
      store,
    }),
    store,
  });
  const worker = new RunWorker({ config, executor, logger, stopSignal, store });

  installShutdown({ config, live, logger, stopSignal, store, worker });

  logger.info("worker.started", {
    checkpointRoot: config.checkpointRoot,
    holder: config.holder,
    leaseTtlMs: config.leaseTtlMs,
    maxConcurrentRuns: config.maxConcurrentRuns,
    maxRunsPerPoll: config.maxRunsPerPoll,
    model: config.model,
    pollIntervalMs: config.pollIntervalMs,
    pollJitterMs: config.pollJitterMs,
    renewIntervalMs: config.renewIntervalMs,
    suspensionTimeoutMs: config.suspensionTimeoutMs,
  });
  worker.start();
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `The worker could not start: ${describeFailure(error).message}\n`
  );
  process.exit(1);
}
