import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { mintCsrfToken } from "@reasonateai/auth/csrf";
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_COOKIE,
} from "@reasonateai/contracts/auth";
import type { BuildSessionId } from "@reasonateai/contracts/execution";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
  type RunId,
  type SessionId,
  UserIdSchema,
  type UserPrincipal,
} from "@reasonateai/contracts/identity";
import type { ProjectStateStore } from "@reasonateai/project-state/postgres";
import { createGitCheckpointStore } from "@reasonateai/sandbox/checkpoint";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HandlerContext } from "../src/mastra/routes/build-sessions";
import {
  createWorkspaceHandlers,
  WORKSPACE_EXPORT_PATH,
} from "../src/mastra/routes/workspace";

const execFileAsync = promisify(execFile);

describe("workspace source export route", () => {
  const organizationId = OrganizationIdSchema.parse(randomUUID());
  const projectId = ProjectIdSchema.parse(randomUUID());
  const buildSessionId = randomUUID() as BuildSessionId;
  const runId = randomUUID() as RunId;
  const ownerId = UserIdSchema.parse(randomUUID());
  const outsiderId = UserIdSchema.parse(randomUUID());

  const ownerSessionId = "session-owner" as SessionId;
  const outsiderSessionId = "session-outsider" as SessionId;
  const ownerCookie = `${SESSION_COOKIE}=token-owner`;
  const outsiderCookie = `${SESSION_COOKIE}=token-outsider`;
  const validCsrf = "csrf-token-123";

  const ownerPrincipal: UserPrincipal = {
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    kind: "user",
    revokedAt: null,
    sessionId: ownerSessionId,
    userId: ownerId,
  };

  const outsiderPrincipal: UserPrincipal = {
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    kind: "user",
    revokedAt: null,
    sessionId: outsiderSessionId,
    userId: outsiderId,
  };

  let tempDir: string;
  let checkpointRoot: string;
  let checkpointStore: ReturnType<typeof createGitCheckpointStore>;
  let handlers: ReturnType<typeof createWorkspaceHandlers>;
  let emptyHandlers: ReturnType<typeof createWorkspaceHandlers>;

  const mockStore = {
    getBuildSession: (_scope: unknown, sessionId: string) => {
      if (sessionId === buildSessionId) {
        return Promise.resolve({
          buildSessionId,
          createdAt: new Date().toISOString(),
          organizationId,
          projectId,
          status: "ready",
          updatedAt: new Date().toISOString(),
        } as never);
      }
      return Promise.resolve(null);
    },
    history: {
      head: () => Promise.resolve(null),
    } as never,
    memberships: {
      getOrganizationMembership: ({
        userId,
        organizationId: orgId,
      }: {
        userId: string;
        organizationId: string;
      }) => {
        if (userId === ownerId && orgId === organizationId) {
          return Promise.resolve({
            createdAt: new Date().toISOString(),
            organizationId,
            role: "builder",
            status: "active",
            updatedAt: new Date().toISOString(),
            userId: ownerId,
          });
        }
        return Promise.resolve(null);
      },
      getProjectMembership: ({
        userId,
        projectId: projId,
      }: {
        userId: string;
        projectId: string;
      }) => {
        if (userId === ownerId && projId === projectId) {
          return Promise.resolve({
            createdAt: new Date().toISOString(),
            organizationId,
            projectId,
            role: "builder",
            status: "active",
            updatedAt: new Date().toISOString(),
            userId: ownerId,
          });
        }
        return Promise.resolve(null);
      },
    } as never,
  } as unknown as ProjectStateStore;

  function makeContext(
    options: {
      cookie?: string | null;
      csrfHeader?: string | null | undefined;
      csrfCookie?: string | null | undefined;
      sessionId?: string;
      query?: Record<string, string>;
      customHeaders?: Record<string, string>;
    } = {}
  ): HandlerContext {
    const cookie =
      options.cookie === null ? undefined : (options.cookie ?? ownerCookie);
    const csrfHeader =
      options.csrfHeader === null
        ? undefined
        : (options.csrfHeader ?? validCsrf);
    const csrfCookie =
      options.csrfCookie === null
        ? undefined
        : (options.csrfCookie ?? validCsrf);
    const sessionId = options.sessionId ?? buildSessionId;
    const query = options.query ?? {};
    const customHeaders = options.customHeaders ?? {};

    const fullQuery: Record<string, string> = {
      organizationId,
      projectId,
      ...query,
    };

    let cookieHeaderValue: string | undefined;
    if (cookie) {
      cookieHeaderValue = csrfCookie
        ? `${cookie}; ${CSRF_COOKIE}=${csrfCookie}`
        : cookie;
    }

    const headers: Record<string, string | undefined> = {
      cookie: cookieHeaderValue,
      ...(csrfHeader ? { [CSRF_HEADER]: csrfHeader } : {}),
      "x-request-id": randomUUID(),
      ...customHeaders,
    };

    return {
      json: (body, status) =>
        new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
          status,
        }),
      req: {
        header: (name) => headers[name.toLowerCase()],
        json: async () => undefined,
        param: (name) => (name === "buildSessionId" ? sessionId : undefined),
        query: (name) => fullQuery[name],
      },
    };
  }

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "reasonate-export-test-"));
    checkpointRoot = join(tempDir, "checkpoints");
    checkpointStore = createGitCheckpointStore({ root: checkpointRoot });

    // Create a real git repository with valid source files AND excluded files
    const workDir = join(tempDir, "git-work");
    await execFileAsync("git", ["init", workDir]);
    await execFileAsync("git", [
      "-C",
      workDir,
      "config",
      "user.name",
      "Test User",
    ]);
    await execFileAsync("git", [
      "-C",
      workDir,
      "config",
      "user.email",
      "test@example.com",
    ]);

    // Source files
    await writeFile(
      join(workDir, "package.json"),
      JSON.stringify({ name: "my-app", version: "1.0.0" })
    );
    await execFileAsync("mkdir", ["-p", join(workDir, "src")]);
    await writeFile(
      join(workDir, "src", "index.ts"),
      "console.log('ReasonateAI');\n"
    );
    await writeFile(join(workDir, "README.md"), "# Test App\n");

    // Files that MUST be excluded from export
    await execFileAsync("mkdir", [
      "-p",
      join(workDir, "node_modules", "some-dep"),
    ]);
    await writeFile(
      join(workDir, "node_modules", "some-dep", "index.js"),
      "module.exports = {};\n"
    );
    await execFileAsync("mkdir", ["-p", join(workDir, ".cache")]);
    await writeFile(join(workDir, ".cache", "build-cache.json"), "{}");
    await execFileAsync("mkdir", ["-p", join(workDir, "dist")]);
    await writeFile(join(workDir, "dist", "bundle.js"), "bundled code");
    await execFileAsync("mkdir", ["-p", join(workDir, ".next")]);
    await writeFile(join(workDir, ".next", "manifest.json"), "{}");

    await execFileAsync("git", ["-C", workDir, "add", "-f", "."]);
    await execFileAsync("git", [
      "-C",
      workDir,
      "commit",
      "-m",
      "Initial commit",
    ]);

    // Create a git bundle from this repository
    const bundleFile = join(tempDir, "test.bundle");
    await execFileAsync("git", [
      "-C",
      workDir,
      "bundle",
      "create",
      bundleFile,
      "HEAD",
    ]);
    const bundleContent = await readFile(bundleFile);

    // Write the bundle to checkpointStore
    await checkpointStore.write({
      buildSessionId,
      content: bundleContent,
      organizationId,
      projectId,
      runId,
    });

    handlers = createWorkspaceHandlers({
      checkpoints: checkpointStore,
      resolvePrincipal: ({ cookieHeader }) => {
        if (!cookieHeader) {
          return Promise.resolve(undefined);
        }
        if (cookieHeader.includes("token-owner")) {
          return Promise.resolve(ownerPrincipal);
        }
        if (cookieHeader.includes("token-outsider")) {
          return Promise.resolve(outsiderPrincipal);
        }
        return Promise.resolve(undefined);
      },
      store: () => mockStore,
    });

    const emptyStoreRoot = join(tempDir, "empty-checkpoints");
    const emptyCheckpointStore = createGitCheckpointStore({
      root: emptyStoreRoot,
    });
    emptyHandlers = createWorkspaceHandlers({
      checkpoints: emptyCheckpointStore,
      resolvePrincipal: ({ cookieHeader }) => {
        if (!cookieHeader) {
          return Promise.resolve(undefined);
        }
        if (cookieHeader.includes("token-owner")) {
          return Promise.resolve(ownerPrincipal);
        }
        return Promise.resolve(undefined);
      },
      store: () => mockStore,
    });
  });

  afterAll(async () => {
    if (tempDir) {
      await rm(tempDir, { force: true, recursive: true }).catch(
        () => undefined
      );
    }
  });

  it("exports endpoint path constant as /v1/build-sessions/:buildSessionId/workspace/export", () => {
    expect(WORKSPACE_EXPORT_PATH).toBe(
      "/v1/build-sessions/:buildSessionId/workspace/export"
    );
  });

  it("returns 401 unauthenticated when no session cookie is provided", async () => {
    const ctx = makeContext({ cookie: null });
    const response = await handlers.export(ctx);

    expect(response.status).toBe(401);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("unauthenticated");
  });

  it("returns 403 forbidden when user lacks authorization for the project", async () => {
    const ctx = makeContext({ cookie: outsiderCookie });
    const response = await handlers.export(ctx);

    expect(response.status).toBe(403);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("forbidden");
  });

  it("returns 403 forbidden when CSRF cookie is present but CSRF header is mismatched or missing", async () => {
    // Missing header
    const missingHeaderCtx = makeContext({
      csrfCookie: "secret-csrf",
      csrfHeader: null,
    });
    const res1 = await handlers.export(missingHeaderCtx);
    expect(res1.status).toBe(403);
    const body1 = (await res1.json()) as {
      error: { code: string; message: string };
    };
    expect(body1.error.code).toBe("forbidden");
    expect(body1.error.message).toContain("CSRF");

    // Mismatched header
    const mismatchCtx = makeContext({
      csrfCookie: "secret-csrf",
      csrfHeader: "wrong-csrf",
    });
    const res2 = await handlers.export(mismatchCtx);
    expect(res2.status).toBe(403);
    const body2 = (await res2.json()) as {
      error: { code: string; message: string };
    };
    expect(body2.error.code).toBe("forbidden");
  });

  it("returns 403 forbidden when CSRF cookie is missing or both CSRF tokens are absent", async () => {
    // Missing CSRF cookie
    const missingCookieCtx = makeContext({
      csrfCookie: null,
      csrfHeader: validCsrf,
    });
    const res1 = await handlers.export(missingCookieCtx);
    expect(res1.status).toBe(403);
    const body1 = (await res1.json()) as {
      error: { code: string; message: string };
    };
    expect(body1.error.code).toBe("forbidden");

    // Both CSRF cookie and header missing
    const missingBothCtx = makeContext({
      csrfCookie: null,
      csrfHeader: null,
    });
    const res2 = await handlers.export(missingBothCtx);
    expect(res2.status).toBe(403);
    const body2 = (await res2.json()) as {
      error: { code: string; message: string };
    };
    expect(body2.error.code).toBe("forbidden");
  });

  it("verifies cryptographic CSRF token against sessionId when csrfSecret is configured", async () => {
    const testSecret = "super-secret-csrf-key";
    const cryptoHandlers = createWorkspaceHandlers({
      checkpoints: checkpointStore,
      csrfSecret: () => testSecret,
      resolvePrincipal: () => Promise.resolve(ownerPrincipal),
      store: () => mockStore,
    });

    const validCryptoToken = mintCsrfToken({
      secret: testSecret,
      sessionId: ownerSessionId,
    });

    // Valid minted token succeeds
    const successCtx = makeContext({
      csrfCookie: validCryptoToken,
      csrfHeader: validCryptoToken,
    });
    const successRes = await cryptoHandlers.export(successCtx);
    expect(successRes.status).toBe(200);

    // Tampered token fails
    const tamperedCtx = makeContext({
      csrfCookie: "tampered-token",
      csrfHeader: "tampered-token",
    });
    const failRes = await cryptoHandlers.export(tamperedCtx);
    expect(failRes.status).toBe(403);
  });

  it("returns 404 when build session does not exist in store", async () => {
    const ctx = makeContext({ sessionId: randomUUID() });
    const response = await handlers.export(ctx);

    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("not_found");
  });

  it("returns 200 with valid empty zip archive for unpopulated workspace", async () => {
    const ctx = makeContext({ query: { projectName: "Empty Project" } });
    const response = await emptyHandlers.export(ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="empty-project-source.zip"'
    );

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    expect(buffer.length).toBe(22);
    expect(buffer[0]).toBe(0x50);
    expect(buffer[1]).toBe(0x4b);
    expect(buffer[2]).toBe(0x05);
    expect(buffer[3]).toBe(0x06);
  });

  it("returns 200 with standard ZIP stream and filters out .git, node_modules, .cache, and build artifacts", async () => {
    const ctx = makeContext({ query: { projectName: "Super App 2026!" } });
    const response = await handlers.export(ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="super-app-2026-source.zip"'
    );

    const arrayBuffer = await response.arrayBuffer();
    const zipBuffer = Buffer.from(arrayBuffer);

    // Standard zip magic bytes (PK\x03\x04)
    expect(zipBuffer.subarray(0, 4)).toEqual(
      Buffer.from([0x50, 0x4b, 0x03, 0x04])
    );

    // Write zip to a temporary file and verify using unzip tool
    const zipPath = join(tempDir, "extracted-check.zip");
    await writeFile(zipPath, zipBuffer);

    const { stdout: unzipListing } = await execFileAsync("unzip", [
      "-l",
      zipPath,
    ]);

    // Source files MUST be present
    expect(unzipListing).toContain("package.json");
    expect(unzipListing).toContain("src/index.ts");
    expect(unzipListing).toContain("README.md");

    // Excluded files and folders MUST NOT be present
    expect(unzipListing).not.toContain(".git");
    expect(unzipListing).not.toContain("node_modules");
    expect(unzipListing).not.toContain(".cache");
    expect(unzipListing).not.toContain("dist");
    expect(unzipListing).not.toContain(".next");
  });

  it("sanitizes projectName preventing path traversal or special character injection in filename", async () => {
    const ctx = makeContext({
      query: { projectName: "../../../etc/passwd\r\nX-Injected: evil" },
    });
    const response = await handlers.export(ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="etc-passwd-x-injected-evil-source.zip"'
    );
  });
});
