import type { AgentDefinition } from "../types.js";
import { compactionAgent, titleAgent } from "./hidden.js";
import { coderAgent, debuggerAgent, scoutAgent } from "./workers.js";

/**
 * The built-in agent set.
 *
 * Every agent here is the same interface. What differs is the tools it holds,
 * the prompt it runs under, and whether it is offered. `hidden` agents are
 * resolvable by the runtime but absent from the offered lists, which is how
 * title generation and context compaction stay in the same system instead of
 * growing a parallel path.
 */
export const BUILTIN_AGENT_DEFINITIONS: Record<string, AgentDefinition> = {
  [coderAgent.name]: coderAgent,
  [compactionAgent.name]: compactionAgent,
  [debuggerAgent.name]: debuggerAgent,
  [scoutAgent.name]: scoutAgent,
  [titleAgent.name]: titleAgent,
};

/** Agents the user may be offered for direct selection. */
export const OFFERED_AGENT_NAMES: string[] = Object.values(
  BUILTIN_AGENT_DEFINITIONS
)
  .filter((agent) => !agent.hidden)
  .map((agent) => agent.name);
