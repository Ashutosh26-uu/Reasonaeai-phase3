import { randomUUID } from "node:crypto";
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
    return `reasonate_session=${issued.token}`;
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
        cookie: `reasonate_session=${issued.token}`,
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
