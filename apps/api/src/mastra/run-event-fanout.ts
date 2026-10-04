import type {
  RunEventEnvelope,
  RunLiveEvent,
} from "@reasonateai/contracts/execution-protocol";
import { subscribeToRunEvents } from "@reasonateai/project-state/run-event-stream";
import { subscribeToRunLiveEvents } from "@reasonateai/project-state/run-live-stream";

/**
 * The transport call that reads one run's event topic. Kept structural so the
 * fan-out can be driven without a live broker.
 */
export type RunEventStreamFactory = (
  input: RunEventStreamInput
) => Promise<AsyncIterable<RunEventEnvelope>>;

/**
 * The transport call that reads one run's live topic. Separate from the durable
 * factory because the two topics carry different things and a caller may have
 * one without the other: a fan-out driven by a test can supply events only.
 */
export type RunLiveStreamFactory = (
  input: RunEventStreamInput
) => Promise<AsyncIterable<RunLiveEvent>>;

export interface RunEventStreamInput {
  buildSessionId: string;
  organizationId: string;
  projectId: string;
  runId: string;
  signal?: AbortSignal;
}

export interface RunEventSubscriptionInput {
  buildSessionId: string;
  /**
   * The last sequence this listener has already delivered. Live delivery
   * resumes after it, so a listener that attaches mid-run is never handed an
   * event it has already written.
   */
  lastDelivered: number;
  listener: (event: RunEventEnvelope) => void;
  /** Close the follower so it reconnects and replays the authoritative ledger. */
  onDisconnect: (
    reason: "durable_transport" | "live_transport" | "shutdown"
  ) => void;
  /**
   * Called with the first sequence the listener is missing when the topic
   * cannot bridge from `lastDelivered` to the event that just arrived. Backfill
   * belongs to the caller: the durable ledger, not the transport, is the
   * authority for what a listener attached too late to receive.
   */
  onGap: (fromSequence: number) => void;
  /**
   * Receives the run's live deltas, in the order the transport carried them.
   * A listener that omits it is not subscribed to the live topic at all, so a
   * caller with no use for partial text never opens that subscription.
   */
  onLive?: (event: RunLiveEvent) => void;
  organizationId: string;
  projectId: string;
  runId: string;
}

export interface RunEventSubscription {
  close: () => void;
}

export interface RunEventFanout {
  /** Releases every open topic. */
  close: () => void;
  subscribe: (input: RunEventSubscriptionInput) => RunEventSubscription;
}

interface TopicListener {
  closed: boolean;
  lastDelivered: number;
  listener: (event: RunEventEnvelope) => void;
  onDisconnect: RunEventSubscriptionInput["onDisconnect"];
  onGap: (fromSequence: number) => void;
  onLive?: (event: RunLiveEvent) => void;
}

interface Topic {
  abort: AbortController;
  listeners: Set<TopicListener>;
  live: AbortController;
  livePumping: boolean;
}

/**
 * Fans one run's transport topics out to every listener in this process.
 *
 * The transport subscriptions are per-run resources, not per-connection ones:
 * the first listener for a run opens them and the last one to leave closes
 * them, so N followers of one run cost one subscription per topic. Delivery is
 * push, so a follower never polls the ledger to discover new work.
 */
