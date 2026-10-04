import { randomUUID } from "node:crypto";
import { SESSION_COOKIE } from "@reasonateai/contracts/auth";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
  UserIdSchema,
} from "@reasonateai/contracts/identity";
import { RunSteeringAcceptedSchema } from "@reasonateai/contracts/steering";
import { createProjectStateStore } from "@reasonateai/project-state/postgres";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { resolveSessionPrincipal } from "../src/mastra/principal";
import type { HandlerContext } from "../src/mastra/routes/build-sessions";
import { createRunSteeringHandlers } from "../src/mastra/routes/steering";

const connectionString = process.env.DATABASE_URL;
describe.skipIf(!connectionString)("active run steering", () => {
  const store = createProjectStateStore({
    connectionString: connectionString ?? "",
  });
  const pool = new Pool({ connectionString });
  const scope = {
    organizationId: OrganizationIdSchema.parse(randomUUID()),
    projectId: ProjectIdSchema.parse(randomUUID()),
  };
  const owner = UserIdSchema.parse(randomUUID());
  const outsider = UserIdSchema.parse(randomUUID());
  let ownerCookie: string;
  let outsiderCookie: string;
  let sessionId: Awaited<
    ReturnType<typeof store.sessions.createSession>
  >["session"]["sessionId"];
  let run: Awaited<ReturnType<typeof allocate>>;
  const handlers = createRunSteeringHandlers({
    resolvePrincipal: (input) =>
      resolveSessionPrincipal({ ...input, sessions: store.sessions }),
    store: () => store,
  });

  async function allocate() {
    const allocation = await store.allocateBuildSession({
      idempotencyKey: randomUUID(),
      scope,
      userSessionId: sessionId,
    });
    const { buildSessionId, runId } = allocation.buildSession;
    const holder = randomUUID();
    const lease = await store.beginRun({ holder, runId, ttlMs: 60_000 });
    if (!lease) {
      throw new Error("Fixture run could not be claimed.");
    }
    return { buildSessionId, holder, leaseId: lease.leaseId, runId, scope };
  }

  function context(
    message: unknown,
    options: { cookie?: string; key?: string; session?: string } = {}
  ): HandlerContext {
    const query: Record<string, string> = scope;
    return {
      json: (body, status) => Response.json(body, { status }),
      req: {
        header: (name) => {
          if (name === "cookie") {
            return options.cookie ?? ownerCookie;
          }
          return name === "idempotency-key"
            ? (options.key ?? randomUUID())
            : undefined;
        },
        json: () => Promise.resolve(message),
        param: (name) =>
          name === "runId"
            ? run.runId
            : (options.session ?? run.buildSessionId),
        query: (name) => query[name],
      },
    };
  }

  const request = (message: string, key = randomUUID()) =>
    store.steering.request({
      ...run,
      idempotencyKey: key,
      message,
      requestedByUserId: owner,
    });

  beforeAll(async () => {
    await store.migrate();
    await pool.query(
      "insert into organizations (organization_id, name) values ($1, 'Steering regression')",
      [scope.organizationId]
    );
    await pool.query(
      "insert into projects (project_id, organization_id, name) values ($1, $2, 'Steering')",
      [scope.projectId, scope.organizationId]
    );
    await pool.query("insert into users (user_id) select unnest($1::uuid[])", [
      [owner, outsider],
    ]);
    await store.memberships.grantOrganizationMembership({
      organizationId: scope.organizationId,
      role: "builder",
      status: "active",
      userId: owner,
    });
    await store.memberships.grantProjectMembership({
      ...scope,
      role: "builder",
      status: "active",
      userId: owner,
    });
    const session = await store.sessions.createSession({
      absoluteTtlMs: 3_600_000,
      idleTtlMs: 3_600_000,
      userId: owner,
    });
    ({ sessionId } = session.session);
    ownerCookie = `${SESSION_COOKIE}=${session.token}`;
    const foreign = await store.sessions.createSession({
      absoluteTtlMs: 3_600_000,
      idleTtlMs: 3_600_000,
      userId: outsider,
    });
    outsiderCookie = `${SESSION_COOKIE}=${foreign.token}`;
  });
  beforeEach(async () => {
    run = await allocate();
  });
  afterEach(async () => {
    await store.steering.retire(run);
    await store.finishRun({ ...run, status: "cancelled" });
  });
  afterAll(async () => {
    await pool.query("delete from organizations where organization_id = $1", [
      scope.organizationId,
    ]);
    await pool.query("delete from users where user_id = any($1::uuid[])", [
      [owner, outsider],
    ]);
    await store.close();
    await pool.end();
  });

  it("authorizes requests and refuses a different conversation", async () => {
    expect(
      (await handlers.steer(context({ message: "Use blue" }, { cookie: "" })))
        .status
    ).toBe(401);
    expect(
      (
        await handlers.steer(
          context({ message: "Use blue" }, { cookie: outsiderCookie })
        )
      ).status
    ).toBe(403);
    expect(
      (
        await handlers.steer(
          context({ message: "Use blue" }, { session: randomUUID() })
        )
      ).status
    ).toBe(404);
    expect(await store.steering.claim(run)).toBeUndefined();
  });

  it("persists one bounded command across retries and rejects changed idempotent content", async () => {
    const key = randomUUID();
    const first = await handlers.steer(
      context({ message: " Use blue " }, { key })
    );
    expect(first.status).toBe(202);
    const accepted = RunSteeringAcceptedSchema.parse(await first.json());
    const replay = await handlers.steer(
      context({ message: "Use blue" }, { key })
    );
    expect(
      RunSteeringAcceptedSchema.parse(await replay.json()).steeringId
    ).toBe(accepted.steeringId);
    expect(
      (await handlers.steer(context({ message: "Use red" }, { key }))).status
    ).toBe(409);
    expect(
      (await handlers.steer(context({ message: "x".repeat(20_001) }))).status
    ).toBe(400);
    expect((await handlers.steer(context({ message: "" }))).status).toBe(400);
    const events = await store.listRunEvents({
      afterSequence: 0,
      limit: 100,
      runId: run.runId,
      scope,
    });
    expect(
      events.filter((event) => event.type === "run.steering.requested")
    ).toHaveLength(1);
  });

  it("only lets the current scoped lease deliver and acknowledge a message", async () => {
    const accepted = await request("Use blue");
    expect(accepted).toBeDefined();
    expect(
      await store.steering.claim({
        ...run,
        scope: { ...scope, projectId: ProjectIdSchema.parse(randomUUID()) },
      })
    ).toBeUndefined();
    const pending = await store.steering.claim(run);
    if (!pending) {
      throw new Error("Expected a steering command.");
    }
    expect(pending.message).toBe("Use blue");
    expect(
      await store.steering.finish({
        ...run,
        ...pending,
        delivered: true,
        holder: "foreign",
      })
    ).toBe(false);
    expect(
      await store.steering.finish({
        ...run,
        ...pending,
        delivered: true,
        scope: { ...scope, projectId: ProjectIdSchema.parse(randomUUID()) },
      })
    ).toBe(false);
    expect(
      await store.steering.finish({ ...run, ...pending, delivered: true })
    ).toBe(true);
    expect(await store.steering.claim(run)).toBeUndefined();
    const events = await store.listRunEvents({
      afterSequence: 0,
      limit: 100,
      runId: run.runId,
      scope,
    });
    expect(
      events.filter((event) => event.type === "run.steering.delivered")
    ).toHaveLength(1);
  });

  it("does not repeat ambiguous delivery after a worker takeover", async () => {
    await request("Use blue");
    const pending = await store.steering.claim(run);
    if (!pending) {
      throw new Error("Expected a steering command.");
    }
    const old = { ...run };
    await pool.query(
      "update run_leases set expires_at = now() - interval '1 second' where run_id = $1",
      [run.runId]
    );
    const holder = randomUUID();
    const lease = await store.beginRun({
      holder,
      runId: run.runId,
      ttlMs: 60_000,
    });
    if (!lease) {
      throw new Error("Expected a takeover lease.");
    }
    run = { ...run, holder, leaseId: lease.leaseId };
    expect(await store.steering.claim(run)).toBeUndefined();
    expect(
      await store.steering.finish({ ...old, ...pending, delivered: true })
    ).toBe(false);
    const events = await store.listRunEvents({
      afterSequence: 0,
      limit: 100,
      runId: run.runId,
      scope,
    });
    expect(
      events.find((event) => event.type === "run.steering.failed")?.payload
        .reason
    ).toContain("may have reached");
  });

  it("bounds admission and rejects a cancelled run", async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, index) => request(`Change ${index}`))
    );
    expect(
      (await handlers.steer(context({ message: "Overflow" }))).status
    ).toBe(409);
    await store.requestRunCancellation({
      buildSessionId: run.buildSessionId,
      requestedByUserId: owner,
      runId: run.runId,
      scope,
    });
    expect(
      (await handlers.steer(context({ message: "Too late" }))).status
    ).toBe(409);
    expect(await store.steering.claim(run)).toBeUndefined();
  });
});
