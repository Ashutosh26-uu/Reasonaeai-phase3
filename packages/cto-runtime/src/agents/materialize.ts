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
  maxTurns?: number | undefined;
  model?: string | undefined;
  tools?: AgentControllerSubagent["tools"] | undefined;
}

export type WorkerOverrides = Record<string, WorkerOverride | undefined>;

export interface MaterializeOptions {
  /**
   * Model every worker falls back to. Without one, a worker is built with no
   * model id at all and the controller refuses to spawn it, so delegation is
   * unreachable even though the definition and its tools are valid.
   */
  defaultModelId?: string | undefined;
  instructions?: (
    definition: AgentDefinition
  ) => AgentControllerSubagent["instructions"];
  overrides?: WorkerOverrides;
  /** Explicitly share only direct tools granted by the definition. Workspace allowlists do not filter these. */
  tools?: AgentControllerSubagent["tools"];
  toolUniverse?: readonly string[];
}

/**
 * Turns a definition into a Mastra subagent definition.
 *
 * Tools come from the definition through the one resolution rule, so a Mastra
 * agent can never hold a tool its definition did not grant. A step cap is applied
 * only when one is configured. The model resolves from the worker override, then
 * the definition, then the run's model.
 */
export function materializeSubagent(
  definition: AgentDefinition,
  options: MaterializeOptions = {}
): AgentControllerSubagent {
  const override = options.overrides?.[definition.name];
  const maxTurns = override?.maxTurns ?? definition.maxTurns;
  const modelId =
    override?.model ?? definition.model?.id ?? options.defaultModelId;
  const directTools = options.tools ?? {};
  const permitted = new Set(
    filterToolsByDefinition(Object.keys(directTools), definition)
  );
  const directFilteredTools =
    options.tools === undefined
      ? {}
      : Object.fromEntries(
          Object.entries(directTools).filter(([name]) => permitted.has(name))
        );
  const mergedTools = {
    ...directFilteredTools,
    ...(override?.tools ?? {}),
  };

  return {
    allowedWorkspaceTools: filterToolsByDefinition(
      options.toolUniverse ?? reasonateToolUniverse,
      definition
    ),
    description: definition.description,
    id: definition.name,
    instructions: options.instructions?.(definition) ?? definition.prompt,
    name: displayNameFor(definition.name),
    ...(options.tools === undefined && !override?.tools
      ? {}
      : { tools: mergedTools }),
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
