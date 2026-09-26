import type {
  BuildSession,
  Deployment,
  EvidenceRecord,
  GitCheckpoint,
  PreviewSession,
} from "@reasonateai/contracts/execution";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CheckpointTimeline } from "../components/checkpoint-timeline";
import { DeploymentManager } from "../components/deployment-manager";
import { EvidenceGallery } from "../components/evidence-gallery";
import { PreviewPanel } from "../components/preview-panel";
import { RunStatusCard } from "../components/run-status-card";
import { WorkspaceDashboard } from "../components/workspace-dashboard";
import { ApiError, apiClient } from "../lib/api-client";

const mockPreview: PreviewSession = {
  buildSessionId: "00000000-0000-4000-8000-000000000001" as any,
  createdAt: new Date().toISOString(),
  errorDetails: null,
  expiresAt: new Date().toISOString(),
  healthUrl: "http://localhost:3000/health",
  organizationId: "00000000-0000-4000-8000-000000000002" as any,
  port: 3000,
  previewId: "00000000-0000-4000-8000-000000000010" as any,
  projectId: "00000000-0000-4000-8000-000000000003" as any,
  proxyUrl: null,
  sandboxEnvironmentId: "00000000-0000-4000-8000-000000000099" as any,
  sandboxId: "sb-123",
  status: "ready",
  updatedAt: new Date().toISOString(),
};

const mockCheckpoint: GitCheckpoint = {
  author: "CTO Agent",
  buildSessionId: "00000000-0000-4000-8000-000000000001" as any,
  checkpointId: "00000000-0000-4000-8000-000000000020" as any,
  commitHash: "a".repeat(40),
  message: "feat: add user authentication",
  occurredAt: new Date().toISOString(),
  organizationId: "00000000-0000-4000-8000-000000000002" as any,
  parentHash: null,
  projectId: "00000000-0000-4000-8000-000000000003" as any,
  runId: "00000000-0000-4000-8000-000000000004" as any,
};

const mockEvidence: EvidenceRecord = {
  artifactId: "00000000-0000-4000-8000-000000000030",
  buildSessionId: "00000000-0000-4000-8000-000000000001" as any,
  createdAt: new Date().toISOString(),
  evidenceId: "00000000-0000-4000-8000-000000000031" as any,
  kind: "console_log",
  metadata: { totalLines: 15 },
  organizationId: "00000000-0000-4000-8000-000000000002" as any,
  projectId: "00000000-0000-4000-8000-000000000003" as any,
  runId: "00000000-0000-4000-8000-000000000004" as any,
  status: "passed",
  summary: "All 15 integration tests passed",
};

const mockDeployment: Deployment = {
  createdAt: new Date().toISOString(),
  deploymentId: "00000000-0000-4000-8000-000000000040" as any,
  exposure: "public",
  organizationId: "00000000-0000-4000-8000-000000000002" as any,
  projectId: "00000000-0000-4000-8000-000000000003" as any,
  providerReference: "cloud-run-prod",
  rollbackDeploymentId: null,
  runId: "00000000-0000-4000-8000-000000000004" as any,
  sourceCheckpoint: "a".repeat(40),
  status: "pending",
  updatedAt: new Date().toISOString(),
  url: null,
};

const mockSession: BuildSession = {
  buildSessionId: "00000000-0000-4000-8000-000000000001" as any,
  createdAt: new Date().toISOString(),
  organizationId: "00000000-0000-4000-8000-000000000002" as any,
  projectId: "00000000-0000-4000-8000-000000000003" as any,
  runId: "00000000-0000-4000-8000-000000000004" as any,
  sandboxEnvironmentId: "00000000-0000-4000-8000-000000000099" as any,
  stage: "runtime_verification",
  status: "running",
  updatedAt: new Date().toISOString(),
  userSessionId: "00000000-0000-4000-8000-000000000005" as any,
};

