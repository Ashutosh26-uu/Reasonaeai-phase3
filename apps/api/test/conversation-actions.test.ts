import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SESSION_COOKIE } from "@reasonateai/contracts/auth";
import { PLAN_ENTITLEMENTS } from "@reasonateai/contracts/entitlements";
import {
  type BuildSessionId,
  ConversationTurnAcceptedSchema,
} from "@reasonateai/contracts/execution";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
  type RunId,
  UserIdSchema,
} from "@reasonateai/contracts/identity";
import { createProjectStateStore } from "@reasonateai/project-state/postgres";
import { createGitCheckpointStore } from "@reasonateai/sandbox/checkpoint";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveSessionPrincipal } from "../src/mastra/principal";
import {
  createBuildSessionHandlers,
  type HandlerContext,
} from "../src/mastra/routes/build-sessions";
import { createConversationActionHandlers } from "../src/mastra/routes/conversation-actions";
import { createWorkspaceHandlers } from "../src/mastra/routes/workspace";

const connectionString = process.env.DATABASE_URL;
const exec = promisify(execFile);
const suite = connectionString ? describe : describe.skip;
suite("durable conversation actions", { timeout: 60_000 }, () => {
  const pool = new Pool({ connectionString });
  const store = createProjectStateStore({
    connectionString: connectionString as string,
  });
  const organizationId = OrganizationIdSchema.parse(randomUUID());
  const owner = UserIdSchema.parse(randomUUID());
  const viewer = UserIdSchema.parse(randomUUID());
  const outsider = UserIdSchema.parse(randomUUID());
  let root: string;
  let cookies: string[];
  const deps = {
    resolvePrincipal: async ({
      cookieHeader,
    }: {
      cookieHeader?: string | undefined;
    }) => resolveSessionPrincipal({ cookieHeader, sessions: store.sessions }),
    store: () => store,
  };
  const checkpoints = () =>
    createGitCheckpointStore({ root: join(root, "checkpoints") });
  const failures: unknown[] = [];
  const actions = createConversationActionHandlers({
    ...deps,
    checkpoints,
    onFailure: (cause) => failures.push(cause),
  });
  const reads = createBuildSessionHandlers(deps);
  let workspace: ReturnType<typeof createWorkspaceHandlers>;
  beforeAll(async () => {
    await store.migrate();
    root = await mkdtemp(join(tmpdir(), "reasonate-history-api-"));
    workspace = createWorkspaceHandlers({
      ...deps,
      checkpoints: checkpoints(),
    });
    await pool.query(
      "insert into organizations(organization_id,name) values($1,'History fixture')",
      [organizationId]
    );
    await pool.query("insert into users(user_id) select unnest($1::uuid[])", [
      [owner, viewer, outsider],
    ]);
    await Promise.all(
      [owner, viewer].map((userId) =>
        store.memberships.grantOrganizationMembership({
          organizationId,
          role: userId === owner ? "builder" : "viewer",
          status: "active",
          userId,
        })
      )
    );
    cookies = await Promise.all(
      [owner, viewer, outsider].map(async (userId) => {
        const session = await store.sessions.createSession({
          absoluteTtlMs: 3_600_000,
          idleTtlMs: 3_600_000,
          userId,
        });
        return `${SESSION_COOKIE}=${session.token}`;
      })
    );
  });
  afterAll(async () => {
    await pool.query("delete from organizations where organization_id=$1", [
      organizationId,
    ]);
    await pool.query("delete from users where user_id=any($1::uuid[])", [
      [owner, viewer, outsider],
    ]);
    await pool.end();
    await store.close();
    await rm(root, { force: true, recursive: true });
  });
  async function requirePrincipal() {
    const principal = await deps.resolvePrincipal({ cookieHeader: cookies[0] });
    if (!principal) {
      throw new Error("No fixture principal");
    }
    return principal;
  }
  async function fixture(count = 2) {
    const projectId = ProjectIdSchema.parse(randomUUID());
    const scope = { organizationId, projectId };
    await pool.query(
      "insert into projects(project_id,organization_id,name) values($1,$2,'History')",
      [projectId, organizationId]
    );
    await Promise.all(
      [owner, viewer].map((userId) =>
        store.memberships.grantProjectMembership({
          ...scope,
          role: userId === owner ? "builder" : "viewer",
          status: "active",
          userId,
        })
      )
    );
    const directory = await mkdtemp(join(root, "source-"));
    const git = (args: string[]) => exec("git", args, { cwd: directory });
    await git(["init", "--quiet"]);
    await git(["config", "user.name", "History fixture"]);
    await git(["config", "user.email", "history@example.invalid"]);
    await git(["commit", "--quiet", "--allow-empty", "-m", "Empty source"]);
    const principal = await deps.resolvePrincipal({ cookieHeader: cookies[0] });
    if (!principal) {
      throw new Error("Fixture session missing");
    }
    const allocation = await store.allocateBuildSession({
      idempotencyKey: randomUUID(),
      message: "Request 1",
      scope,
      userSessionId: principal.sessionId,
    });
    const { buildSessionId } = allocation.buildSession;
    const runIds: RunId[] = [];
    const boundaries: string[] = [];
    const finals: string[] = [];
    const sequences: number[] = [];
    const bundlePath = join(root, `${projectId}.bundle`);
    async function bundle(runId: RunId) {
      await git(["bundle", "create", bundlePath, "--all"]);
      return await checkpoints().write({
        ...scope,
        buildSessionId,
        content: await readFile(bundlePath),
        runId,
      });
    }
    await Array.from({ length: count }, (_, i) => i).reduce(
      async (previous, index) => {
        await previous;
        const runId =
          index === 0
            ? allocation.buildSession.runId
            : (
                await store.appendConversationTurn({
                  buildSessionId,
                  idempotencyKey: randomUUID(),
                  message: `Request ${index + 1}`,
                  scope,
                })
              ).runId;
        runIds.push(runId);
        boundaries.push((await bundle(runId)).checkpointId);
        await store.history.boundary(scope, runId, boundaries[index] as string);
        const baseCommit = (await git(["rev-parse", "HEAD"])).stdout.trim();
        await writeFile(join(directory, "notes.txt"), `Version ${index + 1}\n`);
        await git(["add", "notes.txt"]);
        await git(["commit", "--quiet", "-m", `Turn ${index + 1}`]);
        const commit = (await git(["rev-parse", "HEAD"])).stdout.trim();
        const final = await bundle(runId);
        finals.push(final.checkpointId);
        await store.appendRunEvent({
          payload: {
            kind: "message_end",
            messageId: randomUUID(),
            role: "assistant",
            text: `Answer ${index + 1}`,
          },
          runId,
          scope,
          type: "agent.progress",
        });
        const event = await store.appendRunEvent({
          payload: {
            checkpoint: {
              added: 1,
              baseCommit,
              checkpointId: final.checkpointId,
              commit,
              fileCount: 1,
              files: [
                {
                  added: 1,
                  path: "notes.txt",
                  removed: index === 0 ? 0 : 1,
                  status: index === 0 ? "added" : "modified",
                },
              ],
              removed: index === 0 ? 0 : 1,
              status: "available",
              truncated: false,
              version: 1,
            },
            checkpointId: final.checkpointId,
          },
          runId,
          scope,
          type: "run.completed",
        });
        sequences.push(event.sequence);
        await store.setRunStatus({ runId, scope, status: "completed" });
      },
      Promise.resolve()
    );
    return { boundaries, buildSessionId, finals, runIds, scope, sequences };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  function context(
    f: Fixture,
    input: {
      session?: BuildSessionId;
      runId?: RunId;
      key?: string;
      body?: unknown;
      cookie?: string;
      path?: string;
      sequence?: number;
    } = {}
  ): HandlerContext {
    const query: Record<string, string> = {
      ...f.scope,
      path: input.path ?? "notes.txt",
      runId: input.runId ?? f.runIds[0] ?? "",
      sequence: String(input.sequence ?? f.sequences[0]),
    };
    return {
      json: (body, status) => Response.json(body, { status }),
      req: {
        header: (name) => {
          if (name === "cookie") {
            return input.cookie ?? cookies[0];
          }
          if (name === "idempotency-key") {
            return input.key ?? randomUUID();
          }
        },
        json: async () => input.body ?? {},
        param: (name) =>
          name === "buildSessionId"
            ? (input.session ?? f.buildSessionId)
            : (input.runId ?? f.runIds[0]),
        query: (name) => query[name],
      },
    };
  }
  const accepted = async (response: Response) => {
    expect(
      response.status,
      failures
        .map((cause) =>
          cause instanceof Error ? cause.message : String(cause)
        )
        .join("\n")
    ).toBe(202);
    return ConversationTurnAcceptedSchema.parse(await response.json());
  };
  it("branches through six, rewinds ten to six, preserves the original branch, and survives migration/reload", async () => {
    const f = await fixture(10);
    const [, , , , , selected] = f.runIds;
    if (!selected) {
      throw new Error("Sixth turn missing");
    }
    const branch = await accepted(
      await actions.branch(context(f, { body: { runId: selected } }))
    );
    expect(
      (
        await store.listConversationMessages({
          buildSessionId: branch.buildSessionId,
          scope: f.scope,
        })
      ).filter((m) => m.role === "user")
    ).toHaveLength(6);
    expect(
      (await workspace.file(context(f, { session: branch.buildSessionId })))
        .status
    ).toBe(200);
    expect(
      await (
        await workspace.file(context(f, { session: branch.buildSessionId }))
      ).text()
    ).toContain("Version 6");
    expect(
      (
        await workspace.checkpointDiff(
          context(f, {
            runId: selected,
            sequence: f.sequences[5],
            session: branch.buildSessionId,
          })
        )
      ).status
    ).toBe(200);
    const key = randomUUID();
    const request = context(f, { key, runId: selected });
    const replay = await accepted(await actions.retry(request));
    expect(
      await accepted(await actions.retry(context(f, { key, runId: selected })))
    ).toEqual(replay);
    expect(
      (
        await store.listConversationMessages({
          buildSessionId: f.buildSessionId,
          scope: f.scope,
        })
      ).filter((m) => m.role === "user")
    ).toHaveLength(6);
    expect(await (await workspace.file(context(f))).text()).toContain(
      "Version 5"
    );
    expect(
      await (
        await workspace.file(context(f, { session: branch.buildSessionId }))
      ).text()
    ).toContain("Version 6");
    expect(
      (
        await workspace.checkpointDiff(
          context(f, { runId: selected, sequence: f.sequences[5] })
        )
      ).status
    ).toBe(404);
    expect(
      (
        await pool.query("select 1 from runs where run_id=any($1::uuid[])", [
          f.runIds,
        ])
      ).rowCount
    ).toBe(10);
    await store.migrate();
    expect(
      (
        await store.listConversationMessages({
          buildSessionId: f.buildSessionId,
          scope: f.scope,
        })
      ).filter((m) => m.role === "user")
    ).toHaveLength(6);
    const forkTurn = await store.appendConversationTurn({
      buildSessionId: branch.buildSessionId,
      idempotencyKey: randomUUID(),
      message: "Continue branch",
      scope: f.scope,
    });
    expect(forkTurn.runId).not.toBe(replay.runId);
    expect(
      (
        await store.listConversationMessages({
          buildSessionId: f.buildSessionId,
          scope: f.scope,
        })
      ).at(-1)?.text
    ).toBe("Request 6");
  });
  it("edits and resends with the same boundary; refuses source/key substitution", async () => {
    const f = await fixture();
    const [runId] = f.runIds;
    const key = randomUUID();
    const result = await accepted(
      await actions.retry(
        context(f, { body: { message: "Revised request" }, key, runId })
      )
    );
    const messages = await store.listConversationMessages({
      buildSessionId: f.buildSessionId,
      scope: f.scope,
    });
    expect(messages.map((m) => m.text)).toEqual(["Revised request"]);
    expect(
      (await store.history.head(f.scope, f.buildSessionId))?.checkpointId
    ).toBe(f.boundaries[0]);
    expect(
      (
        await actions.retry(
          context(f, { body: { message: "Different text" }, key, runId })
        )
      ).status
    ).toBe(409);
    expect(
      (await actions.retry(context(f, { runId: f.runIds[1] }))).status
    ).toBe(409);
    expect(result.runId).not.toBe(runId);
  });
  it("rejects unverified checkpoints without changing history or spending quota", async () => {
    const f = await fixture();
    await pool.query(
      "update run_workspace_boundaries set checkpoint_id=$2 where run_id=$1",
      [f.runIds[0], `${organizationId}.${f.scope.projectId}.${"a".repeat(64)}`]
    );
    const before = await store.usage.snapshot(organizationId);
    expect((await actions.retry(context(f))).status).toBe(500);
    expect(
      (
        await store.listConversationMessages({
          buildSessionId: f.buildSessionId,
          scope: f.scope,
        })
      ).filter((m) => m.role === "user")
    ).toHaveLength(2);
    expect((await store.usage.snapshot(organizationId)).runs).toBe(before.runs);
  });
  it("blocks project-wide queued work and denies viewer/outsider/invalid requests", async () => {
    const f = await fixture();
    expect(
      (await actions.retry(context(f, { cookie: cookies[1] }))).status
    ).toBe(403);
    expect(
      (await actions.retry(context(f, { cookie: cookies[2] }))).status
    ).toBe(403);
    expect((await actions.retry(context(f, { cookie: "" }))).status).toBe(401);
    expect((await actions.retry(context(f, { key: "" }))).status).toBe(400);
    expect(
      (await actions.retry(context(f, { body: { message: "" } }))).status
    ).toBe(400);
    await store.allocateBuildSession({
      idempotencyKey: randomUUID(),
      message: "Other work",
      scope: f.scope,
      userSessionId: (await requirePrincipal()).sessionId,
    });
    expect((await actions.retry(context(f))).status).toBe(409);
    expect(
      (await actions.branch(context(f, { body: { runId: f.runIds[0] } })))
        .status
    ).toBe(409);
  });
  it("stores private feedback, reloads it, and can clear it", async () => {
    const f = await fixture();
    const [runId] = f.runIds;
    expect(
      (
        await actions.feedback(
          context(f, { body: { feedback: "positive", runId } })
        )
      ).status
    ).toBe(200);
    const response = await reads.history(context(f));
    expect(await response.text()).toContain('"feedback":"positive"');
    const viewerRead = await reads.history(context(f, { cookie: cookies[1] }));
    expect(await viewerRead.text()).not.toContain('"feedback":"positive"');
    expect(
      (await actions.feedback(context(f, { body: { feedback: null, runId } })))
        .status
    ).toBe(200);
    expect(
      (
        await store.listConversationMessages({
          buildSessionId: f.buildSessionId,
          scope: f.scope,
          userId: owner,
        })
      ).find((m) => m.role === "assistant")?.feedback
    ).toBeNull();
  });
  it("replays an accepted retry at its final quota slot without admitting another", async () => {
    const f = await fixture();
    const before = await store.usage.snapshot(organizationId);
    const topUp = PLAN_ENTITLEMENTS.free.runsPerPeriod - before.runs - 1;
    await store.usage.record({ amount: topUp, metric: "runs", organizationId });
    try {
      const key = randomUUID();
      const first = await accepted(await actions.retry(context(f, { key })));
      expect(await accepted(await actions.retry(context(f, { key })))).toEqual(
        first
      );
      expect((await actions.retry(context(f))).status).toBe(429);
    } finally {
      await store.usage.record({
        amount: -topUp,
        metric: "runs",
        organizationId,
      });
    }
  });
  it("rejects stale checkpoint publishers after lease loss or history regeneration", async () => {
    const f = await fixture();
    const replay = await accepted(await actions.retry(context(f)));
    const lease = await store.beginRun({
      holder: "History fixture",
      runId: replay.runId,
      ttlMs: 60_000,
    });
    if (!lease) {
      throw new Error("No fixture lease");
    }
    const [checkpointId] = f.finals;
    if (!checkpointId) {
      throw new Error("No checkpoint");
    }
    await store.history.publish(f.scope, f.buildSessionId, checkpointId, {
      leaseId: lease.leaseId,
      runId: replay.runId,
    });
    await pool.query(
      "update run_leases set expires_at=now()-interval '1 second' where run_id=$1",
      [replay.runId]
    );
    await expect(
      store.history.publish(f.scope, f.buildSessionId, f.finals[1] as string, {
        leaseId: lease.leaseId,
        runId: replay.runId,
      })
    ).rejects.toThrow("no longer owns");
    expect(
      (await store.history.head(f.scope, f.buildSessionId))?.checkpointId
    ).toBe(checkpointId);
  });
});
