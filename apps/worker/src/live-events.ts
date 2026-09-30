import {
  type RunLiveEvent,
  runLiveTopic,
} from "@reasonateai/contracts/execution-protocol";
import { DEFAULT_REDIS_KEY_PREFIX } from "@reasonateai/project-state/relay";
import { createClient } from "redis";
import type { Logger } from "./logger.js";

/**
 * Publishes a run's live deltas onto their transport topic.
 *
 * Publishing never blocks the run and never grows without bound. Model text
 * arrives faster than a round trip to Redis completes, so an awaited publish
 * would either stall the agent's stream or accumulate one promise per token;
 * instead the queue is bounded and the oldest deltas are dropped when it is
 * full, because the newest text is what a reader is looking at and the completed
 * message reaches the durable ledger regardless.
 */
export interface LiveEventPublisher {
  /** Writes what is queued, then releases the connection. */
  close: () => Promise<void>;
  /** Queues one frame. Fire-and-forget: the run never waits on the transport. */
  publish: (event: RunLiveEvent) => void;
}

export interface LiveEventPublisherConfig {
  /** How many deltas may wait for the transport before the oldest are dropped. */
  maxQueueLength?: number;
  /** How many deltas one run's topic retains. */
  maxStreamLength?: number;
  /** How long a run's topic is retained after its last delta, in seconds. */
  ttlSeconds?: number;
  url: string;
}

const DEFAULT_MAX_QUEUE_LENGTH = 256;
const DEFAULT_MAX_STREAM_LENGTH = 512;
const DEFAULT_TTL_SECONDS = 60 * 60;

/** One queued frame and the text it will carry once merged. */
interface QueuedDelta {
  event: RunLiveEvent;
  text: string;
}

/**
 * The stream slot one frame belongs to. Frames for the same message merge into
 * one write: a burst of tokens between two writes would otherwise spend a round
 * trip to the transport per token to say three words.
 */
function streamKeyOf(event: RunLiveEvent): string {
  if (event.kind === "message.snapshot") {
    return `${event.runId}:snapshot:${event.snapshot.messageId}`;
  }
  return event.kind === "message.delta"
    ? `message:${event.messageId}`
    : `subagent:${event.toolCallId}`;
}

export function createRedisLiveEventPublisher(
  config: LiveEventPublisherConfig
): LiveEventPublisher {
  const keyPrefix = DEFAULT_REDIS_KEY_PREFIX;
  const maxQueueLength = config.maxQueueLength ?? DEFAULT_MAX_QUEUE_LENGTH;
  const maxStreamLength = config.maxStreamLength ?? DEFAULT_MAX_STREAM_LENGTH;
  const ttlSeconds = config.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const client = createClient({ url: config.url });
  // A transport error rejects the write in flight; the listener only stops an
  // unhandled 'error' event from taking the worker down.
  client.on("error", () => undefined);

  let connecting: Promise<unknown> | undefined;
  let closed = false;
  let draining: Promise<void> | undefined;
  let queued: QueuedDelta[] = [];

  async function connected(): Promise<void> {
    connecting ??= client.connect();
    await connecting;
  }

  /**
   * Merges the queue into one frame per stream, in arrival order: an append
   * extends what is already queued for that message and a replace starts it
   * again, so the merged frame means exactly what the separate frames meant.
   */
  function takeQueue(): QueuedDelta[] {
    const merged = new Map<string, QueuedDelta>();
    for (const entry of queued) {
      const key = streamKeyOf(entry.event);
      const previous = merged.get(key);
      const appending =
        entry.event.kind === "message.delta" &&
        entry.event.mode === "append" &&
        previous !== undefined;
      merged.set(key, {
        event: entry.event,
        text: appending ? previous.text + entry.text : entry.text,
      });
    }
    queued = [];
    return [...merged.values()];
  }

  /** Writes until nothing is queued. Each write is one round trip per stream. */
  async function drain(): Promise<void> {
    await connected();
    while (queued.length > 0) {
      const batch = takeQueue();
      for (const entry of batch) {
        const key = `${keyPrefix}:${runLiveTopic(entry.event.runId)}`;
        // One pipeline for the append and its expiry: a run's topic is
        // transport rather than a record, so it must not outlive the run.
        // biome-ignore lint/performance/noAwaitInLoops: ordered, bounded writes to one topic
        await client
          .multi()
          .xAdd(
            key,
            "*",
            {
              event: JSON.stringify(
                entry.event.kind === "message.snapshot"
                  ? entry.event
                  : { ...entry.event, delta: entry.text }
              ),
            },
            {
              TRIM: {
                strategy: "MAXLEN",
                strategyModifier: "~",
                threshold: maxStreamLength,
              },
            }
          )
          .expire(key, ttlSeconds)
          .exec();
      }
    }
  }

  function pump(): void {
    if (draining !== undefined) {
      return;
    }
    draining = drain()
      .catch(() => undefined)
      .finally(() => {
        draining = undefined;
        if (queued.length > 0 && !closed) {
          pump();
        }
      });
  }

  return {
    close: async () => {
      // Publishing stops here, so the drain below is the last one: whatever the
      // reader is waiting for has already been queued by the run that produced
      // it, and the text of a run that just ended is what it is watching.
      closed = true;
      await draining?.catch(() => undefined);
      if (queued.length > 0) {
        await drain().catch(() => undefined);
      }
      if (client.isOpen) {
        await client.quit();
      }
      queued = [];
    },
    publish: (event) => {
      if (closed) {
        return;
      }
      if (queued.length >= maxQueueLength) {
        queued.shift();
      }
      queued.push({
        event,
        text: event.kind === "message.snapshot" ? "" : event.delta,
      });
      pump();
    },
  };
}

/**
 * The publisher a worker runs with.
 *
 * A worker with no `REDIS_URL` has no transport to publish deltas on, and that
 * is a real reduction rather than a degraded success: the run executes and its
 * durable events still reach the browser through the API's own relay, but the
 * token-level view does not exist. It is reported once, at startup, so an
 * operator sees why a run streams nothing.
 */
export function createLiveEventPublisher(input: {
  logger: Pick<Logger, "warn">;
  redisUrl: string | undefined;
}): LiveEventPublisher {
  if (input.redisUrl === undefined) {
    input.logger.warn("run.live.disabled", {
      reason:
        "REDIS_URL is not configured, so live deltas have no transport and runs will report only their durable events",
    });
    return {
      close: async () => undefined,
      publish: () => undefined,
    };
  }
  return createRedisLiveEventPublisher({ url: input.redisUrl });
}
