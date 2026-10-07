import { randomUUID } from "node:crypto";
import { SESSION_COOKIE } from "@reasonateai/contracts/auth";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
  UserIdSchema,
} from "@reasonateai/contracts/identity";
import {
  createProjectStateStore,
  type ProjectStateStore,
} from "@reasonateai/project-state/postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveSessionPrincipal } from "../src/mastra/principal";
import {
  createBuildSessionHandlers,
  type HandlerContext,
} from "../src/mastra/routes/build-sessions";

const connectionString = process.env.DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

const HOUR = 1000 * 60 * 60;

interface StubRequest {
  body?: unknown;
  cookie?: string;
  idempotencyKey?: string;
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
        if (key === "idempotency-key") {
          return input.idempotencyKey;
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

describeWithDatabase("build session routes", () => {
  const pool = new Pool({ connectionString });
  const store: ProjectStateStore = createProjectStateStore({
    connectionString: connectionString as string,
  });

  const organizationId = OrganizationIdSchema.parse(randomUUID());
  const projectId = ProjectIdSchema.parse(randomUUID());
  const foreignOrganizationId = OrganizationIdSchema.parse(randomUUID());
  const foreignProjectId = ProjectIdSchema.parse(randomUUID());
  const ownerUserId = UserIdSchema.parse(randomUUID());
  const viewerUserId = UserIdSchema.parse(randomUUID());
  const outsiderUserId = UserIdSchema.parse(randomUUID());

  let ownerCookie: string;

  const handlers = createBuildSessionHandlers({
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

  function body(overrides: Record<string, unknown> = {}) {
    return { organizationId, projectId, ...overrides };
  }

  function allocationRequest(overrides: Partial<StubRequest> = {}) {
    return context({
      body: body(),
      cookie: ownerCookie,
      idempotencyKey: `key-${randomUUID()}`,
      requestId: randomUUID(),
      ...overrides,
    });
  }

  beforeAll(async () => {
    await store.migrate();
    await pool.query(
      `insert into organizations (organization_id, name)
       select fixture_id, 'Route test' from unnest($1::uuid[]) as fixture_id
       on conflict do nothing`,
      [[organizationId, foreignOrganizationId]]
    );
    await pool.query(
      `insert into projects (project_id, organization_id, name)
       select f.project_id, f.organization_id, 'Route project'
         from unnest($1::uuid[], $2::uuid[]) as f(project_id, organization_id)
       on conflict do nothing`,
      [
        [projectId, foreignProjectId],
        [organizationId, foreignOrganizationId],
      ]
    );
    await pool.query(
      `insert into users (user_id) select fixture_id
         from unnest($1::uuid[]) as fixture_id on conflict do nothing`,
      [[ownerUserId, viewerUserId, outsiderUserId]]
    );

    await store.memberships.grantOrganizationMembership({
      organizationId,
      role: "builder",
      status: "active",
      userId: ownerUserId,
    });
    await store.memberships.grantProjectMembership({
      organizationId,
      projectId,
      role: "builder",
      status: "active",
      userId: ownerUserId,
    });

    // A viewer is a legitimate member with fewer capabilities.
    await store.memberships.grantOrganizationMembership({
      organizationId,
      role: "viewer",
      status: "active",
      userId: viewerUserId,
    });
    await store.memberships.grantProjectMembership({
      organizationId,
      projectId,
      role: "viewer",
      status: "active",
      userId: viewerUserId,
    });

    ownerCookie = await issueCookie(ownerUserId);
  });

  async function metadataFixture() {
    const principal = await resolveSessionPrincipal({
      cookieHeader: ownerCookie,
      sessions: store.sessions,
    });
    if (!principal) {
      throw new Error("Fixture session missing");
    }
    const allocation = await store.allocateBuildSession({
      idempotencyKey: randomUUID(),
      message: "Original conversation title",
      scope: { organizationId, projectId },
      userSessionId: principal.sessionId,
    });
    await pool.query("update runs set status = 'completed' where run_id = $1", [
      allocation.buildSession.runId,
    ]);
    return allocation.buildSession.buildSessionId as string;
  }

  function metadataContext(id: string, update: unknown, cookie = ownerCookie) {
    return context({
      body: update,
      cookie,
      params: { buildSessionId: id },
      query: { organizationId, projectId },
    });
  }

  it("persists a renamed title and idempotent reversible archive without deleting history", async () => {
    const id = await metadataFixture();
    const renamed = await handlers.updateConversation(
      metadataContext(id, { title: "  My running app  " })
    );
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).title).toBe("My running app");
    const messagesBefore = await handlers.history(
      context({
        cookie: ownerCookie,
        params: { buildSessionId: id },
        query: { organizationId, projectId },
      })
    );
    const before = await messagesBefore.json();
    const archive = await handlers.updateConversation(
      metadataContext(id, { archived: true })
    );
    expect(archive.status).toBe(200);
    const saved = await archive.json();
    const replay = await handlers.updateConversation(
      metadataContext(id, { archived: true })
    );
    expect(await replay.json()).toEqual(saved);
    const active = await store.listConversations({ organizationId, projectId });
    expect(active.some((item) => item.buildSessionId === id)).toBe(false);
    const archived = await handlers.listConversations(
      context({
        cookie: ownerCookie,
        params: { projectId },
        query: { archived: "true", organizationId },
      })
    );
    expect(
      (await archived.json()).conversations.some(
        (item: { buildSessionId: string }) => item.buildSessionId === id
      )
    ).toBe(true);
    const retained = await handlers.history(
      context({
        cookie: ownerCookie,
        params: { buildSessionId: id },
        query: { organizationId, projectId },
      })
    );
    expect(await retained.json()).toEqual(before);
    const turn = await handlers.appendTurn(
      context({
        body: { message: "Must restore first" },
        cookie: ownerCookie,
        idempotencyKey: randomUUID(),
        params: { buildSessionId: id },
        query: { organizationId, projectId },
      })
    );
    expect(turn.status).toBe(409);
    expect(
      (
        await handlers.updateConversation(
          metadataContext(id, { archived: false })
        )
      ).status
    ).toBe(200);
    expect(
      (await store.listConversations({ organizationId, projectId })).find(
        (item) => item.buildSessionId === id
      )?.title
    ).toBe("My running app");
    const events = await pool.query(
      "select action from audit_events where metadata->>'buildSessionId' = $1 order by occurred_at",
      [id]
    );
    expect(events.rows.map((row) => row.action)).toEqual([
      "conversation.renamed",
      "conversation.archived",
      "conversation.restored",
    ]);
  });

  it("denies metadata edits by viewers, outsiders, foreign scopes, and invalid input", async () => {
    const id = await metadataFixture();
    const denials = await Promise.all(
      [viewerUserId, outsiderUserId].map(async (userId) =>
        handlers.updateConversation(
          metadataContext(id, { title: "Denied" }, await issueCookie(userId))
        )
      )
    );
    expect(denials.map((response) => response.status)).toEqual([403, 403]);
    expect(
      (
        await handlers.updateConversation(
          context({
            body: { title: "Denied" },
            params: { buildSessionId: id },
            query: { organizationId, projectId },
          })
        )
      ).status
    ).toBe(401);
    expect(
      (await handlers.updateConversation(metadataContext(id, { title: " " })))
        .status
    ).toBe(400);
    expect(
      (
        await handlers.updateConversation(
          context({
            body: { archived: true },
            cookie: ownerCookie,
            params: { buildSessionId: id },
            query: {
              organizationId: foreignOrganizationId,
              projectId: foreignProjectId,
            },
          })
        )
      ).status
    ).toBe(403);
    expect(
      (
        await handlers.updateConversation(
          metadataContext(randomUUID(), { title: "Absent" })
        )
      ).status
    ).toBe(404);
  });

  it.each(["queued", "leased", "running", "awaiting_approval"])(
    "refuses archive while its run is %s",
    async (status) => {
      const id = await metadataFixture();
      await pool.query(
        "update runs set status = $2 where build_session_id = $1",
        [id, status]
      );
      expect(
        (
          await handlers.updateConversation(
            metadataContext(id, { archived: true })
          )
        ).status
      ).toBe(409);
      await pool.query(
        "update runs set status = 'completed' where build_session_id = $1",
        [id]
      );
      expect(
        (await store.listConversations({ organizationId, projectId })).some(
          (item) => item.buildSessionId === id
        )
      ).toBe(true);
    }
  );

  afterAll(async () => {
    await pool.query(
      "delete from organizations where organization_id = any($1::uuid[])",
      [[organizationId, foreignOrganizationId]]
    );
    await pool.query("delete from users where user_id = any($1::uuid[])", [
      [ownerUserId, viewerUserId, outsiderUserId],
    ]);
    await pool.end();
    await store.close();
  });

  it("refuses an unauthenticated caller without revealing anything", async () => {
    const response = await handlers.allocate(
      context({
        body: body(),
        idempotencyKey: "unauthenticated-key",
        requestId: "req-anon",
      })
    );

    expect(response.status).toBe(401);
    const payload = await response.json();
    expect(payload.error.code).toBe("unauthenticated");
    expect(payload.error.requestId).toBe("req-anon");
  });

  it("refuses a revoked session even though the cookie is otherwise valid", async () => {
    const issued = await store.sessions.createSession({
      absoluteTtlMs: 24 * HOUR,
      idleTtlMs: HOUR,
      userId: ownerUserId,
    });
    await store.sessions.revokeSession(issued.session.sessionId);

    const response = await handlers.allocate(
      context({
        body: body(),
        cookie: `${SESSION_COOKIE}=${issued.token}`,
        idempotencyKey: "revoked-key",
        requestId: "req-revoked",
      })
    );

    expect(response.status).toBe(401);
  });

  it("requires an idempotency key", async () => {
    const response = await handlers.allocate(
      allocationRequest({ idempotencyKey: undefined })
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_request");
  });

  it("rejects a body that tries to supply scope the caller does not own", async () => {
    const response = await handlers.allocate(
      allocationRequest({ body: body({ runId: randomUUID() }) })
    );

    expect(response.status).toBe(400);
  });

  it("allocates once and returns the same session for a repeated key", async () => {
    const idempotencyKey = `repeat-${randomUUID()}`;
    const first = await handlers.allocate(
      allocationRequest({ idempotencyKey })
    );
    const second = await handlers.allocate(
      allocationRequest({ idempotencyKey })
    );

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);

    const firstBody = await first.json();
    const secondBody = await second.json();

    expect(firstBody.created).toBe(true);
    expect(secondBody.created).toBe(false);
    expect(secondBody.buildSession.buildSessionId).toBe(
      firstBody.buildSession.buildSessionId
    );
  });

  it("accepts an image attachment on a later turn and returns only its metadata in history", async () => {
    const allocated = await handlers.allocate(
      allocationRequest({ body: body() })
    );
    expect(allocated.status).toBe(202);
    const {
      buildSession: { buildSessionId, runId },
    } = await allocated.json();
    const holder = `attachment-test-${randomUUID()}`;
    const lease = await store.beginRun({ holder, runId, ttlMs: 60_000 });
    if (!lease) {
      throw new Error("The initial run could not be leased for the test.");
    }
    await store.finishRun({
      holder,
      leaseId: lease.leaseId,
      runId,
      status: "succeeded",
    });

    const append = await handlers.appendTurn(
      context({
        body: {
          attachments: [
            {
              data: "data:image/png;base64,aGVsbG8=",
              filename: "wireframe.png",
              mediaType: "image/png",
            },
          ],
          message: "Review this screen",
        },
        cookie: ownerCookie,
        idempotencyKey: `attachment-turn-${randomUUID()}`,
        params: { buildSessionId },
        query: { organizationId, projectId },
      })
    );
    expect(append.status).toBe(202);

    const history = await handlers.history(
      context({
        cookie: ownerCookie,
        params: { buildSessionId },
        query: { organizationId, projectId },
      })
    );
    expect(history.status).toBe(200);
    const transcript = await history.json();
    expect(transcript.messages).toContainEqual(
      expect.objectContaining({
        attachments: [
          {
            filename: "wireframe.png",
            mediaType: "image/png",
            sizeBytes: 5,
          },
        ],
        text: "Review this screen",
      })
    );
  });

  it("accepts a scoped cancellation request only from a builder", async () => {
    const allocated = await handlers.allocate(
      allocationRequest({ idempotencyKey: `cancel-${randomUUID()}` })
    );
    expect(allocated.status).toBe(202);
    const { buildSession } = await allocated.json();
    const params = {
      buildSessionId: buildSession.buildSessionId,
      runId: buildSession.runId,
    };
    const query = { organizationId, projectId };

    const viewer = await handlers.cancelRun(
      context({ cookie: await issueCookie(viewerUserId), params, query })
    );
    expect(viewer.status).toBe(403);

    const stopped = await handlers.cancelRun(
      context({ cookie: ownerCookie, params, query })
    );
    expect(stopped.status).toBe(202);
    expect(await stopped.json()).toEqual({
      accepted: true,
      runId: buildSession.runId,
    });
    expect(
      (
        await handlers.cancelRun(
          context({ cookie: ownerCookie, params, query })
        )
      ).status
    ).toBe(202);
    expect(await store.isRunCancellationRequested(buildSession.runId)).toBe(
      true
    );
    const events = await store.listRunEvents({
      afterSequence: 0,
      limit: 20,
      runId: buildSession.runId,
      scope: { organizationId, projectId },
    });
    expect(
      events.filter((event) => event.type === "run.cancel.requested")
    ).toHaveLength(1);
  });

  it("accepts an ask_user answer only from an authorized builder and persists it for retained context", async () => {
    const allocated = await handlers.allocate(
      allocationRequest({ idempotencyKey: `answer-${randomUUID()}` })
    );
    expect(allocated.status).toBe(202);
    const { buildSession } = await allocated.json();
    const scope = { organizationId, projectId };
    const lease = await store.beginRun({
      holder: "answer-route-test",
      runId: buildSession.runId,
      ttlMs: 60_000,
    });
    expect(lease).toBeDefined();
    await store.appendRunEvent({
      controllerRunId: "test-controller-run",
      payload: {
        kind: "tool_suspended",
        suspendPayload: { question: "Which region?" },
        toolCallId: "ask-1",
        toolName: "ask_user",
      },
      runId: buildSession.runId,
      scope,
      type: "approval.requested",
    });
    const params = {
      buildSessionId: buildSession.buildSessionId,
      runId: buildSession.runId,
    };
    const query = scope;
    const answerBody = { answer: "Europe", toolCallId: "ask-1" };
    expect(
      (
        await handlers.answerRun(
          context({
            body: answerBody,
            cookie: await issueCookie(viewerUserId),
            params,
            query,
          })
        )
      ).status
    ).toBe(403);
    expect(
      (
        await handlers.answerRun(
          context({
            body: answerBody,
            cookie: ownerCookie,
            params,
            query: {
              organizationId: foreignOrganizationId,
              projectId: foreignProjectId,
            },
          })
        )
      ).status
    ).toBe(403);
    expect(
      (
        await handlers.answerRun(
          context({ body: answerBody, cookie: ownerCookie, params, query })
        )
      ).status
    ).toBe(202);
    expect(
      (
        await handlers.answerRun(
          context({ body: answerBody, cookie: ownerCookie, params, query })
        )
      ).status
    ).toBe(202);
    expect(
      (
        await handlers.answerRun(
          context({
            body: { answer: "Asia", toolCallId: "ask-1" },
            cookie: ownerCookie,
            params,
            query,
          })
        )
      ).status
    ).toBe(409);
    expect(
      await store.takeRunAnswer({
        runId: buildSession.runId,
        scope,
        toolCallId: "ask-1",
      })
    ).toBe("Europe");
    const events = await store.listRunEvents({
      afterSequence: 0,
      limit: 20,
      runId: buildSession.runId,
      scope,
    });
    expect(
      events.filter((event) => event.type === "approval.resolved")
    ).toHaveLength(1);
    expect(
      events.find((event) => event.type === "approval.resolved")?.payload
    ).toMatchObject({
      answer: "Europe",
      toolCallId: "ask-1",
    });
    await store.finishRun({
      holder: "answer-route-test",
      leaseId: lease?.leaseId ?? "",
      runId: buildSession.runId,
      status: "succeeded",
    });
  });

  it("accepts a submit_plan decision and records run.plan_decided event", async () => {
    const allocated = await handlers.allocate(
      allocationRequest({ idempotencyKey: `plan-${randomUUID()}` })
    );
    expect(allocated.status).toBe(202);
    const { buildSession } = await allocated.json();
    const scope = { organizationId, projectId };
    const lease = await store.beginRun({
      holder: "plan-route-test",
      runId: buildSession.runId,
      ttlMs: 60_000,
    });
    expect(lease).toBeDefined();
    await store.appendRunEvent({
      controllerRunId: "test-controller-run",
      payload: {
        args: { title: "New Feature Plan" },
        kind: "tool_suspended",
        suspendPayload: { title: "New Feature Plan" },
        toolCallId: "plan-call-1",
        toolName: "submit_plan",
      },
      runId: buildSession.runId,
      scope,
      type: "run.plan_proposed",
    });
    const params = {
      buildSessionId: buildSession.buildSessionId,
      runId: buildSession.runId,
    };
    const query = scope;
    const planDecisionBody = {
      approved: true,
      feedback: "Looks great, proceed",
      toolCallId: "plan-call-1",
    };
    const res = await handlers.answerRun(
      context({ body: planDecisionBody, cookie: ownerCookie, params, query })
    );
    expect(res.status).toBe(202);

    const takenAnswer = await store.takeRunAnswer({
      runId: buildSession.runId,
      scope,
      toolCallId: "plan-call-1",
    });
    expect(takenAnswer).toBe(
      JSON.stringify({ approved: true, feedback: "Looks great, proceed" })
    );

    const events = await store.listRunEvents({
      afterSequence: 0,
      limit: 20,
      runId: buildSession.runId,
      scope,
    });
    const planDecided = events.find((e) => e.type === "run.plan_decided");
    expect(planDecided).toBeDefined();
    expect(planDecided?.payload.approved).toBe(true);
    expect(planDecided?.payload.feedback).toBe("Looks great, proceed");

    await store.finishRun({
      holder: "plan-route-test",
      leaseId: lease?.leaseId ?? "",
      runId: buildSession.runId,
      status: "succeeded",
    });
  });

  it("denies a member whose role lacks the capability", async () => {
    const response = await handlers.allocate(
      context({
        body: body(),
        cookie: await issueCookie(viewerUserId),
        idempotencyKey: `viewer-${randomUUID()}`,
        requestId: "req-viewer",
      })
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("forbidden");
  });

  it("denies a caller with no membership in the organization", async () => {
    const response = await handlers.allocate(
      context({
        body: body(),
        cookie: await issueCookie(outsiderUserId),
        idempotencyKey: `outsider-${randomUUID()}`,
      })
    );

    expect(response.status).toBe(403);
  });

  it("reads back the caller's own session and refuses a foreign tenant", async () => {
    const allocated = await handlers.allocate(
      allocationRequest({ idempotencyKey: `read-${randomUUID()}` })
    );
    const { buildSession } = await allocated.json();

    const read = await handlers.read(
      context({
        cookie: ownerCookie,
        params: { buildSessionId: buildSession.buildSessionId },
        query: { organizationId, projectId },
        requestId: "req-read",
      })
    );
    expect(read.status).toBe(200);
    expect((await read.json()).buildSession.buildSessionId).toBe(
      buildSession.buildSessionId
    );

    const foreign = await handlers.read(
      context({
        cookie: ownerCookie,
        params: { buildSessionId: buildSession.buildSessionId },
        query: {
          organizationId: foreignOrganizationId,
          projectId: foreignProjectId,
        },
      })
    );
    expect(foreign.status).toBe(403);
  });

  it("does not report another project's session as found", async () => {
    const unallocatedProjectId = ProjectIdSchema.parse(randomUUID());
    await pool.query(
      `insert into projects (project_id, organization_id, name)
       values ($1, $2, 'Second route project') on conflict do nothing`,
      [unallocatedProjectId, organizationId]
    );
    await store.memberships.grantProjectMembership({
      organizationId,
      projectId: unallocatedProjectId,
      role: "builder",
      status: "active",
      userId: ownerUserId,
    });

    const response = await handlers.read(
      context({
        cookie: ownerCookie,
        params: { buildSessionId: randomUUID() },
        query: { organizationId, projectId: unallocatedProjectId },
      })
    );

    expect(response.status).toBe(404);
  });
});
