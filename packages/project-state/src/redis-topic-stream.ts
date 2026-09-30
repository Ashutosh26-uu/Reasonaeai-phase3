import { createClient, type RedisClientType } from "redis";
import { DEFAULT_REDIS_KEY_PREFIX } from "./relay.js";

/**
 * A shared reader over one Redis stream topic.
 *
 * Durable run events and live deltas differ in what an entry means and not at
 * all in how it is read, so the connection handling lives here once. Two copies
 * of it would be two places for the shared-consumer, replay-from-the-start, and
 * last-consumer-closes rules to drift apart.
 */
export interface RedisTopicStreamInput<T> {
  /** Validates one retained entry, as `RedisTopicEntryParser` describes. */
  parse: RedisTopicEntryParser<T>;
  /** Identifies this subscription among every consumer in the process. */
  registryKey: string;
  signal?: AbortSignal | undefined;
  /** The topic's name inside the key prefix, e.g. `reasonateai.run.events.<id>`. */
  topicName: string;
}

/**
 * Validates one retained entry and reports the value to deliver.
 *
 * Returning an error fails every consumer of the subscription: a topic names one
 * run, so an entry that does not belong to it — malformed, or carrying another
 * tenant — is a transport fault, and delivering it would hand one organization
 * another's work.
 */
export type RedisTopicEntryParser<T> = (raw: string | undefined) => T | Error;

interface TopicConsumer<T> {
  fail: (error: Error) => void;
  push: (entry: T) => void;
}

interface SharedTopic<T> {
  client: RedisClientType;
  consumers: Set<TopicConsumer<T>>;
  parse: RedisTopicEntryParser<T>;
  ready: Promise<void> | undefined;
  registryKey: string;
  stopped: boolean;
  streamKey: string;
}

const BLOCK_MS = 1000;
const BATCH_SIZE = 200;

/**
 * One subscription per topic key, shared by every caller in this process.
 *
 * Redis holds one connection per subscription, not one per browser: a fan-out
 * route that opened a subscription per client would multiply connections by
 * concurrent readers for no additional isolation, because they all read the
 * same stream.
 */
const topics = new Map<string, SharedTopic<unknown>>();

function openSharedTopic<T>(input: RedisTopicStreamInput<T>): SharedTopic<T> {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error(
      "Redis is required to follow a run's events; REDIS_URL is not set."
    );
  }

  const client = createClient({ name: input.topicName, url });
  // A transport error rejects the read in flight, which fails every consumer of
  // this subscription; the listener only stops an unhandled 'error' event from
  // taking the process down.
  client.on("error", () => undefined);

  const shared: SharedTopic<T> = {
    client,
    consumers: new Set(),
    parse: input.parse,
    ready: undefined,
    registryKey: input.registryKey,
    stopped: false,
    streamKey: `${DEFAULT_REDIS_KEY_PREFIX}:${input.topicName}`,
  };

  topics.set(input.registryKey, shared as SharedTopic<unknown>);
  return shared;
}

function failConsumers<T>(shared: SharedTopic<T>, error: Error): void {
  for (const consumer of [...shared.consumers]) {
    consumer.fail(error);
  }
}

function closeSharedTopic<T>(shared: SharedTopic<T>): void {
  shared.stopped = true;
  topics.delete(shared.registryKey);
  if (shared.client.isOpen) {
    // `destroy` rather than `quit`: the connection may be blocked in `xRead`,
    // and a subscriber must not hold a shutdown open until that block expires.
    shared.client.destroy();
  }
}

function deliver<T>(shared: SharedTopic<T>, raw: string | undefined): void {
  const entry = shared.parse(raw);
  if (entry instanceof Error) {
    failConsumers(shared, entry);
    return;
  }

  for (const consumer of [...shared.consumers]) {
    consumer.push(entry);
  }
}

interface TopicCursor {
  id: string;
}

/** One entry of a topic: the id it took, and what a publisher wrote. */
interface TopicEntry {
  id: string;
  message: { event?: string };
}

/** A topic as one read returned it. */
interface TopicStream {
  messages: TopicEntry[];
}

/**
 * One read of the topic per `next()`, and `done` once the last consumer has
 * left.
 *
 * The pump drives this with `for await`, which keeps exactly one read in
 * flight: a read resumes from the entry the previous one ended on, so a second
 * read racing the cursor would skip ahead of the consumers. A read that comes
 * back empty (`BLOCK` expired with nothing new) is reported as a value rather
 * than as the end, because the topic may carry entries later.
 */
