import { createTool } from "@mastra/core/tools";
import {
  PlanDecisionSchema,
  type PlanProposal,
  PlanProposalSchema,
} from "@reasonateai/contracts/execution-protocol";
import { z } from "zod";

export const SUBMIT_PLAN_TOOL_ID = "submit_plan";

export const SubmitPlanResumeSchema = z.union([
  PlanDecisionSchema,
  z.object({
    action: z.enum(["approved", "rejected"]),
    feedback: z.string().optional(),
  }),
  z.string(),
]);

export const SubmitPlanOutputSchema = z.object({
  approved: z.boolean(),
  content: z.string(),
  feedback: z.string().optional(),
  isError: z.boolean().default(false),
});

export type SubmitPlanOutput = z.infer<typeof SubmitPlanOutputSchema>;

function parseResumedDecision(resumeData: unknown): {
  approved: boolean;
  feedback?: string;
} {
  let decision = resumeData;
  if (typeof decision === "string") {
    try {
      decision = JSON.parse(decision);
    } catch {
      decision = { approved: false, feedback: decision };
    }
  }

  const decObj = (
    decision && typeof decision === "object" ? decision : {}
  ) as Record<string, unknown>;

  const approved = decObj.approved === true || decObj.action === "approved";
  const feedback =
    typeof decObj.feedback === "string" && decObj.feedback.trim().length > 0
      ? decObj.feedback.trim()
      : undefined;

  return feedback === undefined ? { approved } : { approved, feedback };
}

export function createSubmitPlanTool() {
  return createTool({
    description:
      "Submit a structured implementation plan for user review and approval before executing substantial changes. Suspends execution until the user approves or rejects with feedback.",
    execute: async (proposal: PlanProposal, context) => {
      const contextRecord = context as Record<string, unknown> | undefined;
      const resumeData =
        context?.agent?.resumeData ?? contextRecord?.resumeData;

      if (resumeData !== undefined) {
        const { approved, feedback } = parseResumedDecision(resumeData);
        if (approved) {
          return {
            approved: true,
            content:
              "Plan approved by user. Proceed with implementation following the proposed plan.",
            feedback,
            isError: false,
          };
        }

        return {
          approved: false,
          content: `Plan was not approved by user.${
            feedback
              ? ` Feedback: ${feedback}`
              : " Revise your proposal based on user expectations."
          }`,
          feedback,
          isError: false,
        };
      }

      const suspend =
        context?.agent?.suspend ??
        (typeof contextRecord?.suspend === "function"
          ? (contextRecord.suspend as (payload: unknown) => Promise<unknown>)
          : undefined);

      if (suspend) {
        await suspend(proposal);
        return;
      }

      return {
        approved: false,
        content: "Plan submitted but suspension mechanism is unavailable.",
        isError: true,
      };
    },
    id: SUBMIT_PLAN_TOOL_ID,
    inputSchema: PlanProposalSchema,
    outputSchema: SubmitPlanOutputSchema,
    resumeSchema: SubmitPlanResumeSchema,
    suspendSchema: PlanProposalSchema,
  });
}

export const submitPlanTool = createSubmitPlanTool();
