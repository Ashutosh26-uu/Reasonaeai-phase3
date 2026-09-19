import { createCodingAgent } from "@mastra/core/coding-agent";
import type { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import type { Workspace } from "@mastra/core/workspace";
import { z } from "zod";
import { CUSTOM_AGENT_SAFETY_INSTRUCTIONS } from "./prompts.js";
import { scoutWorkspaceTools } from "./subagents.js";

export type RuntimeWorkspace =
  | Workspace
  | ((input: {
      requestContext: RequestContext;
    }) => Promise<Workspace | undefined> | Workspace | undefined);

const CustomAgentCapabilitySchema = z.enum([
  "research",
  "implementation",
  "debugging",
  "full",
]);

export function createCustomAgentTool(input: {
  defaultMaxSteps: number;
  maxSteps: number;
  model: string;
  skills?: string[];
  workspace: RuntimeWorkspace;
}) {
  return createTool({
    description:
      "Creates and runs one ephemeral specialist with an orchestrator-authored system prompt, bounded tools, skills, and steps.",
    execute: async (args, context) => {
      const workspace =
        typeof input.workspace === "function"
          ? await input.workspace({ requestContext: context.requestContext })
          : input.workspace;

      if (!workspace) {
        throw new Error(
          "The verified run workspace is unavailable for this custom agent."
        );
      }

      const specialist = createCodingAgent({
        description: args.description,
        id: `custom-${crypto.randomUUID()}`,
        instructions: `${CUSTOM_AGENT_SAFETY_INSTRUCTIONS}\n\nTask-specific role\n${args.systemInstructions}`,
        model: input.model,
        name: args.name,
        ...(input.skills ? { skills: input.skills } : {}),
        workspace,
      });

      const result = await specialist.generate(args.assignment, {
        ...(args.capability === "research"
          ? { activeTools: [...scoutWorkspaceTools] }
          : {}),
        maxSteps: args.maxSteps ?? input.defaultMaxSteps,
        requestContext: context.requestContext,
      });

      return {
        finishReason: result.finishReason ?? "unknown",
        specialist: args.name,
        text: result.text,
      };
    },
    id: "spawn-custom-agent",
    inputSchema: z.strictObject({
      assignment: z.string().min(1).max(16_000),
      capability: CustomAgentCapabilitySchema,
      description: z.string().min(1).max(500),
      maxSteps: z.number().int().min(1).max(input.maxSteps).optional(),
      name: z.string().min(1).max(80),
      systemInstructions: z.string().min(1).max(12_000),
    }),
    outputSchema: z.strictObject({
      finishReason: z.string(),
      specialist: z.string(),
      text: z.string(),
    }),
  });
}
