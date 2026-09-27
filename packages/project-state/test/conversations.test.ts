import { randomUUID } from "node:crypto";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
  SessionIdSchema,
} from "@reasonateai/contracts/identity";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProjectStateStore, type TenantScope } from "../src/postgres.js";
import { deleteOrganizations } from "./support/database.js";

const connectionString = process.env.DATABASE_URL;

const describeWithDatabase = connectionString ? describe : describe.skip;

/**
 * The conversation is the durable unit the product is built around: a project
 * accumulates them, each one has exactly one writer, and a turn is a new run of
 * the same build session. What these tests defend is that contract — not the
 * shape of the rows that implement it.
 */
describeWithDatabase("conversations", () => {
  const pool = new Pool({ connectionString });
  const store = createProjectStateStore({
    connectionString: connectionString as string,
  });

  const organizationId = OrganizationIdSchema.parse(randomUUID());
  const otherOrganizationId = OrganizationIdSchema.parse(randomUUID());
  const userSessionId = SessionIdSchema.parse(randomUUID());

  beforeAll(async () => {
    await store.migrate();
    await pool.query(
      `insert into organizations (organization_id, name)
       select fixture_id, 'Conversation organization'
         from unnest($1::uuid[]) as fixture_id
       on conflict do nothing`,
      [[organizationId, otherOrganizationId]]
    );
  });

  afterAll(async () => {
    await deleteOrganizations(pool, [organizationId, otherOrganizationId]);
    await pool.end();
    await store.close();
  });

  async function project(): Promise<TenantScope> {
    const projectId = ProjectIdSchema.parse(randomUUID());
    await pool.query(
      `insert into projects (project_id, organization_id, name)
       values ($1, $2, 'Conversation project')`,
      [projectId, organizationId]
    );
    return { organizationId, projectId };
  }

  it("records the opening message on the allocating run and offers it to the worker", async () => {
    const scope = await project();
    const allocation = await store.allocateBuildSession({
      idempotencyKey: `opening-${randomUUID()}`,
      message: "Build me a booking page for a small yoga studio.",
      scope,
      userSessionId,
    });

    const [offered] = (await store.listRunnableRuns({ limit: 500 })).filter(
      (run) => run.runId === allocation.buildSession.runId
    );

    expect(offered?.message).toBe(
      "Build me a booking page for a small yoga studio."
    );
  });

  it("queues a turn as a new run of the same conversation, carrying the message", async () => {
    const scope = await project();
    const allocation = await store.allocateBuildSession({
      idempotencyKey: `turn-${randomUUID()}`,
      scope,
      userSessionId,
    });

    // The allocation's own run has to end before the conversation can take
    // another turn; nothing else may write to the thread at the same time.
    await pool.query("update runs set status = 'completed' where run_id = $1", [
      allocation.buildSession.runId,
    ]);

    const turn = await store.appendConversationTurn({
      buildSessionId: allocation.buildSession.buildSessionId,
      message: "Add a cancellation policy to the booking page.",
      scope,
    });

    expect(turn.kind).toBe("queued");
    if (turn.kind !== "queued") {
      throw new Error("expected a queued turn");
    }

    const offered = (await store.listRunnableRuns({ limit: 500 })).find(
      (run) => run.runId === turn.runId
    );
    expect(offered?.message).toBe(
      "Add a cancellation policy to the booking page."
    );
    expect(offered?.buildSessionId).toBe(
      allocation.buildSession.buildSessionId
    );
    expect(turn.sequence).toBe(1);
  });

  it("refuses a second turn while one is in flight, naming the run already working", async () => {
    const scope = await project();
    const allocation = await store.allocateBuildSession({
      idempotencyKey: `busy-${randomUUID()}`,
      scope,
      userSessionId,
    });

    const first = await store.appendConversationTurn({
      buildSessionId: allocation.buildSession.buildSessionId,
      message: "Start with the schema.",
      scope,
    });
    expect(first.kind).toBe("busy");

    const second = await store.appendConversationTurn({
      buildSessionId: allocation.buildSession.buildSessionId,
      message: "Actually, start with the page.",
      scope,
    });

    expect(second).toEqual(first);

    const runs = await pool.query<{ count: number }>(
      "select count(*)::int as count from runs where build_session_id = $1",
      [allocation.buildSession.buildSessionId]
    );
    // The allocation's run, and nothing the refused turns tried to add.
    expect(runs.rows[0]?.count).toBe(1);
  });

  it("keeps two concurrent turns from both becoming a writer of one conversation", async () => {
    const scope = await project();
    const allocation = await store.allocateBuildSession({
      idempotencyKey: `race-${randomUUID()}`,
      scope,
      userSessionId,
    });
    await pool.query("update runs set status = 'completed' where run_id = $1", [
      allocation.buildSession.runId,
    ]);

    const { buildSessionId } = allocation.buildSession;
    const results = await Promise.all([
      store.appendConversationTurn({
        buildSessionId,
        message: "One",
        scope,
      }),
      store.appendConversationTurn({
        buildSessionId,
        message: "Two",
        scope,
      }),
    ]);

    expect(results.filter((result) => result.kind === "queued")).toHaveLength(
      1
    );

    const runs = await pool.query<{ count: number }>(
      `select count(*)::int as count from runs
        where build_session_id = $1 and status not in ('completed', 'failed', 'cancelled')`,
      [buildSessionId]
    );
    expect(runs.rows[0]?.count).toBe(1);
  });

  it("lists a project's conversations with the run a client should follow", async () => {
    const scope = await project();
    const allocation = await store.allocateBuildSession({
      idempotencyKey: `list-${randomUUID()}`,
      scope,
      userSessionId,
    });

    const [listed] = await store.listProjectConversations(scope);

    expect(listed?.buildSessionId).toBe(allocation.buildSession.buildSessionId);
    expect(listed?.pendingRunId).toBe(allocation.buildSession.runId);
    expect(listed?.status).toBe("provisioning");

    // The listing is the project's, so another project's conversation is absent
    // rather than merely filtered out later.
    const other = await project();
    const otherListed = await store.listProjectConversations(other);
    expect(otherListed).toHaveLength(0);
  });

  it("closes a conversation so the next allocation starts a new one, and refuses while a run is in flight", async () => {
    const scope = await project();
    const first = await store.allocateBuildSession({
      idempotencyKey: `close-a-${randomUUID()}`,
      scope,
      userSessionId,
    });

    expect(
      await store.endBuildSession({
        buildSessionId: first.buildSession.buildSessionId,
        scope,
      })
    ).toBe("busy");

    await pool.query("update runs set status = 'completed' where run_id = $1", [
      first.buildSession.runId,
    ]);

    expect(
      await store.endBuildSession({
        buildSessionId: first.buildSession.buildSessionId,
        scope,
      })
    ).toBe("ended");

    // Closing is idempotent: the state the caller asked for is the state it is
    // already in.
    expect(
      await store.endBuildSession({
        buildSessionId: first.buildSession.buildSessionId,
        scope,
      })
    ).toBe("ended");

    const second = await store.allocateBuildSession({
      idempotencyKey: `close-b-${randomUUID()}`,
      scope,
      userSessionId,
    });

    expect(second.created).toBe(true);
    expect(second.buildSession.buildSessionId).not.toBe(
      first.buildSession.buildSessionId
    );

    const conversations = await store.listProjectConversations(scope);
    expect(conversations).toHaveLength(2);
  });

  it("answers for another tenant's conversation as if it did not exist", async () => {
    const scope = await project();
    const allocation = await store.allocateBuildSession({
      idempotencyKey: `foreign-${randomUUID()}`,
      scope,
      userSessionId,
    });
    await pool.query("update runs set status = 'completed' where run_id = $1", [
      allocation.buildSession.runId,
    ]);

    const foreign = await store.appendConversationTurn({
      buildSessionId: allocation.buildSession.buildSessionId,
      message: "Add analytics.",
      scope: {
        organizationId: otherOrganizationId,
        projectId: scope.projectId,
      },
    });

    expect(foreign.kind).toBe("missing");

    const foreignClose = await store.endBuildSession({
      buildSessionId: allocation.buildSession.buildSessionId,
      scope: {
        organizationId: otherOrganizationId,
        projectId: scope.projectId,
      },
    });
    expect(foreignClose).toBe("missing");
  });
});
