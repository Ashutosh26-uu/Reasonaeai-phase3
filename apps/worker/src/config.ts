import { randomBytes } from "node:crypto";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/**
 * The execution plane's configuration.
 *
 * Every interval is bounded in both directions, because each one is a loop
 * bound: a poll interval decides how often the worker reads PostgreSQL, a
 * renewal interval decides how much of the lease's remaining time is left to
 * recover, and a grace window decides how long a shutdown may hold the process
 * open. A configuration that cannot hold the lease it takes is refused at
 * startup rather than discovered as a run that stopped renewing.
 */

/** Three renewals must fit inside one lease, so a renewal failure is recoverable. */
const REQUIRED_RENEWALS_PER_TTL = 3;

const MIN_LEASE_TTL_MS = 1000;
const MAX_LEASE_TTL_MS = 3_600_000;
const MIN_RENEW_INTERVAL_MS = 100;
const MAX_RENEW_INTERVAL_MS = 600_000;
const MIN_POLL_INTERVAL_MS = 200;
const MAX_POLL_INTERVAL_MS = 300_000;
const MAX_POLL_JITTER_MS = 60_000;
const MAX_RUNS_PER_POLL = 32;
const MIN_SHUTDOWN_GRACE_MS = 1000;
const MAX_SHUTDOWN_GRACE_MS = 300_000;
const MIN_STOP_GRACE_MS = 100;
const MAX_STOP_GRACE_MS = 120_000;

const DEFAULT_LEASE_TTL_MS = 60_000;
const DEFAULT_RENEW_INTERVAL_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_POLL_JITTER_MS = 250;
const DEFAULT_MAX_RUNS_PER_POLL = 1;
const DEFAULT_SHUTDOWN_GRACE_MS = 30_000;
const DEFAULT_STOP_GRACE_MS = 5000;

/**
 * The model the CTO runs on. Pinned the same way the API's composition root
 * pins it: the moving alias resolves to the latest V4 Flash model.
 */
const DEFAULT_MODEL = "deepseek/deepseek-flash";

export type WorkerLogLevel = "debug" | "error" | "info" | "warn";

export interface WorkerConfig {
  /** Host directory holding every tenant's Git checkpoint bundles. */
  checkpointRoot: string;
  /** PostgreSQL that owns commands, leases, and the event ledger. */
  databaseUrl: string;
  /**
   * How this process identifies itself in `run_leases.holder`. It is stable for
   * the life of the process: a re-claim by the same holder is refused by the
   * store, so a worker must renew rather than re-begin the run it holds.
   */
  holder: string;
  leaseTtlMs: number;
  logLevel: WorkerLogLevel;
  maxRunsPerPoll: number;
  model: string;
  pollIntervalMs: number;
  pollJitterMs: number;
  /** Redis used for the store's rate-limit counters; omitted leaves the default. */
  redisUrl: string | undefined;
  renewIntervalMs: number;
  shutdownGraceMs: number;
  /** How long an aborted step may take to settle before teardown proceeds. */
  stopGraceMs: number;
}

const WorkerEnvironmentSchema = z.object({
  DATABASE_URL: z.string().min(1),
  MASTRA_MODEL: z.string().trim().min(1).optional(),
  REASONATE_CHECKPOINT_ROOT: z.string().trim().min(1).optional(),
  REDIS_URL: z.string().min(1).optional(),
  WORKER_HOLDER: z.string().trim().min(1).max(128).optional(),
  WORKER_LEASE_TTL_MS: z.coerce
    .number()
    .int()
    .min(MIN_LEASE_TTL_MS)
    .max(MAX_LEASE_TTL_MS)
    .optional(),
  WORKER_LOG_LEVEL: z.enum(["debug", "error", "info", "warn"]).optional(),
  WORKER_MAX_RUNS_PER_POLL: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_RUNS_PER_POLL)
    .optional(),
  WORKER_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(MIN_POLL_INTERVAL_MS)
    .max(MAX_POLL_INTERVAL_MS)
    .optional(),
  WORKER_POLL_JITTER_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(MAX_POLL_JITTER_MS)
    .optional(),
  WORKER_RENEW_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(MIN_RENEW_INTERVAL_MS)
    .max(MAX_RENEW_INTERVAL_MS)
    .optional(),
  WORKER_SHUTDOWN_GRACE_MS: z.coerce
    .number()
    .int()
    .min(MIN_SHUTDOWN_GRACE_MS)
    .max(MAX_SHUTDOWN_GRACE_MS)
    .optional(),
  WORKER_STOP_GRACE_MS: z.coerce
    .number()
    .int()
    .min(MIN_STOP_GRACE_MS)
    .max(MAX_STOP_GRACE_MS)
    .optional(),
});

