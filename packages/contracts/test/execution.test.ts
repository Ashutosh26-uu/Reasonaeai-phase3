import { describe, expect, it } from "vitest";
import {
  AllocateBuildSessionRequestSchema,
  AppendConversationTurnRequestSchema,
  AttachmentFilenameSchema,
  BuildSessionAllocationSchema,
  BuildSessionSchema,
  canAdvanceProductLifecycle,
  DeploymentSchema,
  isShareableDeployment,
  PromptAttachmentSchema,
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
  it("retains bounded paste presentation while keeping ordinary uploads unchanged", () => {
    const paste = { charCount: 12, lineCount: 2, preview: "First\nSecond" };
    const input = {
      data: "data:text/plain;base64,Rmlyc3QKU2Vjb25k",
      filename: "notes.txt",
      mediaType: "text/plain",
      paste,
    };
    expect(PromptAttachmentSchema.parse(input).paste).toEqual(paste);
    expect(
      PromptAttachmentSchema.safeParse({
        ...input,
        paste: { ...paste, preview: "x".repeat(513) },
      }).success
    ).toBe(false);
    expect(
      PromptAttachmentSchema.safeParse({
        ...input,
        data: "data:image/png;base64,YQ==",
        mediaType: "image/png",
      }).success
    ).toBe(false);
    const { paste: _paste, ...upload } = input;
    expect(PromptAttachmentSchema.parse(upload)).not.toHaveProperty("paste");
    expect(
      PromptAttachmentSchema.parse({ ...upload, origin: "upload" }).origin
    ).toBe("upload");
    expect(
      PromptAttachmentSchema.safeParse({ ...input, origin: "upload" }).success
    ).toBe(false);
    expect(
      PromptAttachmentSchema.safeParse({ ...upload, origin: "paste" }).success
    ).toBe(false);
  });
  it("preserves literal attachment names while rejecting paths and control characters", () => {
    for (const filename of [
      "notes:raw",
      "研究 notes.txt",
      "design final.png",
    ]) {
      expect(AttachmentFilenameSchema.parse(filename)).toBe(filename);
    }
    for (const filename of [
      ".",
      "..",
      "../secret",
      "a/b",
      "a\\b",
      "a\n.txt",
      "a\u0000.txt",
      "研".repeat(100),
      "broken-\ud800.txt",
    ]) {
      expect(AttachmentFilenameSchema.safeParse(filename).success).toBe(false);
    }
  });
  it("accepts bounded, typed file attachments and rejects empty or oversized turns", () => {
    const attachment = {
      data: "data:image/png;base64,aGVsbG8=",
      filename: "wireframe.png",
      mediaType: "image/png",
    };
    expect(
      AppendConversationTurnRequestSchema.parse({
        attachments: [attachment],
        message: "",
      })
    ).toMatchObject({ attachments: [attachment] });
    expect(() =>
      AppendConversationTurnRequestSchema.parse({
        attachments: [],
        message: " ",
      })
    ).toThrow();
    expect(() =>
      AppendConversationTurnRequestSchema.parse({
        attachments: [{ ...attachment, mediaType: "image/jpeg" }],
        message: "Inspect this",
      })
    ).toThrow();
  });

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
});
