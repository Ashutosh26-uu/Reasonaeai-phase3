import { randomUUID } from "node:crypto";
import { runEventTopic } from "@reasonateai/contracts/execution-protocol";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
  SessionIdSchema,
} from "@reasonateai/contracts/identity";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProjectStateStore } from "../src/postgres.js";
import { billingPeriodFor } from "../src/usage.js";
import { deleteOrganizations } from "./support/database.js";

const connectionString = process.env.DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

describeWithDatabase("usage metering and outbox claims", () => {
  const pool = new Pool({ connectionString });
  const store = createProjectStateStore({
    connectionString: connectionString as string,
  });

  const organizationId = OrganizationIdSchema.parse(randomUUID());
  const projectId = ProjectIdSchema.parse(randomUUID());
  const userSessionId = SessionIdSchema.parse(randomUUID());
  const scope = { organizationId, projectId };

  const period = billingPeriodFor(new Date());

  beforeAll(async () => {
    await store.migrate();
    await pool.query(
      `insert into organizations (organization_id, name) values ($1, 'Usage test')
       on conflict do nothing`,
      [organizationId]
    );
    await pool.query(
      `insert into projects (project_id, organization_id, name)
       values ($1, $2, 'Usage project') on conflict do nothing`,
      [projectId, organizationId]
    );
  });

  afterAll(async () => {
    await deleteOrganizations(pool, [organizationId]);
    await pool.end();
    await store.close();
  });

  it("grants the last remaining unit to exactly one of two concurrent reservations", async () => {
    const reservations = await Promise.all([
      store.usage.reserve({
        amount: 1,
        limit: 1,
        metric: "runs",
        organizationId,
        periodEnd: period.end,
        periodStart: period.start,
      }),
      store.usage.reserve({
        amount: 1,
        limit: 1,
        metric: "runs",
        organizationId,
        periodEnd: period.end,
        periodStart: period.start,
      }),
    ]);

    const granted = reservations.filter(({ allowed }) => allowed);
    const refused = reservations.filter(({ allowed }) => !allowed);

    expect(granted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    // The winner decided against an empty period and the loser saw the winner's
    // unit, which is only possible if the two were serialized.
    expect(granted[0]?.observed).toBe(0);
    expect(refused[0]?.observed).toBe(1);
    expect(granted[0]?.limit).toBe(1);

    expect((await store.usage.snapshot(organizationId)).runs).toBe(1);
  });

  it("sums only the records inside the requested period", async () => {
    const previous = billingPeriodFor(new Date(period.start.getTime() - 1));

    await store.usage.record({
      amount: 7,
      metric: "tokens",
      organizationId,
      runId: null,
    });
    await store.usage.record({
      amount: 500,
      metric: "tokens",
      organizationId,
      recordedAt: previous.start,
      runId: null,
    });

    const snapshot = await store.usage.snapshot(organizationId);

    expect(snapshot.tokens).toBe(7);
    expect(snapshot.periodStart).toBe(period.start.toISOString());
    expect(snapshot.periodEnd).toBe(period.end.toISOString());
  });

  it("records a zero amount with a null run id, and counts it as zero", async () => {
    await expect(
      store.usage.record({
        amount: 0,
        metric: "sandbox_minutes",
        organizationId,
        runId: null,
      })
    ).resolves.toBeUndefined();

    const snapshot = await store.usage.snapshot(organizationId);
    expect(snapshot.sandboxMinutes).toBe(0);
    expect(snapshot.workspaceBytes).toBe(0);
  });

  it("never hands the same outbox row to two relays at once", async () => {
    const allocation = await store.allocateBuildSession({
      idempotencyKey: `usage-outbox-${randomUUID()}`,
      scope,
      userSessionId,
    });
    const { runId } = allocation.buildSession;

    // Appended one at a time: this test races two claims over the rows these
    // commits leave, and concurrent appends would race on the run's sequence.
    await store.appendRunEvent({
      payload: { step: "one" },
      runId,
      scope,
      type: "agent.progress",
    });
    await store.appendRunEvent({
      payload: { step: "two" },
      runId,
      scope,
      type: "agent.progress",
    });
    await store.appendRunEvent({
      payload: { step: "three" },
      runId,
      scope,
      type: "agent.progress",
    });

    const [left, right] = await Promise.all([
      store.outbox.claim(50),
      store.outbox.claim(50),
    ]);

    expect(left.length + right.length).toBeGreaterThan(0);
    const leftIds = new Set(left.map(({ outboxId }) => outboxId));
    expect(right.filter(({ outboxId }) => leftIds.has(outboxId))).toHaveLength(
      0
    );

    const claimed = [...left, ...right];
    const forRun = claimed.filter(
      ({ topic }) => topic === runEventTopic(runId)
    );
    expect(forRun.length).toBeGreaterThan(0);
    expect(forRun[0]?.payload).toBeDefined();

    // Marking published is still what retires a row, claim or no claim.
    await store.markOutboxPublished(
      forRun.map(({ outboxId }) => Number(outboxId))
    );
    const afterMark = await store.outbox.claim(50);
    expect(
      afterMark.filter(({ topic }) => topic === runEventTopic(runId))
    ).toHaveLength(0);
  });
});
