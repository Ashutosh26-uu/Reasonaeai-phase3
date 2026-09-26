import { randomUUID } from "node:crypto";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
  SessionIdSchema,
  UserIdSchema,
} from "@reasonateai/contracts/identity";
import { describe, expect, it } from "vitest";

process.env.SANDBOX_MODE = "mock";

import {
  createCheckpointHandlers,
  type HandlerContext,
} from "../src/mastra/routes/checkpoints.js";
import { createDeploymentHandlers } from "../src/mastra/routes/deployments.js";
import { createEvidenceHandlers } from "../src/mastra/routes/evidence.js";
import { createPreviewHandlers } from "../src/mastra/routes/previews.js";

const organizationId = OrganizationIdSchema.parse(randomUUID());
const projectId = ProjectIdSchema.parse(randomUUID());
const userId = UserIdSchema.parse(randomUUID());
const sessionId = SessionIdSchema.parse(randomUUID());
const now = new Date().toISOString();

const mockUserPrincipal = {
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  kind: "user" as const,
  revokedAt: null,
  sessionId,
  userId,
};

function context(input: {
  body?: unknown;
  cookie?: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
  requestId?: string;
}): HandlerContext {
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
          return input.cookie ?? "reasonate_session=valid";
        }
        if (key === "x-request-id") {
          return input.requestId ?? "req-test-123";
        }
      },
      json: async () => input.body,
      param: (name) => input.params?.[name],
      query: (name) => input.query?.[name],
    },
  };
}

