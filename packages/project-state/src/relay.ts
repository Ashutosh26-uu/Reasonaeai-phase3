import type { RunEventEnvelope } from "@reasonateai/contracts/execution-protocol";
import { createClient } from "redis";
import type { OutboxRecord, ProjectStateStore } from "./postgres.js";

/**
 * Publishes a durable event envelope onto its transport topic.
 *
 * The transport is deliberately replaceable: PostgreSQL keeps the authoritative
 * ledger and outbox, so a different broker can be substituted without changing
 * how work or user-visible state is recorded.
 */
export interface StreamPublisher {
  close: () => Promise<void>;
  publish: (topic: string, payload: RunEventEnvelope) => Promise<void>;
}

/**
 * Namespace for every Redis key this package owns. A deployment that shares a
 * Redis instance with something else changes it once, here.
 */
export const DEFAULT_REDIS_KEY_PREFIX = "reasonateai";

export function createRedisStreamPublisher(config: {
  maxStreamLength?: number;
  keyPrefix?: string;
  url: string;
}): StreamPublisher {
  const keyPrefix = config.keyPrefix ?? DEFAULT_REDIS_KEY_PREFIX;
  const maxStreamLength = config.maxStreamLength ?? 10_000;
  const client = createClient({ url: config.url });
  // A transport error rejects the publish in flight; the listener only stops an
  // unhandled 'error' event from taking the process down.
  client.on("error", () => undefined);
  let connecting: Promise<unknown> | undefined;

  async function connected(): Promise<unknown> {
    connecting ??= client.connect();
    return await connecting;
  }

  const keyFor = (topic: string): string => `${keyPrefix}:${topic}`;

  return {
    close: async () => {
      if (client.isOpen) {
        await client.quit();
      }
    },

    publish: async (topic, payload) => {
      await connected();
      // MAXLEN ~ keeps memory bounded without making trimming exact.
      await client.xAdd(
        keyFor(topic),
        "*",
        { event: JSON.stringify(payload) },
        {
          TRIM: {
            strategy: "MAXLEN",
            strategyModifier: "~",
            threshold: maxStreamLength,
          },
        }
      );
    },
  };
}

export interface OutboxRelay {
  /** Publishes one batch. Returns how many records were published and marked. */
  drainOnce: () => Promise<number>;
  start: (intervalMs: number) => void;
  stop: () => void;
}

/**
 * Moves committed outbox records onto the transport.
 *
 * Delivery is at-least-once by construction: a crash between publishing and
 * marking republishes the record, so consumers deduplicate by `eventId`. The
 * batch stops at the first publish failure so later records are not reordered
 * ahead of an unpublished one, and nothing is marked before it is published.
 */
export function createOutboxRelay(config: {
  batchSize: number;
  publisher: Pick<StreamPublisher, "publish">;
  store: Pick<ProjectStateStore, "listPendingOutbox" | "markOutboxPublished">;
}): OutboxRelay {
  let timer: NodeJS.Timeout | undefined;
  let draining = false;

  async function drainOnce(): Promise<number> {
    const records: OutboxRecord[] = await config.store.listPendingOutbox(
      config.batchSize
    );

    const publishedIds: number[] = [];
    for (const record of records) {
      try {
        // Publishing sequentially preserves arrival order within a run's topic,
        // which consumers rely on; parallel publishing could reorder events.
        // biome-ignore lint/performance/noAwaitInLoops: ordered delivery is required
        await config.publisher.publish(record.topic, record.payload);
      } catch (error) {
        if (publishedIds.length > 0) {
          await config.store.markOutboxPublished(publishedIds);
        }
        throw error;
      }
      publishedIds.push(Number(record.outboxId));
    }

    await config.store.markOutboxPublished(publishedIds);
    return publishedIds.length;
  }

  return {
    drainOnce,

    start: (intervalMs) => {
      if (timer) {
        return;
      }
      timer = setInterval(() => {
        if (draining) {
          return;
        }
        draining = true;
        drainOnce()
          .catch(() => undefined)
          .finally(() => {
            draining = false;
          });
      }, intervalMs);
    },

    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
