import { randomUUID } from "node:crypto";
import { SESSION_COOKIE } from "@reasonateai/contracts/auth";
import {
  type RunEventEnvelope,
  type RunLiveEvent,
  RunLiveEventSchema,
  runEventTopic,
  runLiveTopic,
} from "@reasonateai/contracts/execution-protocol";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
  type RunId,
  SessionIdSchema,
  UserIdSchema,
} from "@reasonateai/contracts/identity";
import {
  createProjectStateStore,
  type ProjectStateStore,
} from "@reasonateai/project-state/postgres";
import {
  createRedisStreamPublisher,
  DEFAULT_REDIS_KEY_PREFIX,
  type StreamPublisher,
} from "@reasonateai/project-state/relay";
import { subscribeToRunEvents } from "@reasonateai/project-state/run-event-stream";
import { Pool } from "pg";
import { createClient, type RedisClientType } from "redis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveSessionPrincipal } from "../src/mastra/principal";
import type { HandlerContext } from "../src/mastra/routes/build-sessions";
import {
  createRunEventHandlers,
  formatServerSentEvent,
  RUN_EVENTS_HEARTBEAT_MS,
} from "../src/mastra/routes/run-events";
import {
  createRunEventFanout,
  type RunEventStreamFactory,
  type RunLiveStreamFactory,
} from "../src/mastra/run-event-fanout";

const connectionString = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;
const describeWithTransport =
  connectionString && redisUrl ? describe : describe.skip;

const HOUR = 1000 * 60 * 60;
const LEDGER_SCAN_LIMIT = 1000;

interface StubRequest {
  cookie?: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  query?: Record<string, string>;
  signal?: AbortSignal;
}

function context(input: StubRequest): HandlerContext {
  return {
    json: (body, status) => new Response(JSON.stringify(body), { status }),
    req: {
      header: (name) => {
        const key = name.toLowerCase();
        if (key === "cookie") {
          return input.cookie;
        }
        return input.headers?.[key];
      },
      json: async () => undefined,
      param: (name) => input.params?.[name],
      query: (name) => input.query?.[name],
      raw: { signal: input.signal },
    },
  };
}

interface Frame {
  data: Record<string, unknown>;
  event: string;
  /**
   * The ledger sequence a durable frame carries, or null for a live frame. An
   * `id` is what a reconnecting browser sends back as `Last-Event-ID`, so only
   * the durable record may have one.
   */
  id: number | null;
}

interface EventStream {
  cancel: () => Promise<void>;
  /** The next durable frame. Live frames it passes are not consumed twice. */
  nextData: () => Promise<Frame>;
  /** The next live frame. */
  nextLive: () => Promise<Frame>;
}

/**
 * Reads frames from an event stream, awaiting real frames rather than guessed
 * durations. A test that hangs fails on the runner's own timeout.
 */
function openStream(response: Response): EventStream {
  const { body } = response;
  if (!body) {
    throw new Error("Expected a streaming body.");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const deferred: Frame[] = [];
  let buffered = "";

  async function readRaw(): Promise<string> {
    for (;;) {
      const boundary = buffered.indexOf("\n\n");
      if (boundary !== -1) {
        const raw = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        if (raw.length > 0) {
          return raw;
        }
        continue;
      }

      // Reading is inherently sequential: each read consumes the next chunk.
      // biome-ignore lint/performance/noAwaitInLoops: stream reads cannot overlap
      const chunk = await reader.read();
      if (chunk.done) {
        throw new Error("The stream ended before the expected frame arrived.");
      }
      buffered += decoder.decode(chunk.value, { stream: true });
    }
  }

  async function readFrame(): Promise<Frame> {
    const raw = await readRaw();
    const lines = raw.split("\n");
    const idLine = lines.find((line) => line.startsWith("id: "));
    const eventLine = lines.find((line) => line.startsWith("event: "));
    const dataLine = lines.find((line) => line.startsWith("data: "));

    if (!(eventLine && dataLine)) {
      return await readFrame();
    }

    return {
      data: JSON.parse(dataLine.slice("data: ".length)),
      event: eventLine.slice("event: ".length),
      id: idLine ? Number(idLine.slice("id: ".length)) : null,
    };
  }

  /**
   * The next frame of one kind. A frame of the other kind is kept, so a test
   * that reads durable frames and then live ones — or the reverse — sees every
   * frame the server wrote, in the order it wrote them.
   */
  async function next(idRequired: boolean): Promise<Frame> {
    const held = deferred.findIndex((frame) =>
      idRequired ? frame.id !== null : frame.id === null
    );
    if (held !== -1) {
      return deferred.splice(held, 1)[0] as Frame;
    }

    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: frames arrive one at a time
      const frame = await readFrame();
      if ((frame.id !== null) === idRequired) {
        return frame;
      }
      deferred.push(frame);
    }
  }

  return {
    cancel: async () => await reader.cancel(),
    nextData: async () => await next(true),
    nextLive: async () => await next(false),
  };
}

