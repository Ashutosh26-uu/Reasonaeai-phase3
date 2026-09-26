import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { connect, createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import {
  type RunEventEnvelope,
  RunEventEnvelopeSchema,
} from "@reasonateai/contracts/execution-protocol";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
  type RunId,
  RunIdSchema,
  SessionIdSchema,
} from "@reasonateai/contracts/identity";
import {
  createProjectStateStore,
  type ProjectStateStore,
} from "@reasonateai/project-state/postgres";
import { subscribeToRunEvents } from "@reasonateai/project-state/run-event-stream";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type OutboxRelayDetails,
  type OutboxRelayLogger,
  startOutboxRelay,
} from "../src/mastra/outbox-relay";

const connectionString = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const describeWithServices =
  connectionString && redisUrl ? describe : describe.skip;

/** A drain of this many records: more than every suite commits together. */
const OUTBOX_SCAN_LIMIT = 500;

/**
 * The waits inside these tests are bounded by their own deadlines, so the
 * runner's limit only has to sit above them; a passing run finishes in about a
 * second and a failing one names the assertion it could not reach.
 */
const TEST_TIMEOUT_MS = 30_000;
const OUTAGE_TEST_TIMEOUT_MS = 60_000;

interface Recorded {
  failed: string[];
  published: number[];
  started: OutboxRelayDetails[];
  stopped: number;
}

/**
 * A logger that keeps what the loop said. The interface takes counts and
 * identifiers only, so a payload cannot reach a log line through it.
 */
function recorder(): { logger: OutboxRelayLogger; recorded: Recorded } {
  const recorded: Recorded = {
    failed: [],
    published: [],
    started: [],
    stopped: 0,
  };
  return {
    logger: {
      failed: (failure) => recorded.failed.push(failure),
      published: (count) => recorded.published.push(count),
      started: (details) => recorded.started.push(details),
      stopped: () => {
        recorded.stopped += 1;
      },
    },
    recorded,
  };
}

// The relay is a real timer-driven loop talking to a real broker, and the
// property it is tested for — a stopped loop never acts, a down transport is
// retried — is the absence of an event, which no clock injection can await. So
// these waits are genuinely on the platform clock and on the services, and are
// kept to short polling windows with an explicit deadline.
const sleep = (ms: number): Promise<void> => delay(ms);

/** Polls a condition so an assertion waits on real work, not on a guess. */
async function waitUntil(
  condition: () => Promise<boolean>,
  deadlineMs: number
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    // Polling is inherently sequential: each attempt waits on the services.
    // biome-ignore lint/performance/noAwaitInLoops: one poll at a time is the point
    if (await condition()) {
      return true;
    }
    await sleep(20);
  }
  return false;
}

/** A port nothing is listening on, so a connection to it is refused. */
async function freePort(): Promise<number> {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  reservation.close();
  await once(reservation, "close");
  return port;
}

/**
 * A TCP gate in front of the real Redis. While it is not listening, the port
 * refuses connections, which is what a Redis that is down looks like to a
 * publisher; once it listens it forwards bytes verbatim, which is what a Redis
 * that came back looks like. Either state is reached on purpose, so the test
 * does not depend on anything being able to stop a shared container.
 */
function createGate(input: { host: string; port: number }): {
  close: () => Promise<void>;
  listen: (port: number) => Promise<void>;
} {
  const server = createServer((socket) => {
    const upstream = connect(input);
    socket.pipe(upstream);
    upstream.pipe(socket);
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
  });

  return {
    close: async () => {
      server.close();
      await once(server, "close");
    },
    listen: async (port: number) => {
      server.listen(port, "127.0.0.1");
      await once(server, "listening");
    },
  };
}

