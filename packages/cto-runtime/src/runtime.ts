import type { ToolsInput } from "@mastra/core/agent";
import { AgentController } from "@mastra/core/agent-controller";
import type { MastraBrowser } from "@mastra/core/browser";
import { createCodingAgent } from "@mastra/core/coding-agent";
import type { MastraCompositeStore } from "@mastra/core/storage";
import { Memory } from "@mastra/memory";
import {
  createCustomAgentTool,
  type RuntimeWorkspace,
} from "./custom-agent.js";
import { MAIN_AGENT_INSTRUCTIONS, REASONATE_CTO_NAME } from "./prompts.js";
import { createCoreSubagents } from "./subagents.js";

export interface CtoRuntimeLimits {
  customAgentMaxSteps: number;
  debuggerMaxSteps: number;
  mainMaxSteps: number;
  scoutMaxSteps: number;
  workerMaxSteps: number;
}

export interface CtoSubagentModels {
  coder: string;
  debugger: string;
  scout: string;
}

export interface ReasonateCtoRuntimeConfig {
  browser?: MastraBrowser;
  controllerId?: string;
  limits?: Partial<CtoRuntimeLimits>;
  memory?: Memory;
  model: string;
  resourceId?: string;
  skills?: string[];
  storage?: MastraCompositeStore;
  subagentModels?: Partial<CtoSubagentModels>;
  tools?: ToolsInput;
  workspace: RuntimeWorkspace;
}

const DEFAULT_LIMITS: CtoRuntimeLimits = {
  customAgentMaxSteps: 24,
  debuggerMaxSteps: 32,
  mainMaxSteps: 64,
  scoutMaxSteps: 12,
  workerMaxSteps: 32,
};

function resolveLimits(
  overrides: Partial<CtoRuntimeLimits> | undefined
): CtoRuntimeLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1 || value > 256) {
      throw new Error(`${name} must be an integer between 1 and 256.`);
    }
  }
  return limits;
}

export function createReasonateCtoRuntime(config: ReasonateCtoRuntimeConfig) {
  const limits = resolveLimits(config.limits);
  const memory = config.memory ?? new Memory();
  const customAgent = createCustomAgentTool({
    defaultMaxSteps: limits.customAgentMaxSteps,
    maxSteps: limits.customAgentMaxSteps,
    model: config.model,
    ...(config.skills ? { skills: config.skills } : {}),
    workspace: config.workspace,
  });

  const mainAgent = createCodingAgent({
    defaultOptions: {
      autoResumeSuspendedTools: false,
      maxSteps: limits.mainMaxSteps,
    },
    description:
      "ReasonateAI's autonomous CTO that owns the complete product lifecycle from intent through verified deployment.",
    id: "reasonate-cto",
    instructions: MAIN_AGENT_INSTRUCTIONS,
    model: config.model,
    name: REASONATE_CTO_NAME,
    ...(config.skills ? { skills: config.skills } : {}),
    workspace: undefined,
  });

  const controller = new AgentController({
    id: config.controllerId ?? "reasonate-cto-controller",
    ...(config.resourceId ? { resourceId: config.resourceId } : {}),
    agent: mainAgent,
    ...(config.browser ? { browser: config.browser } : {}),
    defaultModeId: "cto",
    memory,
    modes: [
      {
        description:
          "Full autonomous product lifecycle authority with all approved run capabilities.",
        id: "cto",
        metadata: { default: true },
        name: REASONATE_CTO_NAME,
      },
    ],
    ...(config.storage ? { storage: config.storage } : {}),
    subagents: createCoreSubagents({
      ...(config.subagentModels?.coder
        ? { coderModel: config.subagentModels.coder }
        : {}),
      ...(config.subagentModels?.debugger
        ? { debuggerModel: config.subagentModels.debugger }
        : {}),
      maxCoderSteps: limits.workerMaxSteps,
      maxDebuggerSteps: limits.debuggerMaxSteps,
      maxScoutSteps: limits.scoutMaxSteps,
      ...(config.subagentModels?.scout
        ? { scoutModel: config.subagentModels.scout }
        : {}),
    }),
    tools: {
      ...config.tools,
      spawnCustomAgent: customAgent,
    },
    workspace: config.workspace,
  });

  return {
    controller,
    customAgent,
    limits,
    mainAgent,
  };
}
