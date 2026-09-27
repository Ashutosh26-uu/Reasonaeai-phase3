import { setTimeout as delay } from "node:timers/promises";
import type { ProjectStateStore } from "@reasonateai/project-state/postgres";
import {
  createOutboxRelay,
  createRedisStreamPublisher,
  DEFAULT_REDIS_KEY_PREFIX,
  type OutboxRelay,
  type StreamPublisher,
} from "@reasonateai/project-state/relay";

/**
 * How many committed records one drain asks for. The relay stops at the first
 * publish failure, so a batch is a ceiling on how much work a failed attempt
 * revisits, not a target.
 */
export const OUTBOX_RELAY_BATCH_SIZE = 100;

/** The steady cadence between two drains. */
export const OUTBOX_RELAY_INTERVAL_MS = 1000;

/** The longest a transport failure is allowed to space retries out to. */
export const OUTBOX_RELAY_MAX_INTERVAL_MS = 30_000;

/**
 * How long one drain may take before it is treated as a transport failure. A
 * Redis client that cannot reach its server retries internally without
 * rejecting, so without this bound a drain would neither publish, nor fail, nor
 * log, and the loop would look healthy while doing nothing.
 */
export const OUTBOX_RELAY_DRAIN_TIMEOUT_MS = 10_000;

/** How long closing a publisher may take before it is abandoned. */
export const OUTBOX_RELAY_CLOSE_TIMEOUT_MS = 2000;

/** The identifiers the relay runs with, and nothing that could be a secret. */
export interface OutboxRelayDetails {
  batchSize: number;
  intervalMs: number;
  keyPrefix: string;
}

/**
 * Where the relay reports itself. Every method names counts, intervals, and
 * prefixes: never a payload's contents, a record's identifier, or the address
 * and credentials of the transport.
 */
export interface OutboxRelayLogger {
  failed: (failure: string) => void;
  published: (count: number) => void;
  started: (details: OutboxRelayDetails) => void;
  stopped: () => void;
}

export interface OutboxRelayHandle {
  /**
   * Stops the loop, waits for the drain in flight, and closes the transport.
   * Callable more than once; only the first call does anything.
   */
  stop: () => Promise<void>;
}

const consoleLogger: OutboxRelayLogger = {
  failed: (failure) => {
    console.error(`Outbox relay could not publish: ${failure}`);
  },
  published: (count) => {
    console.info(`Outbox relay published ${count} record(s).`);
  },
  started: ({ batchSize, intervalMs, keyPrefix }) => {
    console.info(
      `Outbox relay started: batch ${batchSize}, interval ${intervalMs}ms, key prefix ${keyPrefix}.`
    );
  },
  stopped: () => {
    console.info("Outbox relay stopped.");
  },
};

const TIMED_OUT = Symbol("outbox-relay-timed-out");

/**
 * Bounds a transport call. The abandoned work keeps running — a Redis client
 * that is retrying an unreachable server has no cancellation — but its result
 * is no longer awaited, and `Promise.race` has already attached a handler to it
 * so a late rejection cannot surface as an unhandled one.
 */
async function bounded<T>(
  work: Promise<T>,
  timeoutMs: number
): Promise<T | typeof TIMED_OUT> {
  const expiry = new AbortController();
  try {
    return await Promise.race([
      work,
      delay(timeoutMs, TIMED_OUT, { signal: expiry.signal }),
    ]);
  } finally {
    expiry.abort();
  }
}

/** Reads a failure without dumping its stack, where a stack would be noise. */
function failureOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

interface Transport {
  publisher: StreamPublisher;
  relay: Pick<OutboxRelay, "drainOnce">;
}

/** The loop that is running in this process, if one is. */
let running: OutboxRelayHandle | undefined;

/**
 * Moves committed outbox records onto the transport for as long as the process
 * lives.
 *
 * PostgreSQL is authoritative: a record is published before it is marked
 * delivered, and a drain that fails leaves its records pending, so nothing is
 * lost and a consumer that sees a record twice deduplicates by its `eventId`.
 *
 * The loop is driven here rather than by the relay's own interval because a
 * transport failure must be logged and retried from, and because the publisher
 * caches its first `connect()` attempt: a publisher whose connection attempt
 * failed can never recover, so a failed drain also builds a fresh one. Each
 * drain is bounded, so an unreachable Redis is a logged retry rather than a
 * silent hang; nothing here throws at the process.
 *
 * Returns undefined when no transport is configured, which is a logged
 * condition rather than a failed start.
 */
