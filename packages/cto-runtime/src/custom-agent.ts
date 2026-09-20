import { createCodingAgent } from "@mastra/core/coding-agent";
import type { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import type { Workspace } from "@mastra/core/workspace";
import { z } from "zod";
import {
  reasonateToolUniverse,
  scoutWorkspaceTools,
} from "./agents/definitions/workers.js";
import { filterToolsByDefinition } from "./agents/tool-filter.js";
import { CUSTOM_AGENT_SAFETY_INSTRUCTIONS } from "./prompts.js";

export type RuntimeWorkspace =
  | Workspace
  | ((input: {
      requestContext: RequestContext;
    }) => Promise<Workspace | undefined> | Workspace | undefined);

const CustomAgentAccessSchema = z.enum(["read-only", "full"]);

export function createCustomAgentTool(input: {
  defaultMaxSteps?: number;
  maxSteps?: number;
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

      const requestedSteps = args.maxSteps ?? input.defaultMaxSteps;

      const result = await specialist.generate(args.assignment, {
        // A read-only specialist is the same agent with a narrower tool set,
        // derived from the same universe every other agent draws from.
        ...(args.access === "read-only"
          ? {
              activeTools: filterToolsByDefinition(reasonateToolUniverse, {
                description: "read-only specialist",
                mode: "subagent",
                name: "custom",
                prompt: "",
                tools: [...scoutWorkspaceTools],
              }),
            }
          : {}),
        ...(requestedSteps === undefined ? {} : { maxSteps: requestedSteps }),
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
      access: CustomAgentAccessSchema,
      assignment: z.string().min(1).max(16_000),
      description: z.string().min(1).max(500),
      maxSteps: z
        .number()
        .int()
        .min(1)
        .max(input.maxSteps ?? 256)
        .optional(),
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