/**
 * A push-driven stand-in for a run's event topics.
 *
 * Tests publish exactly the sequences they mean to, so live delivery is
 * asserted without sleeps and without a broker, and the count of opened and
 * released transport subscriptions is observable.
 */
function createTopicHarness() {
  interface TopicState<T> {
    buffer: T[];
    closed: boolean;
    failure?: Error;
    wake: (() => void) | undefined;
  }

  const live = new Map<string, TopicState<RunEventEnvelope>>();
  const queued = new Map<string, RunEventEnvelope[]>();
  const liveFrames = new Map<string, TopicState<RunLiveEvent>>();
  const queuedFrames = new Map<string, RunLiveEvent[]>();
  const opens = new Map<string, number>();
  const liveOpens = new Map<string, number>();
  const releases = new Map<string, number>();
  const liveReleases = new Map<string, number>();

  /** Publishes an event to a run's topic, as the outbox relay would. */
  function publish(runId: string, event: RunEventEnvelope): void {
    const state = live.get(runId);
    if (state) {
      state.buffer.push(event);
      state.wake?.();
      return;
    }
    // Published before any follower subscribed. The next subscription picks it
    // up so a test does not depend on when the route subscribes.
    const buffered = queued.get(runId);
    if (buffered) {
      buffered.push(event);
      return;
    }
    queued.set(runId, [event]);
  }

  /** Publishes a live frame to a run's topic, as the worker's publisher does. */
  function publishLive(runId: string, frame: RunLiveEvent): void {
    const state = liveFrames.get(runId);
    if (state) {
      state.buffer.push(frame);
      state.wake?.();
      return;
    }
    const buffered = queuedFrames.get(runId);
    if (buffered) {
      buffered.push(frame);
      return;
    }
    queuedFrames.set(runId, [frame]);
  }

  /**
   * One subscription over a queue, aborted with the signal it was opened with.
   * The durable and live topics differ only in what they carry, so both are
   * driven by the same reader.
   */
  function subscribeTo<T>(
    input: { runId: string; signal?: AbortSignal },
    registry: Map<string, TopicState<T>>,
    pending: Map<string, T[]>,
    counters: { opens: Map<string, number>; releases: Map<string, number> }
  ): Promise<AsyncIterable<T>> {
    const state: TopicState<T> = {
      buffer: pending.get(input.runId) ?? [],
      closed: false,
      wake: undefined,
    };
    pending.delete(input.runId);
    registry.set(input.runId, state);
    counters.opens.set(input.runId, (counters.opens.get(input.runId) ?? 0) + 1);

    input.signal?.addEventListener(
      "abort",
      () => {
        state.closed = true;
        state.wake?.();
        counters.releases.set(
          input.runId,
          (counters.releases.get(input.runId) ?? 0) + 1
        );
        if (registry.get(input.runId) === state) {
          registry.delete(input.runId);
        }
      },
      { once: true }
    );

    return Promise.resolve({
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (state.failure) {
            throw state.failure;
          }
          const next = state.buffer.shift();
          if (next) {
            yield next;
            continue;
          }
          if (state.closed) {
            return;
          }
          // biome-ignore lint/performance/noAwaitInLoops: the queue hands over one published entry at a time
          await new Promise<void>((resolve) => {
            state.wake = resolve;
          });
          state.wake = undefined;
        }
      },
    });
  }

  const subscribe: RunEventStreamFactory = (input) =>
    subscribeTo(input, live, queued, { opens, releases });

  const subscribeLive: RunLiveStreamFactory = (input) =>
    subscribeTo(input, liveFrames, queuedFrames, {
      opens: liveOpens,
      releases: liveReleases,
    });

  return {
    fail: (runId: string, channel: "durable" | "live") => {
      const state =
        channel === "durable" ? live.get(runId) : liveFrames.get(runId);
      if (!state) {
        throw new Error("Expected an open transport subscription.");
      }
      state.failure = new Error("Transport disconnected");
      state.wake?.();
    },
    /** How many live subscriptions a run opened. */
    liveOpens: (runId: string) => liveOpens.get(runId) ?? 0,
    /** How many live subscriptions a run released. */
    liveReleases: (runId: string) => liveReleases.get(runId) ?? 0,
    /** How many transport subscriptions a run opened. */
    opens: (runId: string) => opens.get(runId) ?? 0,
    publish,
    publishLive,
    /** How many transport subscriptions a run released. */
    releases: (runId: string) => releases.get(runId) ?? 0,
    subscribe,
    subscribeLive,
  };
}

