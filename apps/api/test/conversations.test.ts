import { randomUUID } from "node:crypto";
import { defaultPlan } from "@reasonateai/auth/entitlements";
import { SESSION_COOKIE } from "@reasonateai/contracts/auth";
import { PLAN_ENTITLEMENTS } from "@reasonateai/contracts/entitlements";
import {
  OrganizationIdSchema,
  type ProjectId,
  ProjectIdSchema,
  SessionIdSchema,
  UserIdSchema,
} from "@reasonateai/contracts/identity";
import {
  createProjectStateStore,
  type ProjectStateStore,
  type TenantScope,
} from "@reasonateai/project-state/postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveSessionPrincipal } from "../src/mastra/principal";
import type { HandlerContext } from "../src/mastra/routes/build-sessions";
import {
  type ConversationMemory,
  createConversationHandlers,
  type DurableMessage,
} from "../src/mastra/routes/conversations";

const connectionString = process.env.DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

const HOUR = 1000 * 60 * 60;

interface StubRequest {
  body?: unknown;
  cookie?: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
  requestId?: string;
}

function context(input: StubRequest): HandlerContext {
  return {
    json: (body, status) =>
      new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
        status,
      }),
    req: {
      header: (name) => {
        const key = name.toLowerCase();
        if (key === "cookie") {
          return input.cookie;
        }
        if (key === "x-request-id") {
          return input.requestId ?? "req-test";
        }
      },
      json: async () => input.body,
      param: (name) => input.params?.[name],
      query: (name) => input.query?.[name],
    },
  };
}

