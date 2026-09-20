import type { AgentControllerSubagent } from "@mastra/core/agent-controller";
import { WORKSPACE_TOOLS } from "@mastra/core/workspace";
import {
  CODER_INSTRUCTIONS,
  DEBUGGER_INSTRUCTIONS,
  SCOUT_INSTRUCTIONS,
} from "./prompts.js";
import {
  effectiveTools,
  type SubagentDefinition,
  type SubagentToolSets,
} from "./subagent-contract.js";

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

/**
 * Capability profiles as tool sets. A definition selects one and may narrow it,
 * never widen it. Research is the read-only floor; implementation and bugfix
 * carry the full surface, and differ only in their working contract.
 */
export const coreToolSets: SubagentToolSets = {
  bugfix: fullWorkspaceTools,
  implementation: fullWorkspaceTools,
  research: [...scoutWorkspaceTools],
};

/**
 * The core worker vocabulary, declared as contract data.
 *
 * Workers are deliberately few. Frontend, backend, database, infrastructure,
 * accessibility, security, and release engineering are task objectives handed to
 * these agents, not permanent identities, so the vocabulary does not grow with
 * the product.
 *
 * `spawns` is present only where further delegation is genuinely useful: a
 * read-only investigator has nothing to delegate, and the orchestrator's own
 * reach is governed by the runtime, not by this list.
 */
export const coreSubagentDefinitions: SubagentDefinition[] = [
  {
    blocking: true,
    capability: "research",
    description:
      "Investigates a focused question through read-only file, search, and language-intelligence tools.",
    maxSteps: 12,
    name: "scout",
    systemPrompt: SCOUT_INSTRUCTIONS,
  },
  {
    blocking: false,
    capability: "implementation",
    description:
      "Implements and verifies one bounded product objective with full workspace and execution capabilities.",
    maxSteps: 32,
    name: "coder",
    spawns: ["scout"],
    systemPrompt: CODER_INSTRUCTIONS,
  },
  {
    blocking: false,
    capability: "bugfix",
    description:
      "Reproduces an evidence-backed failure, repairs its root cause, and reruns the failed scenario.",
    maxSteps: 32,
    name: "debugger",
    spawns: ["scout"],
    systemPrompt: DEBUGGER_INSTRUCTIONS,
  },
];

function displayNameFor(name: string): string {
  return `ReasonateAI ${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

export interface CoreSubagentOverrides {
  coderModel?: string;
  debuggerModel?: string;
  maxCoderSteps: number;
  maxDebuggerSteps: number;
  maxScoutSteps: number;
  scoutModel?: string;
}

/**
 * Materialises the contract into Mastra subagent definitions. Step budgets and
 * models may be overridden per deployment; everything else comes from the
 * contract so there is no second place an agent can be described.
 */
export function createCoreSubagents(
  overrides: CoreSubagentOverrides
): AgentControllerSubagent[] {
  const stepsFor: Record<string, number> = {
    coder: overrides.maxCoderSteps,
    debugger: overrides.maxDebuggerSteps,
    scout: overrides.maxScoutSteps,
  };
  const modelFor: Record<string, string | undefined> = {
    coder: overrides.coderModel,
    debugger: overrides.debuggerModel,
    scout: overrides.scoutModel,
  };

  return coreSubagentDefinitions.map((definition) => {
    const model = modelFor[definition.name] ?? definition.model;
    return {
      allowedWorkspaceTools: effectiveTools(definition, coreToolSets),
      description: definition.description,
      id: definition.name,
      instructions: definition.systemPrompt,
      maxSteps: stepsFor[definition.name] ?? definition.maxSteps,
      name: displayNameFor(definition.name),
      ...(model ? { defaultModelId: model } : {}),
    };
  });
}