function readTopic<T>(
  shared: SharedTopic<T>,
  cursor: TopicCursor
): AsyncIterable<TopicStream[] | null> {
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<TopicStream[] | null> => ({
      next: async () => {
        if (shared.stopped || shared.consumers.size === 0) {
          return { done: true, value: undefined };
        }

        const reply = await shared.client.xRead(
          [{ id: cursor.id, key: shared.streamKey }],
          { BLOCK: BLOCK_MS, COUNT: BATCH_SIZE }
        );
        return { done: false, value: reply };
      },
    }),
  };
}

/**
 * Reads the topic until the last consumer leaves.
 *
 * Reading from the start of the stream rather than from its newest entry is
 * deliberate: an entry published between a caller's own replay and its
 * subscription would otherwise be delivered to nobody, and the stream is
 * bounded, so re-delivering retained entries is cheaper than a silent gap.
 * Consumers of a durable topic deduplicate by sequence or `eventId`; a live
 * topic is bounded and expires, so replaying it shows a reader the text a
 * message has already produced.
 */
async function pump<T>(shared: SharedTopic<T>): Promise<void> {
  const cursor: TopicCursor = { id: "0" };
  try {
    for await (const reply of readTopic(shared, cursor)) {
      if (!reply) {
        continue;
      }

      for (const stream of reply) {
        for (const entry of stream.messages) {
          cursor.id = entry.id;
          deliver(shared, entry.message.event);
        }
      }
    }
  } catch (error) {
    if (!shared.stopped) {
      failConsumers(
        shared,
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }
}

async function ensureStarted<T>(shared: SharedTopic<T>): Promise<void> {
  shared.ready ??= (async () => {
    await shared.client.connect();
    // Deliberately not awaited: the pump reads until the last consumer leaves,
    // and every caller is waiting on `ready` for the connection alone.
    pump(shared);
  })().catch((error: unknown) => {
    // A failed connect must not poison every later consumer: the next one
    // retries, and each fails closed until the transport is reachable again.
    shared.ready = undefined;
    throw error;
  });

  await shared.ready;
}

function createIterator<T>(
  shared: SharedTopic<T>,
  signal: AbortSignal | undefined
): AsyncIterator<T> {
  const queue: T[] = [];
  let failure: Error | undefined;
  let released = false;
  let wake: (() => void) | undefined;

  const notify = () => {
    const resume = wake;
    wake = undefined;
    resume?.();
  };

  const consumer: TopicConsumer<T> = {
    fail: (error) => {
      failure = error;
      notify();
    },
    push: (entry) => {
      queue.push(entry);
      notify();
    },
  };

  function release() {
    if (released) {
      return;
    }
    released = true;
    shared.consumers.delete(consumer);
    signal?.removeEventListener("abort", onAbort);
    if (shared.consumers.size === 0) {
      closeSharedTopic(shared);
    }
    notify();
  }

  function onAbort() {
    release();
  }

  signal?.addEventListener("abort", onAbort, { once: true });
  shared.consumers.add(consumer);

  /**
   * The state this consumer is in now: a queued entry, the failure that ended
   * the subscription, or the end of the iterator.
   */
  function report(): IteratorResult<T> {
    if (failure) {
      const error = failure;
      release();
      throw error;
    }

    const entry = queue.shift();
    if (entry) {
      return { done: false, value: entry };
    }

    release();
    return { done: true, value: undefined };
  }

  return {
    next: async () => {
      if (released || signal?.aborted) {
        release();
        return { done: true, value: undefined };
      }

      try {
        await ensureStarted(shared);
      } catch (error) {
        release();
        throw error;
      }

      // Nothing to report yet, so wait for the push, failure, or release that
      // `notify` wakes on. Each of those leaves exactly the state `report`
      // reads, and a wake cannot arrive without one of them, so one wait is
      // enough to have something to report.
      if (!(failure || released || queue.length > 0)) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }

      return report();
    },

    return: () => {
      release();
      return Promise.resolve({ done: true, value: undefined });
    },
  };
}

/**
 * Follows one Redis topic.
 *
 * Lazy by design: the returned iterable connects only when its first consumer
 * starts iterating, so a caller that subscribes and then finds nothing to send
 * never opens a connection. Callers in the same process for the same key share
 * one subscription, and aborting the signal (or breaking out of `for await`)
 * closes the iterator and releases the connection once the last consumer has
 * gone. A consumer sees the entries the stream retains from the moment it
 * joins, so a caller that must not miss a transition replays its durable record
 * first and drops what it has already sent.
 */
export function subscribeToRedisTopic<T>(
  input: RedisTopicStreamInput<T>
): Promise<AsyncIterable<T>> {
  const existing = topics.get(input.registryKey);
  const shared =
    existing === undefined
      ? openSharedTopic(input)
      : (existing as SharedTopic<T>);

  // Resolved on the spot: nothing is awaited until the first `next()`, which is
  // what opens the subscription.
  return Promise.resolve({
    [Symbol.asyncIterator]: () => createIterator(shared, input.signal),
  });
}