describeWithDatabase("conversation routes", () => {
  const pool = new Pool({ connectionString });
  const store: ProjectStateStore = createProjectStateStore({
    connectionString: connectionString as string,
  });

  const organizationId = OrganizationIdSchema.parse(randomUUID());
  const foreignOrganizationId = OrganizationIdSchema.parse(randomUUID());
  const foreignProjectId = ProjectIdSchema.parse(randomUUID());
  const ownerUserId = UserIdSchema.parse(randomUUID());
  const reviewerUserId = UserIdSchema.parse(randomUUID());

  let ownerCookie: string;
  const createdProjects: ProjectId[] = [];

  /**
   * The route reads a conversation's transcript from the durable agent store.
   * This stands in for it so a route test can assert how what it read is
   * presented, without depending on Mastra's own tables; the real store is
   * exercised by the conversation check through the running API.
   */
  const titles = new Map<string, string>();
  const messagesByThread = new Map<string, DurableMessage[]>();
  const memory: ConversationMemory = {
    listMessages: async ({ threadId }) => ({
      messages: messagesByThread.get(threadId) ?? [],
    }),
    listThreads: async () => ({
      threads: [...titles].map(([id, title]) => ({ id, title })),
    }),
  };

  const handlers = createConversationHandlers({
    entitlements: PLAN_ENTITLEMENTS[defaultPlan],
    memory: async () => memory,
    resolvePrincipal: async ({ cookieHeader }) =>
      await resolveSessionPrincipal({
        cookieHeader,
        sessions: store.sessions,
      }),
    store: () => store,
  });

  async function issueCookie(userId: string) {
    const issued = await store.sessions.createSession({
      absoluteTtlMs: 24 * HOUR,
      idleTtlMs: HOUR,
      userId,
    });
    return `${SESSION_COOKIE}=${issued.token}`;
  }

  function newSessionId() {
    return SessionIdSchema.parse(randomUUID());
  }

  /**
   * One project per test, because allocation adopts a project's active build
   * session: a shared project would make every test continue one conversation.
   */
  async function freshProject(): Promise<TenantScope> {
    const projectId = ProjectIdSchema.parse(randomUUID());
    createdProjects.push(projectId);
    await pool.query(
      "insert into projects (project_id, organization_id, name) values ($1, $2, 'Conversation route project')",
      [projectId, organizationId]
    );
    await store.memberships.grantProjectMembership({
      organizationId,
      projectId,
      role: "builder",
      status: "active",
      userId: ownerUserId,
    });
    await store.memberships.grantProjectMembership({
      organizationId,
      projectId,
      role: "reviewer",
      status: "active",
      userId: reviewerUserId,
    });
    return { organizationId, projectId };
  }

  function query(scope: TenantScope) {
    return {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
    };
  }

  async function conversation(scope: TenantScope) {
    const allocation = await store.allocateBuildSession({
      idempotencyKey: `route-${randomUUID()}`,
      scope,
      userSessionId: newSessionId(),
    });
    return allocation.buildSession;
  }

  async function finish(runId: string) {
    await pool.query("update runs set status = 'completed' where run_id = $1", [
      runId,
    ]);
  }

  beforeAll(async () => {
    await store.migrate();
    await pool.query(
      `insert into organizations (organization_id, name)
       select fixture_id, 'Conversation route test'
         from unnest($1::uuid[]) as fixture_id
       on conflict do nothing`,
      [[organizationId, foreignOrganizationId]]
    );
    await pool.query(
      `insert into projects (project_id, organization_id, name)
       values ($1, $2, 'Foreign project')`,
      [foreignProjectId, foreignOrganizationId]
    );
    await pool.query(
      `insert into users (user_id) select fixture_id
         from unnest($1::uuid[]) as fixture_id on conflict do nothing`,
      [[ownerUserId, reviewerUserId]]
    );

    await store.memberships.grantOrganizationMembership({
      organizationId,
      role: "builder",
      status: "active",
      userId: ownerUserId,
    });
    await store.memberships.grantOrganizationMembership({
      organizationId,
      role: "reviewer",
      status: "active",
      userId: reviewerUserId,
    });

    ownerCookie = await issueCookie(ownerUserId);
  });

  afterAll(async () => {
    await pool.query(
      "delete from organizations where organization_id = any($1::uuid[])",
      [[organizationId, foreignOrganizationId]]
    );
    await pool.query("delete from users where user_id = any($1::uuid[])", [
      [ownerUserId, reviewerUserId],
    ]);
    await pool.end();
    await store.close();
  });

  it("refuses an unauthenticated caller before any scope is resolved", async () => {
    const scope = await freshProject();

    const response = await handlers.list(
      context({
        params: { projectId: scope.projectId },
        query: query(scope),
        requestId: "req-anon",
      })
    );

    expect(response.status).toBe(401);
    expect((await response.json()).error.requestId).toBe("req-anon");
  });

  it("lists a project's conversations with the run to follow and the stored title", async () => {
    const scope = await freshProject();
    const buildSession = await conversation(scope);
    titles.set(buildSession.buildSessionId, "Booking page");

    const response = await handlers.list(
      context({
        cookie: ownerCookie,
        params: { projectId: scope.projectId },
        query: query(scope),
      })
    );

    expect(response.status).toBe(200);
    expect((await response.json()).conversations).toEqual([
      {
        buildSessionId: buildSession.buildSessionId,
        createdAt: buildSession.createdAt,
        latestRunId: buildSession.runId,
        pendingRunId: buildSession.runId,
        status: "provisioning",
        title: "Booking page",
        updatedAt: buildSession.updatedAt,
      },
    ]);
  });

  it("presents a stored message as readable text and drops the model's own parts", async () => {
    const scope = await freshProject();
    const { buildSessionId } = await conversation(scope);
    messagesByThread.set(buildSessionId, [
      {
        content: {
          content: "ignored when parts are present",
          parts: [
            { text: "Build the booking page.", type: "text" },
            { type: "reasoning" },
          ],
        },
        createdAt: new Date("2026-09-01T10:00:00.000Z"),
        id: "message-1",
        role: "user",
      },
    ]);

    const response = await handlers.readMessages(
      context({
        cookie: ownerCookie,
        params: { buildSessionId },
        query: query(scope),
      })
    );

    expect(response.status).toBe(200);
    expect((await response.json()).messages).toEqual([
      {
        createdAt: "2026-09-01T10:00:00.000Z",
        id: "message-1",
        role: "user",
        text: "Build the booking page.",
      },
    ]);
  });

  it("queues a turn once the previous run ended, and hands the worker its message", async () => {
    const scope = await freshProject();
    const buildSession = await conversation(scope);
    await finish(buildSession.runId);

    const response = await handlers.appendTurn(
      context({
        body: { message: "Add pricing." },
        cookie: ownerCookie,
        params: { buildSessionId: buildSession.buildSessionId },
        query: query(scope),
      })
    );

    expect(response.status).toBe(202);
    const accepted = await response.json();
    expect(accepted.buildSessionId).toBe(buildSession.buildSessionId);
    expect(accepted.sequence).toBe(1);

    const offered = (await store.listRunnableRuns({ limit: 500 })).find(
      (run) => run.runId === accepted.runId
    );
    expect(offered?.message).toBe("Add pricing.");
  });

  it("refuses a turn while one is in flight and adds no run to the conversation", async () => {
    const scope = await freshProject();
    const buildSession = await conversation(scope);

    const response = await handlers.appendTurn(
      context({
        body: { message: "Hurry up." },
        cookie: ownerCookie,
        params: { buildSessionId: buildSession.buildSessionId },
        query: query(scope),
      })
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("conflict");

    const runs = await pool.query<{ count: number }>(
      "select count(*)::int as count from runs where build_session_id = $1",
      [buildSession.buildSessionId]
    );
    expect(runs.rows[0]?.count).toBe(1);
  });

  it("lets a reviewer read a conversation but not send into it", async () => {
    const scope = await freshProject();
    const buildSession = await conversation(scope);
    await finish(buildSession.runId);
    const reviewerCookie = await issueCookie(reviewerUserId);

    const read = await handlers.readMessages(
      context({
        cookie: reviewerCookie,
        params: { buildSessionId: buildSession.buildSessionId },
        query: query(scope),
      })
    );
    expect(read.status).toBe(200);

    const send = await handlers.appendTurn(
      context({
        body: { message: "Let me change this." },
        cookie: reviewerCookie,
        params: { buildSessionId: buildSession.buildSessionId },
        query: query(scope),
      })
    );
    expect(send.status).toBe(403);
    expect((await send.json()).error.code).toBe("forbidden");
  });

  it("closes a conversation so the next allocation starts a new one", async () => {
    const scope = await freshProject();
    const buildSession = await conversation(scope);
    const closeRequest = {
      body: {},
      cookie: ownerCookie,
      params: { buildSessionId: buildSession.buildSessionId },
      query: query(scope),
    };

    expect((await handlers.close(context(closeRequest))).status).toBe(409);

    await finish(buildSession.runId);
    expect((await handlers.close(context(closeRequest))).status).toBe(200);

    const next = await store.allocateBuildSession({
      idempotencyKey: `after-close-${randomUUID()}`,
      scope,
      userSessionId: newSessionId(),
    });
    expect(next.created).toBe(true);
    expect(next.buildSession.buildSessionId).not.toBe(
      buildSession.buildSessionId
    );
  });

  it("answers for a project the caller has no membership in as unauthorized", async () => {
    const scope = await freshProject();
    const buildSession = await conversation(scope);

    const response = await handlers.readMessages(
      context({
        cookie: ownerCookie,
        params: { buildSessionId: buildSession.buildSessionId },
        query: {
          organizationId: foreignOrganizationId,
          projectId: foreignProjectId,
        },
      })
    );

    expect(response.status).toBe(403);
  });

  it("keeps another project's conversations out of a project's listing", async () => {
    const scope = await freshProject();
    const otherScope = await freshProject();
    const mine = await conversation(scope);
    await conversation(otherScope);

    const response = await handlers.list(
      context({
        cookie: ownerCookie,
        params: { projectId: scope.projectId },
        query: query(scope),
      })
    );

    expect(response.status).toBe(200);
    // Only the identifiers matter here; the response's full shape is pinned by
    // the listing test above.
    const { conversations } = (await response.json()) as {
      conversations: { buildSessionId: string }[];
    };
    expect(conversations.map((entry) => entry.buildSessionId)).toEqual([
      mine.buildSessionId,
    ]);
  });
});
