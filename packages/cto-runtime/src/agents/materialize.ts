import type { AgentControllerSubagent } from "@mastra/core/agent-controller";
import { BUILTIN_AGENT_DEFINITIONS } from "./definitions/index.js";
import { reasonateToolUniverse } from "./definitions/workers.js";
import { filterToolsByDefinition } from "./tool-filter.js";
import type { AgentDefinition } from "./types.js";

function displayNameFor(name: string): string {
  return `ReasonateAI ${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

export interface WorkerOverride {
  /** Optional hard step cap. Omitted means no cap. */
  maxTurns?: number;
  model?: string;
}

export type WorkerOverrides = Record<string, WorkerOverride | undefined>;

export interface MaterializeOptions {
  overrides?: WorkerOverrides;
  toolUniverse?: readonly string[];
}

/**
 * Turns a definition into a Mastra subagent definition.
 *
 * Tools come from the definition through the one resolution rule, so a Mastra
 * agent can never hold a tool its definition did not grant. A step cap is applied
 * only when one is configured.
 */
export function materializeSubagent(
  definition: AgentDefinition,
  options: MaterializeOptions = {}
): AgentControllerSubagent {
  const override = options.overrides?.[definition.name];
  const maxTurns = override?.maxTurns ?? definition.maxTurns;
  const modelId = override?.model ?? definition.model?.id;

  return {
    allowedWorkspaceTools: filterToolsByDefinition(
      options.toolUniverse ?? reasonateToolUniverse,
      definition
    ),
    description: definition.description,
    id: definition.name,
    instructions: definition.prompt,
    name: displayNameFor(definition.name),
    ...(maxTurns === undefined ? {} : { maxSteps: maxTurns }),
    ...(modelId ? { defaultModelId: modelId } : {}),
  };
}

/**
 * Materialises only the agents a runtime may delegate to.
 *
 * Hidden agents are excluded: they exist for the runtime to call by name, and
 * offering them as delegation targets would expose internal maintenance work as
 * something the orchestrator can choose.
 */
export function materializeDelegatableSubagents(
  options: MaterializeOptions & {
    definitions?: Record<string, AgentDefinition>;
  } = {}
): AgentControllerSubagent[] {
  const definitions = options.definitions ?? BUILTIN_AGENT_DEFINITIONS;

  return (
    Object.values(definitions)
      .filter(
        (definition) => !definition.hidden && definition.mode !== "primary"
      )
      // Sorted so the order is a property of the set, not of how the registry
      // record happened to be built.
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((definition) => materializeSubagent(definition, options))
  );
}