export function startOutboxRelay(config: {
  batchSize?: number;
  closeTimeoutMs?: number;
  drainTimeoutMs?: number;
  intervalMs?: number;
  keyPrefix?: string;
  logger?: OutboxRelayLogger;
  maxIntervalMs?: number;
  redisUrl: string | undefined;
  store: Pick<ProjectStateStore, "listPendingOutbox" | "markOutboxPublished">;
}): OutboxRelayHandle | undefined {
  // One loop per process: two would double every drain and open a second
  // connection for no additional delivery, so a second start adopts the first.
  if (running) {
    return running;
  }

  const logger = config.logger ?? consoleLogger;
  const batchSize = config.batchSize ?? OUTBOX_RELAY_BATCH_SIZE;
  const intervalMs = config.intervalMs ?? OUTBOX_RELAY_INTERVAL_MS;
  const maxIntervalMs = config.maxIntervalMs ?? OUTBOX_RELAY_MAX_INTERVAL_MS;
  const drainTimeoutMs = config.drainTimeoutMs ?? OUTBOX_RELAY_DRAIN_TIMEOUT_MS;
  const closeTimeoutMs = config.closeTimeoutMs ?? OUTBOX_RELAY_CLOSE_TIMEOUT_MS;
  const keyPrefix = config.keyPrefix ?? DEFAULT_REDIS_KEY_PREFIX;
  const { store } = config;

  if (!config.redisUrl) {
    logger.failed(
      "REDIS_URL is not set, so committed events cannot be transported."
    );
    return;
  }
  // Read after the guard so the transport factory closes over a `string`
  // rather than a value the compiler has to re-check inside it.
  const { redisUrl } = config;

  let delayMs = intervalMs;
  let inFlight: Promise<void> | undefined;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  function connectTransport(): Transport {
    const publisher = createRedisStreamPublisher({ keyPrefix, url: redisUrl });
    return {
      publisher,
      relay: createOutboxRelay({ batchSize, publisher, store }),
    };
  }

  let transport = connectTransport();

  function schedule(): void {
    if (stopped) {
      return;
    }
    // A relay must not be the reason a process stays alive: the server that
    // hosts it owns the process's lifetime, and it stops this loop on shutdown.
    timer = setTimeout(run, delayMs);
    timer.unref();
  }

  /**
   * Reports a transport failure and retries from a fresh publisher after a
   * backoff, because the failed publisher's connection attempt is cached and
   * can never be retried by that instance.
   *
   * Closing the publisher it replaces is best effort: it is not the failure
   * being reported, and a client that cannot reach its server refuses to say
   * goodbye as readily as it refused to publish.
   */
  async function abandonTransport(failure: string): Promise<void> {
    logger.failed(failure);
    delayMs = Math.min(delayMs * 2, maxIntervalMs);
    const abandoned = transport;
    transport = connectTransport();
    await bounded(abandoned.publisher.close(), closeTimeoutMs).catch(
      () => undefined
    );
  }

  /** Pumps one drain, then schedules the next. Never rejects. */
  function run(): void {
    if (stopped) {
      return;
    }
    const current = transport;
    inFlight = (async () => {
      try {
        const published = await bounded(
          current.relay.drainOnce(),
          drainTimeoutMs
        );
        if (published === TIMED_OUT) {
          await abandonTransport(
            `the transport did not answer within ${drainTimeoutMs}ms.`
          );
          return;
        }
        if (published > 0) {
          logger.published(published);
        }
        delayMs = intervalMs;
      } catch (error) {
        await abandonTransport(failureOf(error));
      } finally {
        inFlight = undefined;
      }
    })().then(schedule, schedule);
  }

  async function stop(): Promise<void> {
    if (stopped) {
      return;
    }
    stopped = true;
    clearTimeout(timer);
    if (inFlight) {
      await bounded(inFlight, drainTimeoutMs);
    }
    // Closed after the wait, so what is closed is whatever transport the loop
    // last built rather than one a drain may have replaced meanwhile. A stop is
    // reported and releases the process guard even when the transport will not
    // close, so a shutdown cannot fail on a broker that is already gone.
    await bounded(transport.publisher.close(), closeTimeoutMs).catch(
      () => undefined
    );
    logger.stopped();
    if (running === handle) {
      running = undefined;
    }
  }

  const handle: OutboxRelayHandle = { stop };
  running = handle;

  logger.started({ batchSize, intervalMs, keyPrefix });
  schedule();

  return handle;
}
