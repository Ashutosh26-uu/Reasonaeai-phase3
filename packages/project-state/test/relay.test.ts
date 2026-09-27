import { randomUUID } from "node:crypto";
import { RunEventEnvelopeSchema } from "@reasonateai/contracts/execution-protocol";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
  type RunId,
  RunIdSchema,
  SessionIdSchema,
} from "@reasonateai/contracts/identity";
import { Pool } from "pg";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProjectStateStore } from "../src/postgres.js";
import { createOutboxRelay, createRedisStreamPublisher } from "../src/relay.js";
import { deleteOrganizations } from "./support/database.js";

const connectionString = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const TRANSPORT_FAILURE_PATTERN = /transport unavailable/i;
const describeWithServices =
  connectionString && redisUrl ? describe : describe.skip;

describeWithServices("outbox relay", () => {
  const pool = new Pool({ connectionString });
  const store = createProjectStateStore({
    connectionString: connectionString as string,
  });
  const reader = createClient({ url: redisUrl as string });
  const publisher = createRedisStreamPublisher({
    keyPrefix: "reasonateai-test",
    url: redisUrl as string,
  });

  const organizationId = OrganizationIdSchema.parse(randomUUID());
  const projectId = ProjectIdSchema.parse(randomUUID());
  const userSessionId = SessionIdSchema.parse(randomUUID());
  const scope = { organizationId, projectId };

  // allocateBuildSession reconnects to the project's active session, so the
  // suite allocates once and appends explicit events for everything else.
  let runId: RunId;
  let streamKey: string;

  async function appendProgress(step: string) {
    await store.appendRunEvent({
      payload: { step },
      runId,
      scope,
      type: "agent.progress",
    });
  }

  /** Reads the stream back and validates each envelope against its contract. */
  async function readDelivered() {
    const entries = await reader.xRange(streamKey, "-", "+");
    return entries.map((entry) =>
      RunEventEnvelopeSchema.parse(JSON.parse(entry.message.event ?? "null"))
    );
  }

  beforeAll(async () => {
    await store.migrate();
    await reader.connect();
    await pool.query(
      `insert into organizations (organization_id, name) values ($1, 'Relay test')
       on conflict do nothing`,
      [organizationId]
    );
    await pool.query(
      `insert into projects (project_id, organization_id, name)
       values ($1, $2, 'Relay project') on conflict do nothing`,
      [projectId, organizationId]
    );

    const allocation = await store.allocateBuildSession({
      idempotencyKey: `relay-${randomUUID()}`,
      scope,
      userSessionId,
    });
    runId = RunIdSchema.parse(allocation.buildSession.runId);
    streamKey = `reasonateai-test:reasonateai.run.events.${runId}`;
  });

  afterAll(async () => {
    await deleteOrganizations(pool, [organizationId]);
    await publisher.close();
    await reader.quit();
    await pool.end();
    await store.close();
  });

  it("publishes committed events to the run topic", async () => {
    const relay = createOutboxRelay({ batchSize: 200, publisher, store });
    const published = await relay.drainOnce();

    expect(published).toBeGreaterThan(0);

    const delivered = await readDelivered();
    expect(delivered.some(({ type }) => type === "run.queued")).toBe(true);
    expect(delivered.every(({ runId: id }) => id === runId)).toBe(true);
    expect(
      delivered.every(({ organizationId: id }) => id === organizationId)
    ).toBe(true);
  });

  it("does not republish records already marked delivered", async () => {
    await appendProgress("first");
    const relay = createOutboxRelay({ batchSize: 200, publisher, store });

    const before = await reader.xLen(streamKey);
    await relay.drainOnce();
    const afterFirstDrain = await reader.xLen(streamKey);
    expect(afterFirstDrain).toBeGreaterThan(before);

    await relay.drainOnce();
    expect(await reader.xLen(streamKey)).toBe(afterFirstDrain);
  });

  it("leaves records unpublished when the transport fails, so nothing is lost", async () => {
    await appendProgress("must-survive");

    const failing = createOutboxRelay({
      batchSize: 200,
      publisher: {
        publish: () => {
          throw new Error("transport unavailable");
        },
      },
      store,
    });

    await expect(failing.drainOnce()).rejects.toThrow(
      TRANSPORT_FAILURE_PATTERN
    );
    expect(
      (await store.listPendingOutbox(500)).some(
        ({ payload }) => payload.runId === runId
      )
    ).toBe(true);

    // A healthy relay afterwards must recover the same work.
    const healthy = createOutboxRelay({ batchSize: 200, publisher, store });
    await healthy.drainOnce();

    const delivered = await readDelivered();
    const steps = delivered.map(({ payload }) => payload.step);
    expect(steps).toContain("must-survive");
  });
});