describeWithDatabase("run event stream", () => {
  const pool = new Pool({ connectionString });
  const store: ProjectStateStore = createProjectStateStore({
    connectionString: connectionString as string,
  });

  const organizationId = OrganizationIdSchema.parse(randomUUID());
  const projectId = ProjectIdSchema.parse(randomUUID());
  const userId = UserIdSchema.parse(randomUUID());
  const userSessionId = SessionIdSchema.parse(randomUUID());
  const scope = { organizationId, projectId };

  const topics = createTopicHarness();

  let cookie: string;

  const handlers = createRunEventHandlers({
    fanout: createRunEventFanout({
      subscribe: topics.subscribe,
      subscribeLive: topics.subscribeLive,
    }),
    resolvePrincipal: async ({ cookieHeader }) =>
      await resolveSessionPrincipal({
        cookieHeader,
        sessions: store.sessions,
      }),
    store: () => store,
  });

  async function allocate() {
    const allocation = await store.allocateBuildSession({
      idempotencyKey: `events-${randomUUID()}`,
      scope,
      userSessionId,
    });
    return allocation.buildSession;
  }

  function streamRequest(input: {
    buildSessionId: string;
    cookie?: string;
    lastEventId?: string;
    query?: Record<string, string>;
    signal?: AbortSignal;
  }) {
    return context({
      cookie: input.cookie ?? cookie,
      headers: input.lastEventId
        ? { "last-event-id": input.lastEventId }
        : undefined,
      params: { buildSessionId: input.buildSessionId },
      query: input.query ?? { organizationId, projectId },
      signal: input.signal,
    });
  }

  /** The run's last committed sequence, so a stream's replay can be drained. */
  async function ledgerHead(runId: RunId): Promise<number> {
    const events = await store.listRunEvents({
      afterSequence: 0,
      limit: LEDGER_SCAN_LIMIT,
      runId,
      scope,
    });
    return events.at(-1)?.sequence ?? 0;
  }

  /**
   * Yields one macrotask turn. A stream writes its last replayed frame from a
   * microtask and registers with the fan-out immediately after, so this lets
   * every stream that finished replaying subscribe before the test publishes.
   */
  async function settle(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  /** Commits an event and publishes it, as the outbox relay would. */
  async function publishNext(runId: RunId, step: string) {
    const event = await store.appendRunEvent({
      payload: { step },
      runId,
      scope,
      type: "agent.progress",
    });
    topics.publish(runId, event);
    return event;
  }

  /** Consumes replayed frames up to the run's head, leaving the stream live. */
  async function drainReplay(stream: EventStream, head: number): Promise<void> {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: frames arrive one at a time
      const frame = await stream.nextData();
      if (frame.id === head) {
        return;
      }
    }
  }

  beforeAll(async () => {
    await store.migrate();
    await pool.query(
      `insert into organizations (organization_id, name) values ($1, 'Events test')
       on conflict do nothing`,
      [organizationId]
    );
    await pool.query(
      `insert into projects (project_id, organization_id, name)
       values ($1, $2, 'Events project') on conflict do nothing`,
      [projectId, organizationId]
    );
    await pool.query(
      "insert into users (user_id) values ($1) on conflict do nothing",
      [userId]
    );
    await store.memberships.grantOrganizationMembership({
      organizationId,
      role: "builder",
      status: "active",
      userId,
    });
    await store.memberships.grantProjectMembership({
      organizationId,
      projectId,
      role: "builder",
      status: "active",
      userId,
    });

    const issued = await store.sessions.createSession({
      absoluteTtlMs: 24 * HOUR,
      idleTtlMs: HOUR,
      userId,
    });
    cookie = `${SESSION_COOKIE}=${issued.token}`;
  });

  afterAll(async () => {
    await pool.query("delete from organizations where organization_id = $1", [
      organizationId,
    ]);
    await pool.query("delete from users where user_id = $1", [userId]);
    await pool.end();
    await store.close();
  });

  it("serializes a frame whose id is the ledger sequence a client resumes from", () => {
    const frame = formatServerSentEvent({
      eventId: randomUUID() as never,
      occurredAt: new Date().toISOString(),
      organizationId,
      payload: { step: "x" },
      projectId,
      runId: randomUUID() as never,
      schemaVersion: 1,
      sequence: 7,
      type: "agent.progress",
    });

    expect(frame).toContain("id: 7");
    expect(frame).toContain("event: agent.progress");
    expect(frame.endsWith("\n\n")).toBe(true);
  });

  it("refuses an unauthenticated follower and a foreign tenant", async () => {
    const buildSession = await allocate();

    const anon = await handlers.stream(
      streamRequest({ buildSessionId: buildSession.buildSessionId, cookie: "" })
    );
    expect(anon.status).toBe(401);

    const foreign = await handlers.stream(
      streamRequest({
        buildSessionId: buildSession.buildSessionId,
        query: { organizationId: randomUUID(), projectId: randomUUID() },
      })
    );
    expect(foreign.status).toBe(403);
  });

  it("reports an unknown build session as not found", async () => {
    const response = await handlers.stream(
      streamRequest({ buildSessionId: randomUUID() })
    );

    expect(response.status).toBe(404);
  });

  it("fails closed when the scope is incomplete", async () => {
    const buildSession = await allocate();

    const response = await handlers.stream(
      streamRequest({
        buildSessionId: buildSession.buildSessionId,
        query: { organizationId },
      })
    );

    expect(response.status).toBe(400);
  });

  it("replays the whole ledger for a fresh client, in order", async () => {
    const buildSession = await allocate();
    await store.appendRunEvent({
      payload: { step: "second" },
      runId: buildSession.runId,
      scope,
      type: "agent.progress",
    });

    const response = await handlers.stream(
      streamRequest({ buildSessionId: buildSession.buildSessionId })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const stream = openStream(response);
    try {
      const first = await stream.nextData();
      const second = await stream.nextData();

      expect(first.id).toBe(1);
      expect(first.event).toBe("run.queued");
      expect(second.id).toBe(2);
      expect(second.event).toBe("agent.progress");
    } finally {
      await stream.cancel();
    }
  });

  it("flushes headers and keeps quiet streams alive without advancing the replay cursor", async () => {
    const buildSession = await allocate();
    const head = await ledgerHead(buildSession.runId);
    const response = await handlers.stream(
      streamRequest({
        buildSessionId: buildSession.buildSessionId,
        lastEventId: String(head),
      })
    );
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Expected a streaming body");
    }
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(
        ": connected\n\n"
      );
      await settle();
      // Install fake timers before opening a second stream, so its actual
      // heartbeat interval is controlled while database setup remains real.
      vi.useFakeTimers();
      const secondResponse = await handlers.stream(
        streamRequest({
          buildSessionId: buildSession.buildSessionId,
          lastEventId: String(head),
        })
      );
      const second = secondResponse.body?.getReader();
      if (!second) {
        throw new Error("Expected a streaming body");
      }
      try {
        await second.read();
        await vi.advanceTimersByTimeAsync(RUN_EVENTS_HEARTBEAT_MS);
        expect(new TextDecoder().decode((await second.read()).value)).toBe(
          ": keepalive\n\n"
        );
        await second.cancel();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        await second.cancel();
        vi.useRealTimers();
      }
      const progress = await publishNext(buildSession.runId, "after idle");
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(
        `id: ${progress.sequence}\n`
      );
    } finally {
      vi.useRealTimers();
      await reader.cancel();
    }
  });

  it.each(["durable", "live"] as const)(
    "closes failed %s followers and replays missed events on reconnect",
    async (channel) => {
      const buildSession = await allocate();
      const head = await ledgerHead(buildSession.runId);
      const streams = await Promise.all(
        [0, 1].map(async () => {
          const response = await handlers.stream(
            streamRequest({
              buildSessionId: buildSession.buildSessionId,
              lastEventId: String(head),
            })
          );
          const reader = response.body?.getReader();
          if (!reader) {
            throw new Error("Expected a streaming body");
          }
          await reader.read();
          return reader;
        })
      );
      await settle();
      const acknowledged = await publishNext(
        buildSession.runId,
        "before disconnect"
      );
      for (const reader of streams) {
        // biome-ignore lint/performance/noAwaitInLoops: wait until every follower has delivered
        expect(new TextDecoder().decode((await reader.read()).value)).toContain(
          `id: ${acknowledged.sequence}\n`
        );
      }
      await settle();
      topics.fail(buildSession.runId, channel);
      for (const reader of streams) {
        // biome-ignore lint/performance/noAwaitInLoops: each follower must terminate
        expect((await reader.read()).done).toBe(true);
      }
      expect(topics.releases(buildSession.runId)).toBe(1);
      expect(topics.liveReleases(buildSession.runId)).toBe(1);
      await store.appendRunEvent({
        payload: { step: "missed" },
        runId: buildSession.runId,
        scope,
        type: "agent.progress",
      });
      const resumed = openStream(
        await handlers.stream(
          streamRequest({
            buildSessionId: buildSession.buildSessionId,
            lastEventId: String(acknowledged.sequence),
          })
        )
      );
      try {
        expect((await resumed.nextData()).data.payload).toEqual({
          step: "missed",
        });
        await settle();
        const progress = await publishNext(buildSession.runId, "recovered");
        expect((await resumed.nextData()).id).toBe(progress.sequence);
        expect(topics.opens(buildSession.runId)).toBe(2);
      } finally {
        await resumed.cancel();
      }
    }
  );

  it("resumes strictly after the cursor a reconnecting client sends", async () => {
    const buildSession = await allocate();

    // Appended one at a time because this test depends on how many events
    // exist, and concurrent appends would race on the run's sequence.
    await store.appendRunEvent({
      payload: { step: "a" },
      runId: buildSession.runId,
      scope,
      type: "agent.progress",
    });
    await store.appendRunEvent({
      payload: { step: "b" },
      runId: buildSession.runId,
      scope,
      type: "agent.progress",
    });
    await store.appendRunEvent({
      payload: { step: "c" },
      runId: buildSession.runId,
      scope,
      type: "agent.progress",
    });

    const response = await handlers.stream(
      streamRequest({
        buildSessionId: buildSession.buildSessionId,
        lastEventId: "3",
      })
    );

    const stream = openStream(response);
    try {
      const frame = await stream.nextData();
      expect(frame.id).toBe(4);
      expect(frame.data.sequence).toBe(4);
    } finally {
      await stream.cancel();
    }
  });

  it("delivers events published while the client is connected", async () => {
    const buildSession = await allocate();
    const head = await ledgerHead(buildSession.runId);

    const response = await handlers.stream(
      streamRequest({ buildSessionId: buildSession.buildSessionId })
    );

    const stream = openStream(response);
    try {
      await drainReplay(stream, head);
      await settle();

      const live = await publishNext(buildSession.runId, "live");
      const frame = await stream.nextData();

      expect(frame.data.payload).toEqual({ step: "live" });
      expect(frame.event).toBe("agent.progress");
      expect(frame.id).toBe(live.sequence);
    } finally {
      await stream.cancel();
    }
  });

  it("serves concurrent streams of one run from a single transport subscription", async () => {
    const buildSession = await allocate();
    const { runId } = buildSession;
    const head = await ledgerHead(runId);
    const openedBefore = topics.opens(runId);

    const first = openStream(
      await handlers.stream(
        streamRequest({ buildSessionId: buildSession.buildSessionId })
      )
    );
    const second = openStream(
      await handlers.stream(
        streamRequest({ buildSessionId: buildSession.buildSessionId })
      )
    );

    try {
      await drainReplay(first, head);
      await drainReplay(second, head);
      await settle();

      const live = await publishNext(runId, "shared");

      expect((await first.nextData()).id).toBe(live.sequence);
      expect((await second.nextData()).id).toBe(live.sequence);
      expect(topics.opens(runId) - openedBefore).toBe(1);
    } finally {
      await first.cancel();
      await second.cancel();
    }
  });

  it("backfills a sequence the transport dropped without repeating one", async () => {
    const buildSession = await allocate();
    const { runId } = buildSession;
    const head = await ledgerHead(runId);

    const response = await handlers.stream(
      streamRequest({ buildSessionId: buildSession.buildSessionId })
    );

    const stream = openStream(response);
    try {
      await drainReplay(stream, head);

      // The transport loses the first event: only the second is published, so
      // live delivery starts on a sequence the listener has not seen.
      const dropped = await store.appendRunEvent({
        payload: { step: "dropped" },
        runId,
        scope,
        type: "agent.progress",
      });
      const delivered = await publishNext(runId, "delivered");

      const backfilled = await stream.nextData();
      const next = await stream.nextData();
      expect(backfilled.id).toBe(dropped.sequence);
      expect(backfilled.data.payload).toEqual({ step: "dropped" });
      expect(next.id).toBe(delivered.sequence);
      expect(next.data.payload).toEqual({ step: "delivered" });

      // An at-least-once redelivery of a sequence already written is dropped,
      // so the stream stays gapless and duplicate-free.
      topics.publish(runId, delivered);
      const after = await publishNext(runId, "after");

      const frame = await stream.nextData();
      expect(frame.id).toBe(after.sequence);
      expect(frame.data.payload).toEqual({ step: "after" });
    } finally {
      await stream.cancel();
    }
  });

  it("delivers live text to every stream of a run without touching the ledger", async () => {
    const buildSession = await allocate();
    const { runId } = buildSession;
    const head = await ledgerHead(runId);
    const liveOpensBefore = topics.liveOpens(runId);

    const first = openStream(
      await handlers.stream(
        streamRequest({ buildSessionId: buildSession.buildSessionId })
      )
    );
    const second = openStream(
      await handlers.stream(
        streamRequest({ buildSessionId: buildSession.buildSessionId })
      )
    );

    try {
      await drainReplay(first, head);
      await drainReplay(second, head);
      await settle();

      topics.publishLive(
        runId,
        RunLiveEventSchema.parse({
          delta: "Reading ",
          kind: "message.delta",
          messageId: "m-1",
          mode: "append",
          organizationId,
          projectId,
          runId,
          schemaVersion: 1,
        })
      );

      const firstFrame = await first.nextLive();
      const secondFrame = await second.nextLive();

      expect(firstFrame.event).toBe("message.delta");
      expect(firstFrame.data.delta).toBe("Reading ");
      // No `id` line: a delta has no ledger position, and a browser that
      // replayed one as `Last-Event-ID` would skip every durable event between
      // its last sequence and a number the ledger never issued.
      expect(firstFrame.id).toBeNull();
      expect(secondFrame.data.delta).toBe("Reading ");
      expect(topics.liveOpens(runId) - liveOpensBefore).toBe(1);
    } finally {
      await first.cancel();
      await second.cancel();
    }
  });

  it("keeps a live frame out of the run's durable ledger", async () => {
    const buildSession = await allocate();
    const { runId } = buildSession;
    const head = await ledgerHead(runId);
    const stream = openStream(
      await handlers.stream(
        streamRequest({ buildSessionId: buildSession.buildSessionId })
      )
    );

    try {
      await drainReplay(stream, head);
      await settle();
      topics.publishLive(
        runId,
        RunLiveEventSchema.parse({
          delta: "partial text",
          kind: "message.delta",
          messageId: "m-2",
          mode: "append",
          organizationId,
          projectId,
          runId,
          schemaVersion: 1,
        })
      );
      expect((await stream.nextLive()).data.delta).toBe("partial text");

      // A durable event published afterwards is still the only thing the
      // ledger holds, so the live view never becomes the record.
      const next = await publishNext(runId, "after live");
      expect((await stream.nextData()).id).toBe(next.sequence);
      expect(await ledgerHead(runId)).toBe(next.sequence);
    } finally {
      await stream.cancel();
    }
  });

  it("releases a run's live subscription with its last listener", async () => {
    const buildSession = await allocate();
    const { runId } = buildSession;
    const head = await ledgerHead(runId);
    const liveReleasesBefore = topics.liveReleases(runId);

    const first = openStream(
      await handlers.stream(
        streamRequest({ buildSessionId: buildSession.buildSessionId })
      )
    );
    const second = openStream(
      await handlers.stream(
        streamRequest({ buildSessionId: buildSession.buildSessionId })
      )
    );

    try {
      await drainReplay(first, head);
      await drainReplay(second, head);
      await settle();

      await second.cancel();
      expect(topics.liveReleases(runId)).toBe(liveReleasesBefore);

      await first.cancel();
      expect(topics.liveReleases(runId)).toBe(liveReleasesBefore + 1);
    } finally {
      await first.cancel();
      await second.cancel();
    }
  });

  it("releases the transport subscription when the last listener leaves", async () => {
    const buildSession = await allocate();
    const { runId } = buildSession;
    const head = await ledgerHead(runId);
    const releasedBefore = topics.releases(runId);

    const aborted = new AbortController();
    const first = openStream(
      await handlers.stream(
        streamRequest({
          buildSessionId: buildSession.buildSessionId,
          signal: aborted.signal,
        })
      )
    );
    const second = openStream(
      await handlers.stream(
        streamRequest({ buildSessionId: buildSession.buildSessionId })
      )
    );

    try {
      await drainReplay(first, head);
      await drainReplay(second, head);
      await settle();
      await publishNext(runId, "both");

      expect((await first.nextData()).data.payload).toEqual({ step: "both" });
      expect((await second.nextData()).data.payload).toEqual({ step: "both" });

      // An aborted request releases its own listener but not the run's topic.
      aborted.abort();
      expect(topics.releases(runId)).toBe(releasedBefore);

      await second.cancel();
      expect(topics.releases(runId)).toBe(releasedBefore + 1);
    } finally {
      await first.cancel();
      await second.cancel();
    }
  });

  /**
   * The live transport, exercised end to end. Skips cleanly when Redis is not
   * configured, so the suite above stays the one that always runs.
   */
  describeWithTransport("over the run topic", () => {
    let opens = 0;
    let publisher: StreamPublisher;
    let liveClient: RedisClientType;

    const transportHandlers = createRunEventHandlers({
      fanout: createRunEventFanout({
        subscribe: async (input) => {
          opens += 1;
          return await subscribeToRunEvents(input);
        },
      }),
      resolvePrincipal: async ({ cookieHeader }) =>
        await resolveSessionPrincipal({
          cookieHeader,
          sessions: store.sessions,
        }),
      store: () => store,
    });

    beforeAll(async () => {
      publisher = createRedisStreamPublisher({ url: redisUrl as string });
      liveClient = createClient({ url: redisUrl as string });
      await liveClient.connect();
    });

    afterAll(async () => {
      await publisher.close();
      await liveClient.quit();
    });

    it("follows a published event to concurrent streams over one subscription", async () => {
      const buildSession = await allocate();
      const { runId } = buildSession;
      const head = await ledgerHead(runId);

      const first = openStream(
        await transportHandlers.stream(
          streamRequest({ buildSessionId: buildSession.buildSessionId })
        )
      );
      const second = openStream(
        await transportHandlers.stream(
          streamRequest({ buildSessionId: buildSession.buildSessionId })
        )
      );

      try {
        await drainReplay(first, head);
        await drainReplay(second, head);
        await settle();

        const live = await store.appendRunEvent({
          payload: { step: "transport" },
          runId,
          scope,
          type: "agent.progress",
        });
        // The same publisher and topic the outbox relay publishes through.
        await publisher.publish(runEventTopic(runId), live);

        expect((await first.nextData()).id).toBe(live.sequence);
        expect((await second.nextData()).id).toBe(live.sequence);
        expect(opens).toBe(1);
      } finally {
        await first.cancel();
        await second.cancel();
      }
    }, 20_000);

    it("follows a live delta published by the worker to the browser over Redis", async () => {
      const buildSession = await allocate();
      const { runId } = buildSession;
      const head = await ledgerHead(runId);

      const stream = openStream(
        await transportHandlers.stream(
          streamRequest({ buildSessionId: buildSession.buildSessionId })
        )
      );

      try {
        await drainReplay(stream, head);
        await settle();

        const frame = RunLiveEventSchema.parse({
          delta: "Checking checkout",
          kind: "message.delta",
          messageId: "m-transport",
          mode: "append",
          organizationId,
          projectId,
          runId,
          schemaVersion: 1,
        });
        // The same key and shape the worker's publisher writes.
        await liveClient.xAdd(
          `${DEFAULT_REDIS_KEY_PREFIX}:${runLiveTopic(runId)}`,
          "*",
          { event: JSON.stringify(frame) }
        );

        const delivered = await stream.nextLive();
        expect(delivered.event).toBe("message.delta");
        expect(delivered.data.delta).toBe("Checking checkout");
        expect(delivered.id).toBeNull();
      } finally {
        await stream.cancel();
        await liveClient.del(
          `${DEFAULT_REDIS_KEY_PREFIX}:${runLiveTopic(runId)}`
        );
      }
    }, 20_000);

    /**
     * The live channel through the factories the process actually uses. The
     * suites above inject their transport so they can publish exact sequences;
     * this one leaves both subscriptions on their own defaults, which is what
     * catches a live topic that no default subscription ever reads.
     */
    it("reads live deltas through the route's own default subscriptions", async () => {
      const buildSession = await allocate();
      const { runId } = buildSession;
      const head = await ledgerHead(runId);

      const defaultHandlers = createRunEventHandlers({
        resolvePrincipal: async ({ cookieHeader }) =>
          await resolveSessionPrincipal({
            cookieHeader,
            sessions: store.sessions,
          }),
        store: () => store,
      });

      const stream = openStream(
        await defaultHandlers.stream(
          streamRequest({ buildSessionId: buildSession.buildSessionId })
        )
      );

      try {
        await drainReplay(stream, head);
        await settle();

        await liveClient.xAdd(
          `${DEFAULT_REDIS_KEY_PREFIX}:${runLiveTopic(runId)}`,
          "*",
          {
            event: JSON.stringify({
              delta: "default subscription",
              kind: "message.delta",
              messageId: "m-default",
              mode: "append",
              organizationId,
              projectId,
              runId,
              schemaVersion: 1,
            }),
          }
        );

        const delivered = await stream.nextLive();
        expect(delivered.data.delta).toBe("default subscription");
        expect(delivered.id).toBeNull();
      } finally {
        await stream.cancel();
        await liveClient.del(
          `${DEFAULT_REDIS_KEY_PREFIX}:${runLiveTopic(runId)}`
        );
      }
    }, 20_000);
  });
});
