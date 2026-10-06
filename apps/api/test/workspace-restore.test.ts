import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { SESSION_COOKIE } from "@reasonateai/contracts/auth";
import type { BuildSessionId } from "@reasonateai/contracts/execution";
import type { WorkspaceRestoreResponse } from "@reasonateai/contracts/execution-protocol";
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
  "workspace checkpoint restore routes",
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
    let sourceDirectory: string;
    let targetDirectory: string;
    let root: string;
    let buildSessionId: BuildSessionId;
    let checkpointId: string;
    let checkpointDigest: string;
    let ownerCookie: string;
    let outsiderCookie: string;
    let handlers: ReturnType<typeof createWorkspaceHandlers>;

    function context(
      body: unknown,
      overrides: {
        cookie?: string;
        session?: string;
        org?: string;
        project?: string;
      } = {}
    ): HandlerContext {
      const query: Record<string, string> = {
        organizationId: overrides.org ?? scope.organizationId,
        projectId: overrides.project ?? scope.projectId,
      };
      return {
        json: (resBody, status) =>
          new Response(JSON.stringify(resBody), {
            headers: { "content-type": "application/json" },
            status,
          }),
        req: {
          header: (name) =>
            name === "cookie" ? (overrides.cookie ?? ownerCookie) : undefined,
          json: async () => body,
          param: () => overrides.session ?? buildSessionId,
          query: (name) => query[name],
        },
      };
    }

    beforeAll(async () => {
      await store.migrate();
      await pool.query(
        "insert into organizations (organization_id, name) values ($1, 'Checkpoint restore test')",
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
      let runId: RunId;
      ({ buildSessionId, runId } = allocation.buildSession);

      sourceDirectory = await mkdtemp(join(tmpdir(), "reasonate-source-"));
      targetDirectory = await mkdtemp(join(tmpdir(), "reasonate-target-"));
      root = await mkdtemp(join(tmpdir(), "reasonate-restore-checkpoints-"));
      const checkpoints = createGitCheckpointStore({ root });

      const sourceSandbox: CheckpointSandbox = {
        runCommand: async (input) => {
          const result = await execFileAsync(input.command, input.args, {
            cwd: sourceDirectory,
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
          await writeFile(join(sourceDirectory, path), content);
        },
      };

      await sourceSandbox.writeFile("app.ts", "console.log('original');\n");
      const snapshot = await snapshotSandbox({
        ...scope,
        baseCommit: null,
        buildSessionId,
        runId,
        sandbox: sourceSandbox,
        store: checkpoints,
      });
      ({ checkpointId, digest: checkpointDigest } = snapshot);

      const targetSandbox: CheckpointSandbox = {
        runCommand: async (input) => {
          const result = await execFileAsync(input.command, input.args, {
            cwd: targetDirectory,
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
          const filePath = join(targetDirectory, path);
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, content);
        },
      };

      handlers = createWorkspaceHandlers({
        checkpoints,
        resolvePrincipal: async ({ cookieHeader }) =>
          await resolveSessionPrincipal({
            cookieHeader,
            sessions: store.sessions,
          }),
        resolveSandbox: () => targetSandbox,
        store: () => store,
      });
    });

    afterAll(async () => {
      await rm(sourceDirectory, { force: true, recursive: true });
      await rm(targetDirectory, { force: true, recursive: true });
      await rm(root, { force: true, recursive: true });
      await pool.end();
    });

    it("rejects unauthenticated caller with 401", async () => {
      const response = await handlers.restore(
        context({ checkpointId }, { cookie: "" })
      );
      expect(response.status).toBe(401);
    });

    it("rejects unauthorized outsider with 403", async () => {
      const response = await handlers.restore(
        context({ checkpointId }, { cookie: outsiderCookie })
      );
      expect(response.status).toBe(403);
    });

    it("rejects invalid request body with 400", async () => {
      const response = await handlers.restore(context({ otherField: "none" }));
      expect(response.status).toBe(400);
    });

    it("returns 404 if checkpoint does not exist", async () => {
      const nonExistent = `${scope.organizationId}/${scope.projectId}/${randomUUID().replaceAll("-", "")}`;
      const response = await handlers.restore(
        context({ checkpointId: nonExistent })
      );
      expect(response.status).toBe(404);
    });

    it("restores checkpoint successfully and appends audit log", async () => {
      const response = await handlers.restore(context({ checkpointId }));
      expect(response.status).toBe(200);

      const json = (await response.json()) as WorkspaceRestoreResponse;
      expect(json.checkpointId).toBe(checkpointId);
      expect(json.digest).toBeDefined();
      expect(json.restoredAt).toBeDefined();

      const auditResult = await pool.query<{ action: string }>(
        `select action from audit_events
         where organization_id = $1 and project_id = $2
           and action = 'checkpoint.restored' limit 1`,
        [scope.organizationId, scope.projectId]
      );
      expect(auditResult.rowCount).toBe(1);
      expect(auditResult.rows[0]?.action).toBe("checkpoint.restored");
    });

    it("restores checkpoint via checkpointDigest successfully", async () => {
      const response = await handlers.restore(context({ checkpointDigest }));
      expect(response.status).toBe(200);

      const json = (await response.json()) as WorkspaceRestoreResponse;
      expect(json.checkpointId).toBe(checkpointId);
      expect(json.digest).toBe(checkpointDigest);
      expect(json.restoredAt).toBeDefined();
    });

    it("restores checkpoint via slash-formatted checkpointId successfully", async () => {
      const slashFormatted = `${scope.organizationId}/${scope.projectId}/${checkpointDigest}`;
      const response = await handlers.restore(
        context({ checkpointId: slashFormatted })
      );
      expect(response.status).toBe(200);

      const json = (await response.json()) as WorkspaceRestoreResponse;
      expect(json.checkpointId).toBe(checkpointId);
      expect(json.digest).toBe(checkpointDigest);
    });

    it("rejects cross-tenant checkpoint restore attempt with 404", async () => {
      const otherOrg = randomUUID();
      const otherProj = randomUUID();
      const crossTenantId = `${otherOrg}.${otherProj}.${checkpointDigest}`;
      const response = await handlers.restore(
        context({ checkpointId: crossTenantId })
      );
      expect(response.status).toBe(404);
    });
  }
);
