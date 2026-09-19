import type { AgentControllerSubagent } from "@mastra/core/agent-controller";
import { WORKSPACE_TOOLS } from "@mastra/core/workspace";
import {
  CODER_INSTRUCTIONS,
  DEBUGGER_INSTRUCTIONS,
  SCOUT_INSTRUCTIONS,
} from "./prompts.js";

export const scoutWorkspaceTools = [
  WORKSPACE_TOOLS.FILESYSTEM.READ_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES,
  WORKSPACE_TOOLS.FILESYSTEM.FILE_STAT,
  WORKSPACE_TOOLS.FILESYSTEM.GREP,
  WORKSPACE_TOOLS.SEARCH.SEARCH,
  WORKSPACE_TOOLS.LSP.LSP_INSPECT,
] as const;

export const fullWorkspaceTools = [
  ...Object.values(WORKSPACE_TOOLS.FILESYSTEM),
  ...Object.values(WORKSPACE_TOOLS.SANDBOX),
  ...Object.values(WORKSPACE_TOOLS.COMPUTER),
  ...Object.values(WORKSPACE_TOOLS.SEARCH),
  ...Object.values(WORKSPACE_TOOLS.LSP),
];

export function createCoreSubagents(input: {
  coderModel?: string;
  debuggerModel?: string;
  maxCoderSteps: number;
  maxDebuggerSteps: number;
  maxScoutSteps: number;
  scoutModel?: string;
}): AgentControllerSubagent[] {
  return [
    {
      allowedWorkspaceTools: [...scoutWorkspaceTools],
      description:
        "Investigates a focused question through read-only file, search, and language-intelligence tools.",
      id: "scout",
      instructions: SCOUT_INSTRUCTIONS,
      name: "ReasonateAI Scout",
      ...(input.scoutModel ? { defaultModelId: input.scoutModel } : {}),
      maxSteps: input.maxScoutSteps,
    },
    {
      allowedWorkspaceTools: fullWorkspaceTools,
      description:
        "Implements and verifies one bounded product objective with full workspace and execution capabilities.",
      id: "coder",
      instructions: CODER_INSTRUCTIONS,
      name: "ReasonateAI Coder",
      ...(input.coderModel ? { defaultModelId: input.coderModel } : {}),
      maxSteps: input.maxCoderSteps,
    },
    {
      allowedWorkspaceTools: fullWorkspaceTools,
      description:
        "Reproduces an evidence-backed failure, repairs its root cause, and reruns the failed scenario.",
      id: "debugger",
      instructions: DEBUGGER_INSTRUCTIONS,
      name: "ReasonateAI Debugger",
      ...(input.debuggerModel ? { defaultModelId: input.debuggerModel } : {}),
      maxSteps: input.maxDebuggerSteps,
    },
  ];
}
