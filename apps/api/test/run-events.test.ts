import { randomUUID } from "node:crypto";
import {
  type RunEventEnvelope,
  runEventTopic,
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
  type StreamPublisher,
} from "@reasonateai/project-state/relay";
import { subscribeToRunEvents } from "@reasonateai/project-state/run-event-stream";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveSessionPrincipal } from "../src/mastra/principal";
import type { HandlerContext } from "../src/mastra/routes/build-sessions";
import {
  createRunEventHandlers,
  formatServerSentEvent,
} from "../src/mastra/routes/run-events";
import {
  createRunEventFanout,
  type RunEventStreamFactory,
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
  id: number;
}

interface EventStream {
  cancel: () => Promise<void>;
  nextData: () => Promise<Frame>;
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

  /**
   * Awaits the next data frame. Recursion rather than a loop keeps the return
   * type exact and avoids awaiting inside a loop; a frame missing any of the
   * three fields is not one this test can use, and the server always writes all
   * three.
   */
  async function nextData(): Promise<Frame> {
    const raw = await readRaw();
    const lines = raw.split("\n");
    const idLine = lines.find((line) => line.startsWith("id: "));
    const eventLine = lines.find((line) => line.startsWith("event: "));
    const dataLine = lines.find((line) => line.startsWith("data: "));

    if (!(idLine && eventLine && dataLine)) {
      return await nextData();
    }

    return {
      data: JSON.parse(dataLine.slice("data: ".length)),
      event: eventLine.slice("event: ".length),
      id: Number(idLine.slice("id: ".length)),
    };
  }

  return {
    cancel: async () => await reader.cancel(),
    nextData,
  };
}

/**
 * A push-driven stand-in for a run's event topic.
 *
 * Tests publish exactly the sequences they mean to, so live delivery is
 * asserted without sleeps and without a broker, and the count of opened and
 * released transport subscriptions is observable.
 */
function createTopicHarness() {
  interface TopicState {
    buffer: RunEventEnvelope[];
    closed: boolean;
    wake: (() => void) | undefined;
  }

  const live = new Map<string, TopicState>();
  const queued = new Map<string, RunEventEnvelope[]>();
  const opens = new Map<string, number>();
  const releases = new Map<string, number>();

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

  const subscribe: RunEventStreamFactory = ({ runId, signal }) => {
    const state: TopicState = {
      buffer: queued.get(runId) ?? [],
      closed: false,
      wake: undefined,
    };
    queued.delete(runId);
    live.set(runId, state);
    opens.set(runId, (opens.get(runId) ?? 0) + 1);

    signal?.addEventListener(
      "abort",
      () => {
        state.closed = true;
        state.wake?.();
        releases.set(runId, (releases.get(runId) ?? 0) + 1);
        if (live.get(runId) === state) {
          live.delete(runId);
        }
      },
      { once: true }
    );

    return Promise.resolve({
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const next = state.buffer.shift();
          if (next) {
            yield next;
            continue;
          }
          if (state.closed) {
            return;
          }
          // biome-ignore lint/performance/noAwaitInLoops: the queue hands over one published event at a time
          await new Promise<void>((resolve) => {
            state.wake = resolve;
          });
          state.wake = undefined;
        }
      },
    });
  };

  return {
    /** How many transport subscriptions a run opened. */
    opens: (runId: string) => opens.get(runId) ?? 0,
    publish,
    /** How many transport subscriptions a run released. */
    releases: (runId: string) => releases.get(runId) ?? 0,
    subscribe,
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
    fanout: createRunEventFanout({ subscribe: topics.subscribe }),
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
    cookie = `reasonate_session=${issued.token}`;
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

    beforeAll(() => {
      publisher = createRedisStreamPublisher({ url: redisUrl as string });
    });

    afterAll(async () => {
      await publisher.close();
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
  });
});