describe("product API route handlers", () => {
  const testPreviewsMap = new Map<string, any>();

  const mockStore: any = {
    allocateBuildSession: async () => ({
      buildSession: {
        buildSessionId: randomUUID(),
        createdAt: now,
        organizationId,
        projectId,
        runId: randomUUID(),
        sandboxEnvironmentId: randomUUID(),
        stage: "intake",
        status: "ready",
        updatedAt: now,
        userSessionId: sessionId,
      },
      created: true,
      sandbox: {
        buildSessionId: randomUUID(),
        createdAt: now,
        organizationId,
        projectId,
        sandboxEnvironmentId: randomUUID(),
        status: "ready",
        updatedAt: now,
        workspaceUri: "sandbox://test/workspace",
      },
    }),
    appendRunEvent: async () => ({}),
    createPreview: (input: Record<string, any>) => {
      const previewId = randomUUID();
      const preview = {
        buildSessionId: input.buildSessionId,
        createdAt: now,
        errorDetails: input.errorDetails ?? null,
        expiresAt: input.expiresAt,
        healthUrl: input.healthUrl ?? null,
        organizationId: input.scope.organizationId,
        port: input.port,
        previewId,
        projectId: input.scope.projectId,
        proxyUrl: input.proxyUrl ?? null,
        sandboxEnvironmentId: input.sandboxEnvironmentId,
        sandboxId: input.sandboxId,
        status: input.status,
        updatedAt: now,
      };
      testPreviewsMap.set(previewId, preview);
      return Promise.resolve(preview);
    },
    getBuildSession: async () => ({
      buildSessionId: randomUUID(),
      createdAt: now,
      organizationId,
      projectId,
      runId: randomUUID(),
      sandboxEnvironmentId: randomUUID(),
      stage: "intake",
      status: "ready",
      updatedAt: now,
      userSessionId: sessionId,
    }),
    getCheckpoint: async (scope: any, checkpointId: string) => ({
      author: "CTO Agent",
      buildSessionId: randomUUID(),
      checkpointId,
      commitHash: "1".repeat(40),
      message: "Test commit",
      occurredAt: now,
      organizationId: scope.organizationId,
      parentHash: null,
      projectId: scope.projectId,
      runId: randomUUID(),
    }),
    getDeployment: async (_scope: unknown, id: string) => ({
      deploymentId: id,
      exposure: "public",
      providerReference: "ref-1",
      rollbackDeploymentId: null,
      sourceCheckpoint: "1".repeat(40),
      status: "ready",
      updatedAt: now,
      url: "https://test.example.com",
    }),
    getEvidence: async () => undefined,
    getPreview: async (scope: any, previewId: string) =>
      testPreviewsMap.get(previewId) ?? {
        buildSessionId: randomUUID(),
        createdAt: now,
        errorDetails: null,
        expiresAt: now,
        healthUrl: "http://localhost:3000/health",
        organizationId: scope.organizationId,
        port: 3000,
        previewId,
        projectId: scope.projectId,
        proxyUrl: null,
        sandboxEnvironmentId: randomUUID(),
        sandboxId: "sb-1",
        status: "ready",
        updatedAt: now,
      },
    listActivePreviews: async () => Array.from(testPreviewsMap.values()),
    listArtifacts: async () => [
      {
        artifactId: "00000000-0000-4000-8000-000000000099",
        createdAt: now,
        kind: "screenshot",
        manifestObjectKey: "manifest.json",
        sha256: "a".repeat(64),
        status: "completed",
        totalSize: 512,
      },
    ],
    listCheckpoints: async () => [],
    listDeployments: async () => [],
    listEvidence: async () => [
      {
        artifactId: "00000000-0000-4000-8000-000000000099",
        buildSessionId: randomUUID(),
        createdAt: now,
        evidenceId: randomUUID(),
        kind: "screenshot",
        metadata: {},
        organizationId,
        projectId,
        runId: randomUUID(),
        status: "passed",
        summary: "Visual pass",
      },
    ],
    memberships: {
      getOrganizationMembership: async () => ({
        organizationId,
        role: "builder",
        status: "active",
        userId,
      }),
      getProjectMembership: async () => ({
        organizationId,
        projectId,
        role: "builder",
        status: "active",
        userId,
      }),
    },
    recordCheckpoint: async (input: any) => ({
      author: input.author,
      buildSessionId: input.buildSessionId,
      checkpointId: randomUUID(),
      commitHash: input.commitHash,
      message: input.message,
      occurredAt: now,
      organizationId: input.scope.organizationId,
      parentHash: input.parentHash ?? null,
      projectId: input.scope.projectId,
      runId: input.runId,
    }),
    recordDeployment: async (input: any) => ({
      deploymentId: input.deploymentId,
      exposure: input.exposure,
      providerReference: input.providerReference,
      rollbackDeploymentId: null,
      sourceCheckpoint: input.sourceCheckpoint,
      status: input.status,
      updatedAt: now,
      url: input.url,
    }),
    rollbackDeployment: async (input: any) => ({
      activeDeployment: {
        deploymentId: input.deploymentId,
        exposure: "public",
        providerReference: "cloud-run",
        rollbackDeploymentId: input.targetDeploymentId,
        sourceCheckpoint: "1".repeat(40),
        status: "rolled_back",
        updatedAt: now,
        url: null,
      },
      rolledBackDeployment: {
        deploymentId: input.targetDeploymentId,
        exposure: "public",
        providerReference: "cloud-run",
        rollbackDeploymentId: null,
        sourceCheckpoint: "1".repeat(40),
        status: "ready",
        updatedAt: now,
        url: "https://v1.example.com",
      },
    }),
    updatePreviewStatus: (input: Record<string, any>) => {
      const existing = testPreviewsMap.get(input.previewId) ?? {};
      const updated = {
        ...existing,
        buildSessionId: existing.buildSessionId ?? randomUUID(),
        createdAt: existing.createdAt ?? now,
        errorDetails:
          input.errorDetails === undefined
            ? (existing.errorDetails ?? null)
            : input.errorDetails,
        expiresAt: existing.expiresAt ?? now,
        healthUrl:
          input.healthUrl === undefined
            ? (existing.healthUrl ?? null)
            : input.healthUrl,
        organizationId: input.scope.organizationId,
        port: existing.port ?? input.port ?? 3000,
        previewId: input.previewId,
        projectId: input.scope.projectId,
        proxyUrl:
          input.proxyUrl === undefined
            ? (existing.proxyUrl ?? null)
            : input.proxyUrl,
        sandboxEnvironmentId: existing.sandboxEnvironmentId ?? randomUUID(),
        sandboxId: existing.sandboxId ?? "sb-1",
        status: input.status,
        updatedAt: now,
      };
      testPreviewsMap.set(input.previewId, updated);
      return Promise.resolve(updated);
    },
  };

  const deps = {
    resolvePrincipal: async () => mockUserPrincipal,
    store: () => mockStore,
  };

  const unauthDeps = {
    resolvePrincipal: async () => undefined,
    store: () => mockStore,
  };

  describe("checkpoints handlers", () => {
    const handlers = createCheckpointHandlers(deps);
    const unauthHandlers = createCheckpointHandlers(unauthDeps);

    it("rejects unauthenticated requests", async () => {
      const res = await unauthHandlers.create(
        context({ params: { buildSessionId: randomUUID() } })
      );
      expect(res.status).toBe(401);
    });

    it("creates a checkpoint successfully", async () => {
      const buildSessionId = randomUUID();
      const res = await handlers.create(
        context({
          body: {
            author: "CTO Agent",
            commitHash: "1".repeat(40),
            message: "Initial commit",
            organizationId,
            projectId,
          },
          params: { buildSessionId },
        })
      );
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.checkpoint.commitHash).toBe("1".repeat(40));
    });

    it("lists checkpoints", async () => {
      const res = await handlers.list(
        context({
          params: { buildSessionId: randomUUID() },
          query: { organizationId, projectId },
        })
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data.checkpoints)).toBe(true);
    });

    it("restores a checkpoint", async () => {
      const checkpointId = randomUUID();
      const res = await handlers.restore(
        context({
          body: { organizationId, projectId },
          params: { checkpointId },
        })
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.restored).toBe(true);
    });
  });

  describe("previews handlers", () => {
    const handlers = createPreviewHandlers(deps);

    it("creates/allocates a preview session and returns 202 Accepted", async () => {
      const res = await handlers.create(
        context({
          body: {
            organizationId,
            port: 3000,
            projectId,
            sandboxEnvironmentId: randomUUID(),
            sandboxId: "sb-test",
          },
          params: { buildSessionId: randomUUID() },
        })
      );
      expect(res.status).toBe(202);
      const data = await res.json();
      expect(data.preview.port).toBe(3000);
      expect(data.preview.status).toBe("ready");
    });

    it("returns 202 Accepted with status=failed and FailureDetails on failed health check without HTTP 500", async () => {
      const customStore = {
        ...mockStore,
        listActivePreviews: async () => [],
      };
      const customDeps = {
        resolvePrincipal: async () => mockUserPrincipal,
        store: () => customStore,
      };
      const customHandlers = createPreviewHandlers(customDeps);

      const res = await customHandlers.create(
        context({
          body: {
            organizationId,
            port: 9999,
            projectId,
          },
          params: { buildSessionId: randomUUID() },
        })
      );

      expect(res.status).toBe(202);
      const data = await res.json();
      expect(data.preview.port).toBe(9999);
    });

    it("GET /v1/previews/:previewId returns HTTP 200 even when status is failed", async () => {
      const failedPreviewId = randomUUID();
      const customStore = {
        ...mockStore,
        getPreview: async (
          scope: { organizationId: string; projectId: string },
          _previewId: string
        ) => ({
          buildSessionId: randomUUID(),
          createdAt: now,
          errorDetails: {
            code: "HEALTH_CHECK_FAILED",
            message: "No service listening on port 3000",
            occurredAt: now,
            recoverable: true,
            stack: null,
            step: "health_check",
          },
          expiresAt: now,
          healthUrl: null,
          organizationId: scope.organizationId,
          port: 3000,
          previewId: failedPreviewId,
          projectId: scope.projectId,
          proxyUrl: null,
          sandboxEnvironmentId: randomUUID(),
          sandboxId: "sb-failed",
          status: "failed",
          updatedAt: now,
        }),
      };
      const customDeps = {
        resolvePrincipal: async () => mockUserPrincipal,
        store: () => customStore,
      };
      const customHandlers = createPreviewHandlers(customDeps);

      const res = await customHandlers.get(
        context({
          params: { previewId: failedPreviewId },
          query: { organizationId, projectId },
        })
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.preview.previewId).toBe(failedPreviewId);
      expect(data.preview.status).toBe("failed");
      expect(data.preview.errorDetails?.code).toBe("HEALTH_CHECK_FAILED");
    });

    it("reserves HTTP 500 for unexpected internal errors", async () => {
      const customStore = {
        ...mockStore,
        getBuildSession: () => {
          throw new Error("Unexpected database failure");
        },
      };
      const customDeps = {
        resolvePrincipal: async () => mockUserPrincipal,
        store: () => customStore,
      };
      const customHandlers = createPreviewHandlers(customDeps);

      const res = await customHandlers.create(
        context({
          body: {
            organizationId,
            port: 3000,
            projectId,
          },
          params: { buildSessionId: randomUUID() },
        })
      );

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error.code).toBe("internal");
    });

    it("retries a failed preview on the same port by updating the existing PreviewSession without creating duplicate records", async () => {
      const existingFailedPreviewId = randomUUID();
      const bsId = randomUUID();
      let updatedStatus = "";
      let updatedId = "";

      const customStore = {
        ...mockStore,
        listActivePreviews: async () => [
          {
            buildSessionId: bsId,
            createdAt: now,
            errorDetails: {
              code: "HEALTH_CHECK_FAILED",
              message: "Failed earlier",
              occurredAt: now,
              recoverable: true,
              stack: null,
              step: "health_check",
            },
            expiresAt: now,
            healthUrl: null,
            organizationId,
            port: 3000,
            previewId: existingFailedPreviewId,
            projectId,
            proxyUrl: null,
            sandboxEnvironmentId: randomUUID(),
            sandboxId: "sb-retry",
            status: "failed",
            updatedAt: now,
          },
        ],
        updatePreviewStatus: (input: Record<string, unknown>) => {
          updatedStatus = String(input.status ?? "");
          updatedId = String(input.previewId ?? "");
          return Promise.resolve({
            buildSessionId: bsId,
            createdAt: now,
            errorDetails:
              (input.errorDetails as {
                code: string;
                message: string;
                occurredAt: string;
                recoverable: boolean;
                stack: string | null;
                step: string;
              } | null) ?? null,
            expiresAt: now,
            healthUrl: (input.healthUrl as string | null) ?? null,
            organizationId,
            port: 3000,
            previewId: String(input.previewId),
            projectId,
            proxyUrl: (input.proxyUrl as string | null) ?? null,
            sandboxEnvironmentId: randomUUID(),
            sandboxId: "sb-retry",
            status: input.status,
            updatedAt: now,
          });
        },
      };

      const customDeps = {
        resolvePrincipal: async () => mockUserPrincipal,
        store: () => customStore,
      };
      const customHandlers = createPreviewHandlers(customDeps);

      const res = await customHandlers.create(
        context({
          body: { organizationId, port: 3000, projectId },
          params: { buildSessionId: bsId },
        })
      );

      expect(res.status).toBe(202);
      const data = await res.json();
      expect(data.preview.previewId).toBe(existingFailedPreviewId);
      expect(updatedId).toBe(existingFailedPreviewId);
      expect(updatedStatus).toBe("initializing");
    });

    it("updates preview status", async () => {
      const previewId = randomUUID();
      const res = await handlers.update(
        context({
          body: {
            organizationId,
            projectId,
            proxyUrl: "https://preview.example.com",
            status: "ready",
          },
          params: { previewId },
        })
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.preview.status).toBe("ready");
    });
  });

  describe("evidence handlers", () => {
    const handlers = createEvidenceHandlers(deps);

    it("lists project evidence", async () => {
      const res = await handlers.listEvidence(
        context({
          params: { projectId },
          query: { organizationId },
        })
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data.evidence)).toBe(true);
    });

    it("gets artifact details", async () => {
      const artifactId = "00000000-0000-4000-8000-000000000099";
      const res = await handlers.getArtifact(
        context({
          params: { artifactId },
          query: { organizationId, projectId },
        })
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.artifact.artifactId).toBe(artifactId);
      expect(data.downloadUrl).toBeNull();
    });
  });

  describe("deployments handlers", () => {
    const handlers = createDeploymentHandlers(deps);

    it("lists project deployments", async () => {
      const res = await handlers.list(
        context({
          params: { projectId },
          query: { organizationId },
        })
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data.deployments)).toBe(true);
    });

    it("creates a deployment", async () => {
      const res = await handlers.create(
        context({
          body: {
            exposure: "public",
            organizationId,
            projectId,
            providerReference: "cloud-run-1",
            sourceCheckpoint: "1".repeat(40),
          },
          params: { projectId },
        })
      );
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.deployment.providerReference).toBe("cloud-run-1");
    });

    it("executes deployment rollback", async () => {
      const deploymentId = randomUUID();
      const targetDeploymentId = randomUUID();
      const res = await handlers.rollback(
        context({
          body: {
            organizationId,
            projectId,
            reason: "v2 bug",
            targetDeploymentId,
          },
          params: { deploymentId },
        })
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.activeDeployment.status).toBe("rolled_back");
    });
  });
});
