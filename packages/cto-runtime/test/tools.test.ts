import { randomUUID } from "node:crypto";
import { RequestContext } from "@mastra/core/request-context";
import {
  BuildSessionIdSchema,
  CheckpointIdSchema,
} from "@reasonateai/contracts/execution";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
} from "@reasonateai/contracts/identity";
import { describe, expect, it } from "vitest";
import { sandboxIdFor } from "../src/run-scope.js";
import { createCheckpointTool } from "../src/tools/checkpoint.js";
import { createDeploymentTool } from "../src/tools/deployment.js";
import { createEvidenceTool } from "../src/tools/evidence.js";
import { createPreviewTool } from "../src/tools/preview.js";

const VERIFIED_REGEX = /verified/i;
const GIT_COMMIT_FAILED_REGEX = /Git commit failed/i;
const NOT_EXIST_IN_SCOPE_REGEX = /does not exist in project scope/i;

const scope = {
  buildSessionId: BuildSessionIdSchema.parse(randomUUID()),
  organizationId: OrganizationIdSchema.parse(randomUUID()),
  projectId: ProjectIdSchema.parse(randomUUID()),
  runId: RunIdSchema.parse(randomUUID()),
};

function contextWithRunScope() {
  const req = new RequestContext();
  req.set("runScope", scope);
  return req;
}

function createMockStore() {
  const checkpoints: any[] = [];
  const previews: any[] = [];
  const artifacts: any[] = [];
  const evidenceRecords: any[] = [];
  const deployments: any[] = [];

  return {
    artifacts,
    checkpoints,
    createPreview: (input: any) => {
      const p = {
        buildSessionId: input.buildSessionId,
        createdAt: new Date().toISOString(),
        errorDetails: input.errorDetails ?? null,
        expiresAt: input.expiresAt,
        healthUrl: input.healthUrl ?? null,
        organizationId: input.scope.organizationId,
        port: input.port,
        previewId: randomUUID(),
        projectId: input.scope.projectId,
        proxyUrl: input.proxyUrl ?? null,
        sandboxEnvironmentId: input.sandboxEnvironmentId,
        sandboxId: input.sandboxId,
        status: input.status,
        updatedAt: new Date().toISOString(),
      };
      previews.push(p);
      return Promise.resolve(p);
    },
    deployments,
    evidenceRecords,
    getBuildSession: () =>
      Promise.resolve({
        buildSessionId: scope.buildSessionId,
        createdAt: new Date().toISOString(),
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        runId: scope.runId,
        sandboxEnvironmentId: "00000000-0000-4000-8000-000000000099",
        stage: "intake",
        status: "ready",
        updatedAt: new Date().toISOString(),
        userSessionId: randomUUID(),
      }),
    listActivePreviews: () => Promise.resolve(previews),
    listCheckpoints: () => Promise.resolve(checkpoints),
    previews,
    recordArtifact: (manifest: any, status: string) => {
      const art = {
        artifactId: manifest.artifactId,
        createdAt: new Date().toISOString(),
        kind: manifest.kind,
        manifestObjectKey: "manifest.json",
        sha256: "hash",
        status,
        totalSize: manifest.totalSize,
      };
      artifacts.push(art);
      return Promise.resolve(art);
    },
    recordCheckpoint: (input: any) => {
      const cp = {
        author: input.author,
        buildSessionId: input.buildSessionId,
        checkpointId: CheckpointIdSchema.parse(randomUUID()),
        commitHash: input.commitHash,
        message: input.message,
        occurredAt: new Date().toISOString(),
        organizationId: input.scope.organizationId,
        parentHash: input.parentHash ?? null,
        projectId: input.scope.projectId,
        runId: input.runId,
      };
      checkpoints.push(cp);
      return Promise.resolve(cp);
    },
    recordDeployment: (input: any) => {
      const d = {
        deploymentId: input.deploymentId,
        exposure: input.exposure,
        providerReference: input.providerReference,
        rollbackDeploymentId: null,
        sourceCheckpoint: input.sourceCheckpoint,
        status: input.status,
        updatedAt: new Date().toISOString(),
        url: input.url,
      };
      deployments.push(d);
      return Promise.resolve(d);
    },
    recordEvidence: (input: any) => {
      const ev = {
        artifactId: input.artifactId,
        buildSessionId: input.buildSessionId ?? null,
        createdAt: new Date().toISOString(),
        evidenceId: randomUUID(),
        kind: input.kind,
        metadata: input.metadata ?? {},
        organizationId: input.scope.organizationId,
        projectId: input.scope.projectId,
        runId: input.runId ?? null,
        status: input.status,
        summary: input.summary,
      };
      evidenceRecords.push(ev);
      return Promise.resolve(ev);
    },
    updatePreviewStatus: (input: any) => {
      const existing = previews.find((p) => p.previewId === input.previewId);
      if (!existing) {
        throw new Error("Preview not found");
      }
      existing.status = input.status;
      if (input.healthUrl !== undefined) {
        existing.healthUrl = input.healthUrl;
      }
      if (input.proxyUrl !== undefined) {
        existing.proxyUrl = input.proxyUrl;
      }
      if (input.errorDetails !== undefined) {
        existing.errorDetails = input.errorDetails;
      }
      return Promise.resolve(existing);
    },
  };
}

