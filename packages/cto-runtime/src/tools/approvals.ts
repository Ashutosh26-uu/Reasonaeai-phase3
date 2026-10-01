import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const requestAccessTool = createTool({
  description:
    "Request user approval for access to a credential, secret, or restricted resource.",
  execute: async ({ resource, reason }, context) => {
    if (context.agent?.resumeData !== undefined) {
      const resumeData = JSON.parse(context.agent.resumeData);
      return {
        decision: resumeData.decision,
        feedback: resumeData.feedback,
      };
    }
    await context.agent?.suspend({ reason, resource });
    // Unreachable after suspend, but satisfies return type.
    return { decision: "REJECTED" as const };
  },
  id: "request_access",
  inputSchema: z.object({
    reason: z
      .string()
      .describe("Why you need this access and what you will do with it."),
    resource: z
      .string()
      .describe(
        "The resource or service you need access to (e.g. 'AWS Production Account', 'Stripe API')."
      ),
  }),
  outputSchema: z.object({
    decision: z.enum(["APPROVED", "REJECTED"]),
    feedback: z.string().optional(),
  }),
  resumeSchema: z.string(),
  suspendSchema: z.object({
    reason: z.string(),
    resource: z.string(),
  }),
});

export const submitPlanTool = createTool({
  description: "Submit an implementation plan for user review and approval.",
  execute: async ({ steps, summary, title }, context) => {
    if (context.agent?.resumeData !== undefined) {
      const resumeData = JSON.parse(context.agent.resumeData);
      return {
        decision: resumeData.decision,
        feedback: resumeData.feedback,
      };
    }
    await context.agent?.suspend({ steps, summary, title });
    // Unreachable after suspend, but satisfies return type.
    return { decision: "REJECTED" as const };
  },
  id: "submit_plan",
  inputSchema: z.object({
    steps: z
      .array(z.string())
      .describe("The sequence of steps proposed in the plan."),
    summary: z
      .string()
      .describe("A brief summary of what the plan accomplishes."),
    title: z.string().describe("The title of the plan."),
  }),
  outputSchema: z.object({
    decision: z.enum(["APPROVED", "REJECTED"]),
    feedback: z.string().optional(),
  }),
  resumeSchema: z.string(),
  suspendSchema: z.object({
    steps: z.array(z.string()),
    summary: z.string(),
    title: z.string(),
  }),
});