/**
 * The holder identity of a worker that was given none. Hostname, pid, and a
 * random suffix together distinguish two processes on one host and two hosts
 * with a recycled pid.
 */
function generatedHolder(): string {
  return [
    "worker",
    hostname(),
    String(process.pid),
    randomBytes(4).toString("hex"),
  ]
    .join("-")
    .slice(0, 128);
}

/** Configuration problems are reported by field, never by value. */
function describeConfigurationError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
    .join("; ");
}

export function readWorkerConfig(
  env: NodeJS.ProcessEnv = process.env
): WorkerConfig {
  const parsed = WorkerEnvironmentSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `The worker configuration is invalid: ${describeConfigurationError(parsed.error)}`
    );
  }

  const settings = parsed.data;
  const leaseTtlMs = settings.WORKER_LEASE_TTL_MS ?? DEFAULT_LEASE_TTL_MS;
  const renewIntervalMs =
    settings.WORKER_RENEW_INTERVAL_MS ?? DEFAULT_RENEW_INTERVAL_MS;
  if (renewIntervalMs * REQUIRED_RENEWALS_PER_TTL > leaseTtlMs) {
    throw new Error(
      `WORKER_RENEW_INTERVAL_MS must leave room for ${REQUIRED_RENEWALS_PER_TTL} renewals inside WORKER_LEASE_TTL_MS (${renewIntervalMs}ms x ${REQUIRED_RENEWALS_PER_TTL} > ${leaseTtlMs}ms).`
    );
  }

  const shutdownGraceMs =
    settings.WORKER_SHUTDOWN_GRACE_MS ?? DEFAULT_SHUTDOWN_GRACE_MS;
  const stopGraceMs = settings.WORKER_STOP_GRACE_MS ?? DEFAULT_STOP_GRACE_MS;
  if (stopGraceMs > shutdownGraceMs) {
    throw new Error(
      `WORKER_STOP_GRACE_MS (${stopGraceMs}ms) must not exceed WORKER_SHUTDOWN_GRACE_MS (${shutdownGraceMs}ms).`
    );
  }

  return {
    checkpointRoot:
      settings.REASONATE_CHECKPOINT_ROOT ??
      join(homedir(), ".reasonateai", "checkpoints"),
    databaseUrl: settings.DATABASE_URL,
    holder: settings.WORKER_HOLDER ?? generatedHolder(),
    leaseTtlMs,
    logLevel: settings.WORKER_LOG_LEVEL ?? "info",
    maxRunsPerPoll:
      settings.WORKER_MAX_RUNS_PER_POLL ?? DEFAULT_MAX_RUNS_PER_POLL,
    model: settings.MASTRA_MODEL ?? DEFAULT_MODEL,
    pollIntervalMs:
      settings.WORKER_POLL_INTERVAL_MS ?? DEFAULT_POLL_INTERVAL_MS,
    pollJitterMs: settings.WORKER_POLL_JITTER_MS ?? DEFAULT_POLL_JITTER_MS,
    redisUrl: settings.REDIS_URL,
    renewIntervalMs,
    shutdownGraceMs,
    stopGraceMs,
  };
}
