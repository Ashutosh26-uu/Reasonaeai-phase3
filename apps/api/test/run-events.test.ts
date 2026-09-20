import { randomUUID } from "node:crypto";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
  SessionIdSchema,
  UserIdSchema,
} from "@reasonateai/contracts/identity";
import {
  createProjectStateStore,
  type ProjectStateStore,
} from "@reasonateai/project-state/postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveSessionPrincipal } from "../src/mastra/principal";
import type { HandlerContext } from "../src/mastra/routes/build-sessions";
import {
  createRunEventHandlers,
  formatServerSentEvent,
} from "../src/mastra/routes/run-events";

const connectionString = process.env.DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

const HOUR = 1000 * 60 * 60;

interface StubRequest {
  cookie?: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  query?: Record<string, string>;
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
    },
  };
}

interface Frame {
  data: Record<string, unknown>;
  event: string;
  id: number;
}

/**
 * Reads frames from an event stream, awaiting real frames rather than guessed
 * durations. A test that hangs fails on the runner's own timeout.
 */
function openStream(response: Response) {
  const { body } = response;
  if (!body) {
    throw new Error("Expected a streaming body.");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  async function readRaw(): Promise<string | "heartbeat"> {
    for (;;) {
      const boundary = buffered.indexOf("\n\n");
      if (boundary !== -1) {
        const raw = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        if (raw.startsWith(":")) {
          return "heartbeat";
        }
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
   * Awaits the next data frame, discarding heartbeats. Recursion rather than a
   * loop keeps the return type exact and avoids awaiting inside a loop; the
   * depth is bounded by how many idle ticks elapse, which is small.
   */
  async function nextData(): Promise<Frame> {
    const raw = await readRaw();
    if (raw === "heartbeat") {
      return await nextData();
    }

    const lines = raw.split("\n");
    const idLine = lines.find((line) => line.startsWith("id: "));
    const eventLine = lines.find((line) => line.startsWith("event: "));
    const dataLine = lines.find((line) => line.startsWith("data: "));

    // A frame missing any field is not a frame this test can use; the server
    // always writes all three.
    if (!(idLine && eventLine && dataLine)) {
      return await nextData();
    }

    return {
      data: JSON.parse(dataLine.slice("data: ".length)),
      event: eventLine.slice("event: ".length),
      id: Number(idLine.slice("id: ".length)),
    };
  }

  /**
   * Awaits a heartbeat, discarding data frames. A heartbeat is only written
   * while the follow loop is idle, so receiving one proves the stream is live
   * without the test having to sleep.
   */
  async function nextHeartbeat(): Promise<void> {
    const raw = await readRaw();
    if (raw === "heartbeat") {
      return;
    }
    return await nextHeartbeat();
  }

  return {
    cancel: async () => await reader.cancel(),
    nextData,
    nextHeartbeat,
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

  let cookie: string;

  const handlers = createRunEventHandlers({
    pollIntervalMs: 25,
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
  }) {
    return context({
      cookie: input.cookie ?? cookie,
      headers: input.lastEventId
        ? { "last-event-id": input.lastEventId }
        : undefined,
      params: { buildSessionId: input.buildSessionId },
      query: input.query ?? { organizationId, projectId },
    });
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

  it("delivers events appended while the client is connected", async () => {
    const buildSession = await allocate();

    const response = await handlers.stream(
      streamRequest({ buildSessionId: buildSession.buildSessionId })
    );

    const stream = openStream(response);
    try {
      const replayed = await stream.nextData();
      expect(replayed.event).toBe("run.queued");

      // A heartbeat only appears while the follow loop is idle, so it proves the
      // stream is live before new work is appended.
      await stream.nextHeartbeat();

      await store.appendRunEvent({
        payload: { step: "live" },
        runId: buildSession.runId,
        scope,
        type: "agent.progress",
      });

      const live = await stream.nextData();
      expect(live.data.payload).toEqual({ step: "live" });
      expect(live.event).toBe("agent.progress");
      // Absolute sequences are shared across this file's tests because the
      // project reuses one active run; the contract is that the stream moved on.
      expect(live.id).toBeGreaterThan(replayed.id);
      expect(live.data.sequence).toBe(live.id);
    } finally {
      await stream.cancel();
    }
  });
});