async function runToolExecute(tool: any, input: any, ctx: any) {
  const fn = tool.execute;
  if (typeof fn !== "function") {
    throw new Error("Tool execute function missing");
  }
  return await fn(input, ctx);
}

describe("CTO Runtime Tools", () => {
  describe("checkpoint tool", () => {
    it("fails closed when RunScope is missing", async () => {
      const store = createMockStore();
      const tool = createCheckpointTool({ store: () => store as any });
      await expect(
        runToolExecute({ execute: tool.execute }, { message: "test commit" }, {
          requestContext: new RequestContext(),
        } as any)
      ).rejects.toThrow(VERIFIED_REGEX);
    });

    it("creates git checkpoint and persists in project-state store", async () => {
      const store = createMockStore();
      const reqCtx = contextWithRunScope();
      const tool = createCheckpointTool({ store: () => store as any });

      const result: any = await runToolExecute(
        { execute: tool.execute },
        { author: "CTO Agent", message: "feat: add user auth" },
        { requestContext: reqCtx } as any
      );

      expect(result.message).toBe("feat: add user auth");
      expect(result.author).toBe("CTO Agent");
      expect(result.commitHash).toHaveLength(40);
      expect(store.checkpoints.length).toBe(1);
    });

    it("executes git commands via ISandbox when sandbox is resolved", async () => {
      const store = createMockStore();
      const mockSandbox: any = {
        id: "sb-1",
        runCommand: (req: any) => {
          if (req.args[0] === "rev-parse" && req.args[1] === "HEAD") {
            return Promise.resolve({
              durationMs: 10,
              exitCode: 0,
              stderr: "",
              stdout: "a".repeat(40),
              timedOut: false,
            });
          }
          if (req.args[0] === "rev-parse" && req.args[1] === "HEAD~1") {
            return Promise.resolve({
              durationMs: 10,
              exitCode: 0,
              stderr: "",
              stdout: "b".repeat(40),
              timedOut: false,
            });
          }
          return Promise.resolve({
            durationMs: 10,
            exitCode: 0,
            stderr: "",
            stdout: "ok",
            timedOut: false,
          });
        },
      };

      const tool = createCheckpointTool({
        resolveSandbox: () => Promise.resolve(mockSandbox),
        store: () => store as any,
      });

      const result: any = await runToolExecute(
        { execute: tool.execute },
        { message: "feat: git commit test" },
        { requestContext: contextWithRunScope() } as any
      );

      expect(result.commitHash).toBe("a".repeat(40));
      expect(result.parentHash).toBe("b".repeat(40));
    });

    it("throws when git commit command fails in sandbox", async () => {
      const store = createMockStore();
      const mockSandbox: any = {
        id: "sb-1",
        runCommand: (req: any) => {
          if (req.args[0] === "commit") {
            return Promise.resolve({
              durationMs: 10,
              exitCode: 1,
              stderr: "fatal: empty author",
              stdout: "",
              timedOut: false,
            });
          }
          return Promise.resolve({
            durationMs: 10,
            exitCode: 0,
            stderr: "",
            stdout: "ok",
            timedOut: false,
          });
        },
      };

      const tool = createCheckpointTool({
        resolveSandbox: () => Promise.resolve(mockSandbox),
        store: () => store as any,
      });

      await expect(
        runToolExecute(
          { execute: tool.execute },
          { message: "failing commit" },
          {
            requestContext: contextWithRunScope(),
          } as any
        )
      ).rejects.toThrow(GIT_COMMIT_FAILED_REGEX);
    });
  });

  describe("preview tool", () => {
    it("allocates and transitions preview to ready on successful health check", async () => {
      const store = createMockStore();
      const mockSandbox: any = {
        id: "sb-preview",
        runCommand: () =>
          Promise.resolve({
            durationMs: 10,
            exitCode: 0,
            stderr: "",
            stdout: "OK",
            timedOut: false,
          }),
      };

      const tool = createPreviewTool({
        resolveSandbox: () => Promise.resolve(mockSandbox),
        store: () => store as any,
      });

      const result: any = await runToolExecute(
        { execute: tool.execute },
        { healthPath: "/health", port: 3000 },
        { requestContext: contextWithRunScope() } as any
      );

      expect(result.status).toBe("ready");
      expect(result.port).toBe(3000);
      expect(result.healthUrl).toBe("http://localhost:3000/health");
      expect(result.sandboxId).toBe(sandboxIdFor(scope));
    });

    it("transitions preview to failed with errorDetails when health check fails", async () => {
      const store = createMockStore();
      const mockSandbox: any = {
        id: "sb-preview",
        runCommand: () =>
          Promise.resolve({
            durationMs: 10,
            exitCode: 7,
            stderr: "Failed to connect",
            stdout: "",
            timedOut: false,
          }),
      };

      const tool = createPreviewTool({
        resolveSandbox: () => Promise.resolve(mockSandbox),
        store: () => store as any,
      });

      const result: any = await runToolExecute(
        { execute: tool.execute },
        { healthPath: "/health", port: 3000 },
        { requestContext: contextWithRunScope() } as any
      );

      expect(result.status).toBe("failed");
      expect(result.errorDetails?.code).toBe("HEALTH_CHECK_FAILED");
      expect(result.errorDetails?.message).toContain("Failed to connect");
    });
  });

  describe("evidence tool", () => {
    it("creates artifact and links evidence record to artifactId", async () => {
      const store = createMockStore();
      const tool = createEvidenceTool({ store: () => store as any });

      const result: any = await runToolExecute(
        { execute: tool.execute },
        {
          content: "Console output log test",
          kind: "console_log",
          metadata: { lines: 1 },
          status: "passed",
          summary: "Captured console logs",
        },
        { requestContext: contextWithRunScope() } as any
      );

      expect(result.kind).toBe("console_log");
      expect(result.status).toBe("passed");
      expect(result.summary).toBe("Captured console logs");
      expect(store.artifacts.length).toBe(1);
      expect(store.evidenceRecords.length).toBe(1);
      expect(store.evidenceRecords[0].artifactId).toBe(
        store.artifacts[0].artifactId
      );
    });
  });

  describe("deployment tool", () => {
    it("throws error when source checkpoint is not found in project scope", async () => {
      const store = createMockStore();
      const tool = createDeploymentTool({ store: () => store as any });

      await expect(
        runToolExecute(
          { execute: tool.execute },
          {
            exposure: "public",
            providerReference: "cloud-run",
            sourceCheckpoint: "nonexistent-hash",
          },
          { requestContext: contextWithRunScope() } as any
        )
      ).rejects.toThrow(NOT_EXIST_IN_SCOPE_REGEX);
    });

    it("creates deployment when valid source checkpoint exists", async () => {
      const store = createMockStore();
      const commitHash = "a".repeat(40);
      store.checkpoints.push({
        author: "CTO Agent",
        buildSessionId: scope.buildSessionId,
        checkpointId: randomUUID(),
        commitHash,
        message: "v1",
        occurredAt: new Date().toISOString(),
        organizationId: scope.organizationId,
        parentHash: null,
        projectId: scope.projectId,
        runId: scope.runId,
      });

      const tool = createDeploymentTool({ store: () => store as any });

      const result: any = await runToolExecute(
        { execute: tool.execute },
        {
          exposure: "public",
          providerReference: "cloud-run-v1",
          sourceCheckpoint: commitHash,
        },
        { requestContext: contextWithRunScope() } as any
      );

      expect(result.status).toBe("pending");
      expect(result.providerReference).toBe("cloud-run-v1");
      expect(result.sourceCheckpoint).toBe(commitHash);
      expect(store.deployments.length).toBe(1);
    });
  });
});