describe("Frontend API Client & UI Components", () => {
  describe("PreviewPanel", () => {
    it("renders loading state", () => {
      const html = renderToStaticMarkup(
        <PreviewPanel isLoading={true} preview={null} />
      );
      expect(html).toContain("Loading sandbox preview state");
    });

    it("renders notice when proxyUrl is null and DOES NOT invent a live browser URL", () => {
      const html = renderToStaticMarkup(<PreviewPanel preview={mockPreview} />);
      expect(html).toContain(
        "Application Running inside Build Sandbox (Port 3000)"
      );
      expect(html).toContain(
        "no public preview proxy URL is available in this environment"
      );
      expect(html).not.toContain('<iframe src="http');
    });

    it("renders iframe when proxyUrl is provided", () => {
      const withProxy = {
        ...mockPreview,
        proxyUrl: "https://preview.proxy.reasonate.ai/app",
        status: "ready" as const,
      };
      const html = renderToStaticMarkup(<PreviewPanel preview={withProxy} />);
      expect(html).toContain('src="https://preview.proxy.reasonate.ai/app"');
    });

    it("renders failed state with structured FailureDetails", () => {
      const failedPreview: PreviewSession = {
        ...mockPreview,
        errorDetails: {
          code: "HEALTH_CHECK_FAILED",
          message: "Server crashed on startup",
          occurredAt: new Date().toISOString(),
          recoverable: true,
          stack: null,
          step: "health_check",
        },
        status: "failed",
      };
      const html = renderToStaticMarkup(
        <PreviewPanel preview={failedPreview} />
      );
      expect(html).toContain("HEALTH_CHECK_FAILED");
      expect(html).toContain("Server crashed on startup");
    });

    it("renders forbidden/unauthorized error state", () => {
      const err = new ApiError(403, "Forbidden");
      const html = renderToStaticMarkup(
        <PreviewPanel error={err} preview={null} />
      );
      expect(html).toContain("Access Denied");
      expect(html).toContain("permission");
    });

    const dummyCreatePreview = () => undefined;

    it("disables Start Preview button when buildSessionId is missing or empty", () => {
      const html = renderToStaticMarkup(
        <PreviewPanel
          buildSessionId=""
          onCreatePreview={dummyCreatePreview}
          preview={null}
        />
      );
      expect(html).toContain('disabled=""');
      expect(html).toContain("Start Preview");
    });

    it("enables Start Preview button when a real buildSessionId is provided", () => {
      const html = renderToStaticMarkup(
        <PreviewPanel
          buildSessionId="real-session-123"
          onCreatePreview={dummyCreatePreview}
          preview={null}
        />
      );
      expect(html).toContain("Start Preview");
      expect(html).not.toContain('disabled=""');
    });
  });

  describe("ApiClient build session allocation", () => {
    it("calls POST /v1/build-sessions with Idempotency-Key header and request body", async () => {
      const originalFetch = global.fetch;
      try {
        const mockResponse = {
          buildSession: {
            buildSessionId: "real-build-session-uuid",
            organizationId: "00000000-0000-4000-8000-000000000002",
            projectId: "00000000-0000-4000-8000-000000000003",
            runId: "run-1",
            sandboxEnvironmentId: "sandbox-env-1",
            stage: "intake",
            status: "provisioning",
            userSessionId: "user-sess-1",
          },
          created: true,
          sandbox: {
            buildSessionId: "real-build-session-uuid",
            status: "allocating",
            workspaceUri: "sandbox://workspace",
          },
        };

        let capturedUrl = "";
        let capturedOptions: Record<string, unknown> = {};

        global.fetch = vi
          .fn()
          .mockImplementation(
            (url: URL | string, opts?: Record<string, unknown>) => {
              capturedUrl = url.toString();
              capturedOptions = opts ?? {};
              return Promise.resolve({
                json: async () => mockResponse,
                ok: true,
                status: 202,
              });
            }
          ) as unknown as typeof fetch;

        const result = await apiClient.allocateBuildSession(
          "00000000-0000-4000-8000-000000000002",
          "00000000-0000-4000-8000-000000000003"
        );

        expect(capturedUrl).toContain("/v1/build-sessions");
        const headers =
          (capturedOptions as { headers?: Record<string, string> }).headers ??
          {};
        expect(capturedOptions.method).toBe("POST");
        expect(headers["Idempotency-Key"]).toBeDefined();
        expect(result.buildSession.buildSessionId).toBe(
          "real-build-session-uuid"
        );
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe("WorkspaceDashboard Lifecycle", () => {
    it("renders without hard-coded placeholder zero buildSessionId", () => {
      const html = renderToStaticMarkup(<WorkspaceDashboard />);
      expect(html).not.toContain("00000000-0000-4000-8000-000000000001");
      expect(html).toContain("ReasonateAI CTO Agent Workspace");
    });
  });

  describe("CheckpointTimeline", () => {
    it("renders loading state", () => {
      const html = renderToStaticMarkup(
        <CheckpointTimeline checkpoints={[]} isLoading={true} />
      );
      expect(html).toContain("Loading workspace checkpoint history");
    });

    it("renders checkpoint history item with 7-character commit hash", () => {
      const html = renderToStaticMarkup(
        <CheckpointTimeline checkpoints={[mockCheckpoint]} />
      );
      expect(html).toContain("feat: add user authentication");
      expect(html).toContain("aaaaaaa");
      expect(html).toContain("CTO Agent");
    });

    it("renders empty state", () => {
      const html = renderToStaticMarkup(
        <CheckpointTimeline checkpoints={[]} />
      );
      expect(html).toContain("No checkpoints recorded yet");
    });
  });

  describe("EvidenceGallery", () => {
    it("renders evidence records and status badges", () => {
      const html = renderToStaticMarkup(
        <EvidenceGallery evidenceList={[mockEvidence]} />
      );
      expect(html).toContain("All 15 integration tests passed");
      expect(html).toContain("Passed");
      expect(html).toContain("console log");
    });

    it("renders empty state when filtered out", () => {
      const html = renderToStaticMarkup(<EvidenceGallery evidenceList={[]} />);
      expect(html).toContain("No evidence records matching current filter");
    });
  });

  describe("DeploymentManager", () => {
    it("renders pending deployment state without inventing a live URL", () => {
      const html = renderToStaticMarkup(
        <DeploymentManager deployments={[mockDeployment]} />
      );
      expect(html).toContain("pending");
      expect(html).toContain("cloud-run-prod");
      expect(html).toContain("Deployment pending — no live URL generated yet");
    });

    it("renders ready deployment with URL link", () => {
      const readyDep: Deployment = {
        ...mockDeployment,
        status: "ready",
        url: "https://app.reasonate.ai",
      };
      const html = renderToStaticMarkup(
        <DeploymentManager deployments={[readyDep]} />
      );
      expect(html).toContain("https://app.reasonate.ai");
    });
  });

  describe("RunStatusCard", () => {
    it("renders session state and lifecycle stage", () => {
      const html = renderToStaticMarkup(
        <RunStatusCard session={mockSession} />
      );
      expect(html).toContain("running");
      expect(html).toContain("runtime verification");
    });

    it("renders live SSE event log", () => {
      const events = [
        {
          eventId: "1" as any,
          payload: {},
          timestamp: new Date().toISOString(),
          type: "checkpoint.created" as const,
        },
      ];
      const html = renderToStaticMarkup(
        <RunStatusCard events={events} session={mockSession} />
      );
      expect(html).toContain("checkpoint.created");
    });
  });
});
