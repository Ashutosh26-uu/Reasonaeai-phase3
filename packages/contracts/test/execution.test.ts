import { describe, expect, it } from "vitest";
import {
  AllocateBuildSessionRequestSchema,
  BuildSessionAllocationSchema,
  BuildSessionSchema,
  CreateDeploymentRequestSchema,
  canAdvanceProductLifecycle,
  DeploymentSchema,
  EvidenceRecordSchema,
  GitCheckpointSchema,
  isShareableDeployment,
  PreviewSessionSchema,
  RollbackDeploymentRequestSchema,
} from "../src/execution.js";

const ids = {
  buildSessionId: "00000000-0000-4000-8000-000000000001",
  deploymentId: "00000000-0000-4000-8000-000000000002",
  organizationId: "00000000-0000-4000-8000-000000000003",
  projectId: "00000000-0000-4000-8000-000000000004",
  runId: "00000000-0000-4000-8000-000000000005",
  sandboxEnvironmentId: "00000000-0000-4000-8000-000000000007",
  userSessionId: "00000000-0000-4000-8000-000000000006",
};
const now = "2026-09-19T12:00:00.000Z";

describe("product execution contracts", () => {
  it("binds a web build session to identity, tenant, project, run, and sandbox state", () => {
    expect(
      BuildSessionSchema.parse({
        buildSessionId: ids.buildSessionId,
        createdAt: now,
        organizationId: ids.organizationId,
        projectId: ids.projectId,
        runId: ids.runId,
        sandboxEnvironmentId: null,
        stage: "intake",
        status: "provisioning",
        updatedAt: now,
        userSessionId: ids.userSessionId,
      })
    ).toMatchObject({
      buildSessionId: ids.buildSessionId,
      status: "provisioning",
      userSessionId: ids.userSessionId,
    });
  });
  it("defines idempotent first-request allocation without trusting extra scope", () => {
    const request = AllocateBuildSessionRequestSchema.parse({
      idempotencyKey: "first-browser-request",
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      userSessionId: ids.userSessionId,
    });
    const buildSession = BuildSessionSchema.parse({
      buildSessionId: ids.buildSessionId,
      createdAt: now,
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      runId: ids.runId,
      sandboxEnvironmentId: ids.sandboxEnvironmentId,
      stage: "intake",
      status: "ready",
      updatedAt: now,
      userSessionId: ids.userSessionId,
    });

    expect(request.idempotencyKey).toBe("first-browser-request");
    expect(() =>
      AllocateBuildSessionRequestSchema.parse({
        ...request,
        runId: ids.runId,
      })
    ).toThrow();
    expect(
      BuildSessionAllocationSchema.parse({
        buildSession,
        created: true,
        sandbox: {
          buildSessionId: ids.buildSessionId,
          createdAt: now,
          organizationId: ids.organizationId,
          projectId: ids.projectId,
          sandboxEnvironmentId: ids.sandboxEnvironmentId,
          status: "ready",
          updatedAt: now,
          workspaceUri: `sandbox://${ids.sandboxEnvironmentId}/workspace`,
        },
      })
    ).toMatchObject({ created: true });
  });

  it("allows only idempotent or adjacent lifecycle advancement", () => {
    expect(canAdvanceProductLifecycle("implementation", "implementation")).toBe(
      true
    );
    expect(
      canAdvanceProductLifecycle("implementation", "runtime_verification")
    ).toBe(true);
    expect(canAdvanceProductLifecycle("implementation", "released")).toBe(
      false
    );
    expect(canAdvanceProductLifecycle("released", "deployment")).toBe(false);
  });

  it("exposes a deployment only after it is ready with a URL", () => {
    const deployment = DeploymentSchema.parse({
      createdAt: now,
      deploymentId: ids.deploymentId,
      exposure: "unlisted",
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      providerReference: "provider-deployment-1",
      rollbackDeploymentId: null,
      runId: ids.runId,
      sourceCheckpoint: "abc123",
      status: "ready",
      updatedAt: now,
      url: "https://project.reasonate.example",
    });

    expect(isShareableDeployment(deployment)).toBe(true);
    expect(
      isShareableDeployment({ ...deployment, status: "deploying", url: null })
    ).toBe(false);
  });

  it("validates GitCheckpointSchema, PreviewSessionSchema, EvidenceRecordSchema, and Deployment request schemas", () => {
    const checkpointId = "00000000-0000-4000-8000-000000000010";
    const previewId = "00000000-0000-4000-8000-000000000011";
    const evidenceId = "00000000-0000-4000-8000-000000000012";
    const artifactId = "00000000-0000-4000-8000-000000000013";

    const checkpoint = GitCheckpointSchema.parse({
      author: "CTO Agent",
      buildSessionId: ids.buildSessionId,
      checkpointId,
      commitHash: "a".repeat(40),
      message: "feat: add user authentication",
      occurredAt: now,
      organizationId: ids.organizationId,
      parentHash: "b".repeat(40),
      projectId: ids.projectId,
      runId: ids.runId,
    });
    expect(checkpoint.commitHash).toHaveLength(40);

    const preview = PreviewSessionSchema.parse({
      buildSessionId: ids.buildSessionId,
      createdAt: now,
      errorDetails: null,
      expiresAt: now,
      healthUrl: "http://localhost:3000/health",
      organizationId: ids.organizationId,
      port: 3000,
      previewId,
      projectId: ids.projectId,
      proxyUrl: null,
      sandboxEnvironmentId: ids.sandboxEnvironmentId,
      sandboxId: "sandbox-build-session-123",
      status: "ready",
      updatedAt: now,
    });
    expect(preview.status).toBe("ready");

    const evidence = EvidenceRecordSchema.parse({
      artifactId,
      buildSessionId: ids.buildSessionId,
      createdAt: now,
      evidenceId,
      kind: "screenshot",
      metadata: { height: 720, width: 1280 },
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      runId: ids.runId,
      status: "passed",
      summary: "Verified login screen layout",
    });
    expect(evidence.kind).toBe("screenshot");

    const createReq = CreateDeploymentRequestSchema.parse({
      exposure: "public",
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      providerReference: "cloud-run-rev-1",
      sourceCheckpoint: "a".repeat(40),
    });
    expect(createReq.providerReference).toBe("cloud-run-rev-1");

    const rollbackReq = RollbackDeploymentRequestSchema.parse({
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      reason: "Regression in v2",
      targetDeploymentId: ids.deploymentId,
    });
    expect(rollbackReq.reason).toBe("Regression in v2");
  });
});
