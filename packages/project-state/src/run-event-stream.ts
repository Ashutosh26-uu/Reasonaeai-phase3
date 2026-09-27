import {
  type RunEventEnvelope,
  RunEventEnvelopeSchema,
  runEventTopic,
} from "@reasonateai/contracts/execution-protocol";
import { createClient, type RedisClientType } from "redis";
import { DEFAULT_REDIS_KEY_PREFIX } from "./relay.js";

export interface RunEventStreamInput {
  buildSessionId: string;
  organizationId: string;
  projectId: string;
  runId: string;
  signal?: AbortSignal;
}

const BLOCK_MS = 1000;
const BATCH_SIZE = 200;

interface RunEventConsumer {
  fail: (error: Error) => void;
  push: (event: RunEventEnvelope) => void;
}

interface SharedRunEventStream {
  client: RedisClientType;
  consumers: Set<RunEventConsumer>;
  ready: Promise<void> | undefined;
  registryKey: string;
  scope: RunEventStreamInput;
  stopped: boolean;
  streamKey: string;
}

/**
 * One subscription per run scope, shared by every caller in this process.
 *
 * Redis holds one connection per subscription, not one per browser: a fan-out
 * route that opened a subscription per client would multiply connections by
 * concurrent readers for no additional isolation, because they all read the
 * same stream.
 */
const streams = new Map<string, SharedRunEventStream>();

function openSharedStream(
  registryKey: string,
  input: RunEventStreamInput
): SharedRunEventStream {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error(
      "Redis is required to follow run events; REDIS_URL is not set."
    );
  }

  const client = createClient({ url });
  // A transport error rejects the read in flight, which fails every consumer of
  // this subscription; the listener only stops an unhandled 'error' event from
  // taking the process down.
  client.on("error", () => undefined);

  const shared: SharedRunEventStream = {
    client,
    consumers: new Set(),
    ready: undefined,
    registryKey,
    scope: input,
    stopped: false,
    streamKey: `${DEFAULT_REDIS_KEY_PREFIX}:${runEventTopic(input.runId)}`,
  };

  streams.set(registryKey, shared);
  return shared;
}

function failConsumers(shared: SharedRunEventStream, error: Error): void {
  for (const consumer of [...shared.consumers]) {
    consumer.fail(error);
  }
}

function closeSharedStream(shared: SharedRunEventStream): void {
  shared.stopped = true;
  streams.delete(shared.registryKey);
  if (shared.client.isOpen) {
    // `destroy` rather than `quit`: the connection may be blocked in `xRead`,
    // and a subscriber must not hold a shutdown open until that block expires.
    shared.client.destroy();
  }
}

function deliver(shared: SharedRunEventStream, raw: string | undefined): void {
  let payload: unknown;
  try {
    payload =
      typeof raw === "string" ? (JSON.parse(raw) as unknown) : undefined;
  } catch {
    payload = undefined;
  }

  const parsed = RunEventEnvelopeSchema.safeParse(payload);
  if (!parsed.success) {
    failConsumers(
      shared,
      new Error(
        "A run event on the transport did not match the run-event contract."
      )
    );
    return;
  }

  const event = parsed.data;
  const { scope } = shared;
  // The topic names one run, so a mismatch means the transport carried an event
  // for a different tenant. Failing the subscription is the only safe answer:
  // delivering it would hand one organization another's events.
  if (
    event.organizationId !== scope.organizationId ||
    event.projectId !== scope.projectId ||
    event.runId !== scope.runId
  ) {
    failConsumers(
      shared,
      new Error(
        "A run event arrived for a different tenant scope than the subscription."
      )
    );
    return;
  }

  for (const consumer of [...shared.consumers]) {
    consumer.push(event);
  }
}

interface RunEventCursor {
  id: string;
}

/** One entry of a run's topic: the id it took, and what the relay published. */
interface TopicEntry {
  id: string;
  message: { event?: string };
}

/** A run's topic as one read returned it. */
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
function readTopic(
  shared: SharedRunEventStream,
  cursor: RunEventCursor
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
 * Reads the run's topic until the last consumer leaves.
 *
 * Reading from the start of the stream rather than from its newest entry is
 * deliberate: an event committed between a caller's ledger replay and its
 * subscription would otherwise be delivered to nobody, and the stream is
 * bounded, so re-delivering retained entries is cheaper than a silent gap.
 * Consumers deduplicate by `eventId`, the same convention the relay documents.
 */
async function pump(shared: SharedRunEventStream): Promise<void> {
  const cursor: RunEventCursor = { id: "0" };
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

async function ensureStarted(shared: SharedRunEventStream): Promise<void> {
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

function createIterator(
  shared: SharedRunEventStream,
  signal: AbortSignal | undefined
): AsyncIterator<RunEventEnvelope> {
  const queue: RunEventEnvelope[] = [];
  let failure: Error | undefined;
  let released = false;
  let wake: (() => void) | undefined;

  const notify = () => {
    const resume = wake;
    wake = undefined;
    resume?.();
  };

  const consumer: RunEventConsumer = {
    fail: (error) => {
      failure = error;
      notify();
    },
    push: (event) => {
      queue.push(event);
      notify();
    },
  };

  function onAbort() {
    release();
  }

  function release() {
    if (released) {
      return;
    }
    released = true;
    shared.consumers.delete(consumer);
    signal?.removeEventListener("abort", onAbort);
    if (shared.consumers.size === 0) {
      closeSharedStream(shared);
    }
    notify();
  }

  signal?.addEventListener("abort", onAbort, { once: true });
  shared.consumers.add(consumer);

  /**
   * The state this consumer is in now: a queued event, the failure that ended
   * the subscription, or the end of the iterator.
   */
  function report(): IteratorResult<RunEventEnvelope> {
    if (failure) {
      const error = failure;
      release();
      throw error;
    }

    const event = queue.shift();
    if (event) {
      return { done: false, value: event };
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
 * Follows a run's live events.
 *
 * Lazy by design: the returned iterable connects only when its first consumer
 * starts iterating, so a caller that subscribes and then finds nothing to send
 * never opens a connection. Callers in the same process for the same run share
 * one subscription, and aborting the signal (or breaking out of `for await`)
 * closes the iterator and releases the connection once the last consumer has
 * gone. A consumer sees the entries the stream retains from the moment it
 * joins, so a caller that must not miss a transition replays the durable ledger
 * first and drops events it has already sent.
 */
export function subscribeToRunEvents(
  input: RunEventStreamInput
): Promise<AsyncIterable<RunEventEnvelope>> {
  const registryKey = [
    input.organizationId,
    input.projectId,
    input.buildSessionId,
    input.runId,
  ].join("|");
  const shared =
    streams.get(registryKey) ?? openSharedStream(registryKey, input);

  // Resolved on the spot: nothing is awaited until the first `next()`, which is
  // what opens the subscription.
  return Promise.resolve({
    [Symbol.asyncIterator]: () => createIterator(shared, input.signal),
  });
}