describeWithServices("outbox relay lifecycle", () => {
  const pool = new Pool({ connectionString });
  const store: ProjectStateStore = createProjectStateStore({
    connectionString: connectionString as string,
  });

  const organizationId = OrganizationIdSchema.parse(randomUUID());
  const projectId = ProjectIdSchema.parse(randomUUID());
  const scope = { organizationId, projectId };

  let buildSessionId: string;
  let runId: RunId;

  /** The run's committed events that no publisher has delivered yet. */
  async function undeliveredEventIds(): Promise<string[]> {
    const records = await store.listPendingOutbox(OUTBOX_SCAN_LIMIT);
    return records
      .filter(({ payload }) => payload.runId === runId)
      .map(({ payload }) => payload.eventId);
  }

  /** The run's committed events in the order they were appended. */
  async function ledgerEventIds(): Promise<string[]> {
    const events = await store.listRunEvents({
      afterSequence: 0,
      limit: OUTBOX_SCAN_LIMIT,
      runId,
      scope,
    });
    return events.map(({ eventId }) => eventId);
  }

  /** Reads what a run's topic has actually received through Redis. */
  async function topicEvents(deadlineMs: number): Promise<RunEventEnvelope[]> {
    const controller = new AbortController();
    const events: RunEventEnvelope[] = [];
    const iterable = await subscribeToRunEvents({
      buildSessionId,
      organizationId,
      projectId,
      runId,
      signal: controller.signal,
    });
    const pump = (async () => {
      for await (const event of iterable) {
        events.push(event);
      }
    })();
    await waitUntil(async () => events.length > 0, deadlineMs);
    controller.abort();
    await pump;
    return events;
  }

  async function appendProgress(step: string) {
    return await store.appendRunEvent({
      payload: { step },
      runId,
      scope,
      type: "agent.progress",
    });
  }

  beforeAll(async () => {
    await store.migrate();
    await pool.query(
      `insert into organizations (organization_id, name) values ($1, 'Relay lifecycle test')
       on conflict do nothing`,
      [organizationId]
    );
    await pool.query(
      `insert into projects (project_id, organization_id, name)
       values ($1, $2, 'Relay lifecycle project') on conflict do nothing`,
      [projectId, organizationId]
    );

    const allocation = await store.allocateBuildSession({
      idempotencyKey: `relay-lifecycle-${randomUUID()}`,
      scope,
      userSessionId: SessionIdSchema.parse(randomUUID()),
    });
    const { buildSession } = allocation;
    ({ buildSessionId } = buildSession);
    runId = RunIdSchema.parse(buildSession.runId);
  });

  afterAll(async () => {
    await pool.query("delete from organizations where organization_id = $1", [
      organizationId,
    ]);
    await pool.end();
    await store.close();
  });

  it(
    "publishes a committed record to its run topic and marks it delivered",
    async () => {
      const { logger, recorded } = recorder();
      const relay = startOutboxRelay({
        intervalMs: 25,
        logger,
        redisUrl,
        store,
      });

      expect(relay).toBeDefined();
      expect(recorded.started).toHaveLength(1);

      // A second start adopts the loop that is already running, so two
      // composition roots in one process cannot open two of them.
      const again = startOutboxRelay({
        intervalMs: 25,
        logger,
        redisUrl,
        store,
      });
      expect(again).toBe(relay);

      const delivered = await topicEvents(10_000);
      const queued = delivered.at(0);

      expect(RunEventEnvelopeSchema.safeParse(queued).success).toBe(true);
      expect(queued?.type).toBe("run.queued");
      expect(queued?.runId).toBe(runId);
      expect(queued?.payload.buildSessionId).toBe(buildSessionId);
      expect(queued?.sequence).toBeGreaterThan(0);

      const settled = await waitUntil(
        async () => (await undeliveredEventIds()).length === 0,
        10_000
      );
      expect(settled).toBe(true);
      expect(
        recorded.published.reduce((total, count) => total + count, 0)
      ).toBeGreaterThan(0);

      await relay?.stop();
    },
    TEST_TIMEOUT_MS
  );

  it(
    "stops draining when it is stopped, and leaves work for the next publisher",
    async () => {
      const { logger, recorded } = recorder();
      const relay = startOutboxRelay({
        intervalMs: 25,
        logger,
        redisUrl,
        store,
      });

      const drained = await appendProgress("before the stop");
      const wasDrained = await waitUntil(
        async () => !(await undeliveredEventIds()).includes(drained.eventId),
        10_000
      );
      expect(wasDrained).toBe(true);

      await relay?.stop();
      await relay?.stop();
      expect(recorded.stopped).toBe(1);

      const publishedBefore = recorded.published.length;
      const failedBefore = recorded.failed.length;
      const afterStop = await appendProgress("after the stop");
      // Six times the loop's cadence: a loop that was still running would have
      // drained or retried by now. This is the one assertion in the suite that
      // observes an absence, so it is the one that needs a real window.
      await sleep(150);

      // The stopped loop neither publishes nor retries anything, whichever way
      // the outbox moves afterwards.
      expect(recorded.published).toHaveLength(publishedBefore);
      expect(recorded.failed).toHaveLength(failedBefore);

      // Nothing was lost by stopping: a publisher that runs again delivers what
      // the stopped one left committed, and the run's ledger is intact.
      const resumed = startOutboxRelay({
        intervalMs: 25,
        logger,
        redisUrl,
        store,
      });
      const delivered = await waitUntil(
        async () => !(await undeliveredEventIds()).includes(afterStop.eventId),
        10_000
      );
      expect(delivered).toBe(true);
      expect(await ledgerEventIds()).toContain(afterStop.eventId);

      await resumed?.stop();
    },
    TEST_TIMEOUT_MS
  );

  it(
    "does not resume from the drain that was in flight when it stopped",
    async () => {
      const releases = new EventEmitter();
      let stalls = 1;
      let stalled = false;
      const stalling = {
        listPendingOutbox: async (limit: number) => {
          if (stalls > 0) {
            stalls -= 1;
            stalled = true;
            await once(releases, "release");
          }
          return await store.listPendingOutbox(limit);
        },
        markOutboxPublished: async (outboxIds: number[]) => {
          await store.markOutboxPublished(outboxIds);
        },
      };
      const { logger, recorded } = recorder();
      // Committed before the loop starts, so the drain that is in flight has
      // real work and completing it is observable.
      const duringStop = await appendProgress("while a drain is in flight");
      const relay = startOutboxRelay({
        // Long enough that the drain in flight completes rather than expires:
        // this test is about the stop, not about the transport bound.
        drainTimeoutMs: 30_000,
        intervalMs: 25,
        logger,
        redisUrl,
        store: stalling,
      });

      const began = await waitUntil(async () => stalled, 5000);
      expect(began).toBe(true);

      const stopping = relay?.stop();
      releases.emit("release");
      await stopping;
      expect(recorded.stopped).toBe(1);
      // The drain that was already running finished: stopping is not a
      // cancellation of work that was in progress.
      expect(
        recorded.published.reduce((total, count) => total + count, 0)
      ).toBeGreaterThan(0);
      expect(await undeliveredEventIds()).not.toContain(duringStop.eventId);

      const publishedBefore = recorded.published.length;
      const failedBefore = recorded.failed.length;
      const afterStop = await appendProgress("after an in-flight stop");
      await sleep(200);

      // It scheduled no drain from the one in flight, so the record committed
      // afterwards was neither published nor retried through a transport this
      // lifecycle had already closed.
      expect(recorded.published).toHaveLength(publishedBefore);
      expect(recorded.failed).toHaveLength(failedBefore);
      expect(await undeliveredEventIds()).toContain(afterStop.eventId);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "logs and retries a transport that is down, then publishes once it returns",
    async () => {
      const upstream = new URL(redisUrl as string);
      const gate = createGate({
        host: upstream.hostname,
        port: Number(upstream.port || 6379),
      });
      const port = await freePort();
      const { logger, recorded } = recorder();
      const relay = startOutboxRelay({
        closeTimeoutMs: 200,
        drainTimeoutMs: 300,
        intervalMs: 30,
        logger,
        maxIntervalMs: 120,
        redisUrl: `redis://127.0.0.1:${port}`,
        store,
      });

      const stranded = await appendProgress("while the transport is down");
      const retried = await waitUntil(
        async () => recorded.failed.length >= 2,
        15_000
      );
      expect(retried).toBe(true);

      // Nothing was acknowledged: the record is still waiting to be published,
      // so a broker outage costs latency and never a committed event.
      expect(await undeliveredEventIds()).toContain(stranded.eventId);
      expect(recorded.published).toEqual([]);
      // The failure names the condition, never the transport's address in URL
      // form, which is the shape that would carry credentials.
      expect(recorded.failed.join(" ")).not.toContain("redis://");
      expect(recorded.failed.join(" ")).not.toContain("@");

      await gate.listen(port);

      const recovered = await waitUntil(
        async () => !(await undeliveredEventIds()).includes(stranded.eventId),
        20_000
      );
      expect(recovered).toBe(true);
      expect(
        recorded.published.reduce((total, count) => total + count, 0)
      ).toBeGreaterThan(0);

      await relay?.stop();
      await gate.close();
    },
    OUTAGE_TEST_TIMEOUT_MS
  );
});