export function createRunEventFanout(
  config: {
    subscribe?: RunEventStreamFactory;
    subscribeLive?: RunLiveStreamFactory;
  } = {}
): RunEventFanout {
  const openStream = config.subscribe ?? subscribeToRunEvents;
  const openLiveStream = config.subscribeLive ?? subscribeToRunLiveEvents;
  const topics = new Map<string, Topic>();

  function disconnect(
    runId: string,
    topic: Topic,
    reason: Parameters<RunEventSubscriptionInput["onDisconnect"]>[0]
  ): void {
    if (topics.get(runId) === topic) {
      topics.delete(runId);
    }
    topic.abort.abort();
    topic.live.abort();
    const listeners = [...topic.listeners];
    topic.listeners.clear();
    for (const entry of listeners) {
      entry.closed = true;
      entry.onDisconnect(reason);
    }
  }

  /** Hands one event to every listener, skipping what each already has. */
  function deliver(topic: Topic, event: RunEventEnvelope): void {
    for (const entry of topic.listeners) {
      if (entry.closed || event.sequence <= entry.lastDelivered) {
        // At-least-once delivery republishes records, so a sequence a listener
        // has already seen is not news.
        continue;
      }
      const missingFrom = entry.lastDelivered + 1;
      entry.lastDelivered = event.sequence;
      if (event.sequence > missingFrom) {
        // The listener attached after the missing events flowed, so the topic
        // cannot hand them over: the caller backfills them from the ledger.
        entry.onGap(missingFrom);
      }
      entry.listener(event);
    }
  }

  /** Hands one live frame to every listener that asked for them. */
  function deliverLive(topic: Topic, event: RunLiveEvent): void {
    for (const entry of topic.listeners) {
      if (!entry.closed) {
        entry.onLive?.(event);
      }
    }
  }

  async function pump(
    runId: string,
    topic: Topic,
    input: RunEventSubscriptionInput
  ): Promise<void> {
    try {
      const stream = await openStream({
        buildSessionId: input.buildSessionId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        runId,
        signal: topic.abort.signal,
      });
      for await (const event of stream) {
        if (topic.abort.signal.aborted) {
          break;
        }
        deliver(topic, event);
      }
    } catch {
      // Disconnect followers; an open but silent socket cannot recover itself.
    } finally {
      if (!topic.abort.signal.aborted) {
        disconnect(runId, topic, "durable_transport");
      }
    }
  }

  async function pumpLive(
    runId: string,
    topic: Topic,
    input: RunEventSubscriptionInput
  ): Promise<void> {
    try {
      const stream = await openLiveStream({
        buildSessionId: input.buildSessionId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        runId,
        signal: topic.live.signal,
      });
      for await (const event of stream) {
        if (topic.live.signal.aborted) {
          break;
        }
        deliverLive(topic, event);
      }
    } catch {
      // The browser reconnects both topics and retains its visible partial text.
    } finally {
      topic.livePumping = false;
      if (!topic.live.signal.aborted) {
        disconnect(runId, topic, "live_transport");
      }
    }
  }

  return {
    close: () => {
      for (const [runId, topic] of topics) {
        disconnect(runId, topic, "shutdown");
      }
      topics.clear();
    },

    subscribe: (input) => {
      let topic = topics.get(input.runId);
      if (!topic) {
        topic = {
          abort: new AbortController(),
          listeners: new Set(),
          live: new AbortController(),
          livePumping: false,
        };
        topics.set(input.runId, topic);
        // The pump contains its own failures, so nothing awaits it.
        pump(input.runId, topic, input).catch(() => undefined);
      }

      const entry: TopicListener = {
        closed: false,
        lastDelivered: input.lastDelivered,
        listener: input.listener,
        onDisconnect: input.onDisconnect,
        onGap: input.onGap,
        onLive: input.onLive,
      };
      topic.listeners.add(entry);

      if (entry.onLive !== undefined && !topic.livePumping) {
        topic.livePumping = true;
        pumpLive(input.runId, topic, input).catch(() => undefined);
      }

      return {
        close: () => {
          if (entry.closed) {
            return;
          }
          entry.closed = true;
          topic.listeners.delete(entry);
          if (topic.listeners.size === 0) {
            // The last listener leaving is what releases the transport slots.
            if (topics.get(input.runId) === topic) {
              topics.delete(input.runId);
            }
            topic.abort.abort();
            topic.live.abort();
          }
        },
      };
    },
  };
}

let shared: RunEventFanout | undefined;

/**
 * The process-wide fan-out. Every route instance shares it, which is what makes
 * concurrent followers of one run share a single transport subscription.
 */
export function runEventFanout(): RunEventFanout {
  shared ??= createRunEventFanout();
  return shared;
}
