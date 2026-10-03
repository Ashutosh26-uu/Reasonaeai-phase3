import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SESSION_COOKIE } from "@reasonateai/contracts/auth";
import type { BuildSessionId } from "@reasonateai/contracts/execution";
import {
  CheckpointDiffSchema,
  type RunEventEnvelope,
} from "@reasonateai/contracts/execution-protocol";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
  type RunId,
  UserIdSchema,
} from "@reasonateai/contracts/identity";
import { createProjectStateStore } from "@reasonateai/project-state/postgres";
import {
  type CheckpointSandbox,
  createGitCheckpointStore,
  snapshotSandbox,
} from "@reasonateai/sandbox/checkpoint";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveSessionPrincipal } from "../src/mastra/principal";
import type { HandlerContext } from "../src/mastra/routes/build-sessions";
import { createWorkspaceHandlers } from "../src/mastra/routes/workspace";

const execFileAsync = promisify(execFile);
const connectionString = process.env.DATABASE_URL;
const shellAvailable = await execFileAsync("sh", [
  "-c",
  "git --version > /dev/null && command -v base64 > /dev/null",
]).then(
  () => true,
  () => false
);

describe.skipIf(!(connectionString && shellAvailable))(
  "saved checkpoint diff routes",
  () => {
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
    let directory: string;
    let root: string;
    let buildSessionId: BuildSessionId;
    let otherSessionId: BuildSessionId;
    let runId: RunId;
    let ownerCookie: string;
    let outsiderCookie: string;
    let firstEvent: RunEventEnvelope;
    let savedEvent: RunEventEnvelope;
    let legacyEvent: RunEventEnvelope;
    let handlers: ReturnType<typeof createWorkspaceHandlers>;

    function context(
      path: string,
      overrides: {
        cookie?: string;
        session?: string;
        sequence?: number;
        run?: string;
      } = {}
    ): HandlerContext {
      const query: Record<string, string> = {
        ...scope,
        path,
        runId: overrides.run ?? runId,
        sequence: String(overrides.sequence ?? savedEvent.sequence),
      };
      return {
        json: (body, status) =>
          new Response(JSON.stringify(body), {
            headers: { "content-type": "application/json" },
            status,
          }),
        req: {
          header: (name) =>
            name === "cookie" ? (overrides.cookie ?? ownerCookie) : undefined,
          json: async () => undefined,
          param: () => overrides.session ?? buildSessionId,
          query: (name) => query[name],
        },
      };
    }

    beforeAll(async () => {
      await store.migrate();
      await pool.query(
        "insert into organizations (organization_id, name) values ($1, 'Checkpoint diff test')",
        [scope.organizationId]
      );
      await pool.query(
        "insert into projects (project_id, organization_id, name) values ($1, $2, 'Source')",
        [scope.projectId, scope.organizationId]
      );
      await pool.query(
        "insert into users (user_id) select unnest($1::uuid[])",
        [[owner, outsider]]
      );
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
      const ownerSession = await store.sessions.createSession({
        absoluteTtlMs: 3_600_000,
        idleTtlMs: 3_600_000,
        userId: owner,
      });
      const outsiderSession = await store.sessions.createSession({
        absoluteTtlMs: 3_600_000,
        idleTtlMs: 3_600_000,
        userId: outsider,
      });
      ownerCookie = `${SESSION_COOKIE}=${ownerSession.token}`;
      outsiderCookie = `${SESSION_COOKIE}=${outsiderSession.token}`;
      const allocation = await store.allocateBuildSession({
        idempotencyKey: randomUUID(),
        scope,
        userSessionId: ownerSession.session.sessionId,
      });
      ({ buildSessionId, runId } = allocation.buildSession);
      const other = await store.allocateBuildSession({
        idempotencyKey: randomUUID(),
        scope,
        userSessionId: ownerSession.session.sessionId,
      });
      otherSessionId = other.buildSession.buildSessionId;
      directory = await mkdtemp(join(tmpdir(), "reasonate-diff-source-"));
      root = await mkdtemp(join(tmpdir(), "reasonate-diff-checkpoints-"));
      const checkpoints = createGitCheckpointStore({ root });
      const sandbox: CheckpointSandbox = {
        runCommand: async (input) => {
          const result = await execFileAsync(input.command, input.args, {
            cwd: directory,
            env: { ...process.env, ...input.env },
            maxBuffer: 8 * 1024 * 1024,
          });
          return {
            durationMs: 0,
            exitCode: 0,
            stderr: String(result.stderr),
            stdout: String(result.stdout),
            timedOut: false,
          };
        },
        writeFile: async (path, content) => {
          await writeFile(join(directory, path), content);
        },
      };
      const snapshotInput = {
        ...scope,
        buildSessionId,
        runId,
        sandbox,
        store: checkpoints,
      };
      await sandbox.writeFile("old.txt", "one\ntwo\n");
      await sandbox.writeFile("deleted.txt", "gone\n");
      const first = await snapshotSandbox({
        ...snapshotInput,
        baseCommit: null,
      });
      if (first.checkpoint?.status !== "available") {
        throw new Error("First snapshot has no diff");
      }
      firstEvent = await store.appendRunEvent({
        payload: {
          checkpoint: first.checkpoint,
          checkpointId: first.checkpointId,
          outcome: "succeeded",
        },
        runId,
        scope,
        type: "run.completed",
      });
      await rm(join(directory, "old.txt"));
      await rm(join(directory, "deleted.txt"));
      await sandbox.writeFile("renamed.txt", "one\ntwo\n");
      await sandbox.writeFile("literal[1].txt", "literal\n");
      await sandbox.writeFile("literal1.txt", "other file\n");
      await sandbox.writeFile("image.bin", new Uint8Array([0, 255, 1]));
      await sandbox.writeFile("large.txt", `${"x".repeat(300_000)}\n`);
      const next = await snapshotSandbox({
        ...snapshotInput,
        baseCommit: first.checkpoint.commit,
      });
      if (next.checkpoint?.status !== "available") {
        throw new Error("Follow-up snapshot has no diff");
      }
      savedEvent = await store.appendRunEvent({
        payload: {
          checkpoint: next.checkpoint,
          checkpointId: next.checkpointId,
          outcome: "succeeded",
        },
        runId,
        scope,
        type: "run.completed",
      });
      legacyEvent = await store.appendRunEvent({
        payload: { checkpointId: first.checkpointId, outcome: "succeeded" },
        runId,
        scope,
        type: "run.completed",
      });
      handlers = createWorkspaceHandlers({
        checkpoints,
        resolvePrincipal: async ({ cookieHeader }) =>
          await resolveSessionPrincipal({
            cookieHeader,
            sessions: store.sessions,
          }),
        store: () => store,
      });
    }, 30_000);

    afterAll(async () => {
      await pool.query("delete from organizations where organization_id = $1", [
        scope.organizationId,
      ]);
      await pool.query("delete from users where user_id = any($1::uuid[])", [
        [owner, outsider],
      ]);
      await store.close();
      await pool.end();
      if (directory) {
        await rm(directory, { force: true, recursive: true });
      }
      if (root) {
        await rm(root, { force: true, recursive: true });
      }
    });

    it("reads the exact historical checkpoint instead of the latest project source", async () => {
      const response = await handlers.checkpointDiff(
        context("old.txt", { sequence: firstEvent.sequence })
      );
      expect(response.status).toBe(200);
      const diff = CheckpointDiffSchema.parse(await response.json());
      expect(diff.patch).toContain("+one");
      expect(diff.patch).toContain("+two");
      expect(diff.checkpointId).toBe(firstEvent.payload.checkpointId);
    });
    it("shows deletion and rename details using immutable before/after commits", async () => {
      const deletion = await handlers.checkpointDiff(context("deleted.txt"));
      expect(CheckpointDiffSchema.parse(await deletion.json()).patch).toContain(
        "-gone"
      );
      const rename = await handlers.checkpointDiff(context("renamed.txt"));
      expect(CheckpointDiffSchema.parse(await rename.json()).patch).toContain(
        "rename from old.txt"
      );
    });
    it("treats filenames as literal paths rather than Git glob patterns", async () => {
      const response = await handlers.checkpointDiff(context("literal[1].txt"));
      const diff = CheckpointDiffSchema.parse(await response.json());
      expect(diff.patch).toContain("+literal");
      expect(diff.patch).not.toContain("other file");
    });
    it("reports binary and oversized diffs without partial content", async () => {
      const binary = await handlers.checkpointDiff(context("image.bin"));
      expect(CheckpointDiffSchema.parse(await binary.json())).toMatchObject({
        binary: true,
        patch: "",
      });
      const large = await handlers.checkpointDiff(context("large.txt"));
      expect(CheckpointDiffSchema.parse(await large.json())).toMatchObject({
        binary: false,
        patch: "",
        unavailable: "oversized",
      });
    });
    it("denies nonmembers and mismatched session/run combinations", async () => {
      expect(
        (
          await handlers.checkpointDiff(
            context("renamed.txt", { cookie: outsiderCookie })
          )
        ).status
      ).toBe(403);
      expect(
        (
          await handlers.checkpointDiff(
            context("renamed.txt", { session: otherSessionId })
          )
        ).status
      ).toBe(404);
      expect(
        (
          await handlers.checkpointDiff(
            context("renamed.txt", { run: randomUUID() })
          )
        ).status
      ).toBe(404);
    });
    it("rejects traversal and withheld paths before executing Git", async () => {
      for (const path of [
        "../outside",
        "C:\\outside",
        ".git/config",
        ".reasonate/checkpoint.bundle",
        "node_modules/package.json",
      ]) {
        // biome-ignore lint/performance/noAwaitInLoops: each denial exercises the route independently
        expect((await handlers.checkpointDiff(context(path))).status).toBe(400);
      }
    });
    it("reports legacy checkpoints and files outside a turn's changes as unavailable", async () => {
      expect(
        (
          await handlers.checkpointDiff(
            context("old.txt", { sequence: legacyEvent.sequence })
          )
        ).status
      ).toBe(404);
      expect(
        (await handlers.checkpointDiff(context("not-recorded.txt"))).status
      ).toBe(404);
    });
  }
);
