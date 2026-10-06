import { describe, expect, it } from "vitest";
import {
  PlanDecisionSchema,
  PlanProposalSchema,
  RunAnswerRequestSchema,
  RunEventTypeSchema,
  RunPlanDecisionRequestSchema,
  WorkspaceRestoreRequestSchema,
  WorkspaceRestoreResponseSchema,
} from "../src/execution-protocol.js";
import { AuditActionSchema } from "../src/identity.js";

describe("contracts: plan and checkpoint schemas", () => {
  it("validates a structured plan proposal", () => {
    const validPlan = {
      files: [
        {
          action: "create",
          description: "Add new authentication middleware",
          path: "src/auth/middleware.ts",
        },
        {
          action: "modify",
          description: "Attach middleware to user routes",
          path: "src/routes/user.ts",
        },
      ],
      rationale:
        "Protect user routes from unauthenticated access by enforcing token checks at boundary.",
      risk: "Low. Isolated to private API route handlers.",
      steps: [
        "Create JWT middleware in src/auth",
        "Wire middleware into user route definitions",
        "Add unit tests covering valid and expired tokens",
      ],
      summary: "Add auth middleware protecting user routes.",
      title: "Implement Authentication Middleware",
    };

    const parsed = PlanProposalSchema.safeParse(validPlan);
    expect(parsed.success).toBe(true);
  });

  it("rejects an invalid plan proposal missing required fields", () => {
    const invalidPlan = {
      title: "Missing fields",
    };
    const parsed = PlanProposalSchema.safeParse(invalidPlan);
    expect(parsed.success).toBe(false);
  });

  it("validates plan decisions", () => {
    const approved = PlanDecisionSchema.safeParse({
      approved: true,
    });
    expect(approved.success).toBe(true);

    const rejectedWithFeedback = PlanDecisionSchema.safeParse({
      approved: false,
      feedback: "Please add rate limiting to the proposal.",
    });
    expect(rejectedWithFeedback.success).toBe(true);

    const invalid = PlanDecisionSchema.safeParse({
      approved: "not a boolean",
    });
    expect(invalid.success).toBe(false);
  });

  it("accepts plan decisions in RunAnswerRequestSchema", () => {
    const answerOnly = RunAnswerRequestSchema.safeParse({
      answer: "Yes, proceed",
      toolCallId: "call-1",
    });
    expect(answerOnly.success).toBe(true);

    const decisionOnly = RunAnswerRequestSchema.safeParse({
      approved: true,
      toolCallId: "call-2",
    });
    expect(decisionOnly.success).toBe(true);

    const decisionWithFeedback = RunAnswerRequestSchema.safeParse({
      approved: false,
      feedback: "Change approach",
      toolCallId: "call-3",
    });
    expect(decisionWithFeedback.success).toBe(true);

    const neither = RunAnswerRequestSchema.safeParse({
      toolCallId: "call-4",
    });
    expect(neither.success).toBe(false);
  });

  it("validates RunPlanDecisionRequestSchema", () => {
    const valid = RunPlanDecisionRequestSchema.safeParse({
      approved: true,
      feedback: "Looks good!",
      toolCallId: "call-plan-1",
    });
    expect(valid.success).toBe(true);
  });

  it("validates WorkspaceRestoreRequestSchema and Response", () => {
    const digestReq = WorkspaceRestoreRequestSchema.safeParse({
      checkpointDigest:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
    expect(digestReq.success).toBe(true);

    const idReq = WorkspaceRestoreRequestSchema.safeParse({
      checkpointId: "org-1.proj-1.abc123",
    });
    expect(idReq.success).toBe(true);

    const emptyReq = WorkspaceRestoreRequestSchema.safeParse({});
    expect(emptyReq.success).toBe(false);

    const response = WorkspaceRestoreResponseSchema.safeParse({
      checkpointId: "org-1.proj-1.abc123",
      digest:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      restoredAt: new Date().toISOString(),
    });
    expect(response.success).toBe(true);
  });

  it("includes run.plan_proposed and run.plan_decided in RunEventTypeSchema", () => {
    expect(RunEventTypeSchema.safeParse("run.plan_proposed").success).toBe(
      true
    );
    expect(RunEventTypeSchema.safeParse("run.plan_decided").success).toBe(true);
  });

  it("includes checkpoint.restored and plan.decided in AuditActionSchema", () => {
    expect(AuditActionSchema.safeParse("checkpoint.restored").success).toBe(
      true
    );
    expect(AuditActionSchema.safeParse("plan.decided").success).toBe(true);
  });
});
