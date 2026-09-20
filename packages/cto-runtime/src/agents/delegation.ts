import type { AgentDefinition } from "./types.js";

/**
 * The delegation guard.
 *
 * Agent definitions in Spectra carry no notion of who may reach whom, so nothing
 * stops an agent from spawning an agent that spawns it back, or from reaching a
 * privileged agent it should never touch. These are the guardrails oh-my-pi
 * applies at the delegation boundary, expressed as pure functions so the policy
 * is testable without a runtime.
 */

export type DelegationRefusal =
  | { reason: "unknown-agent"; requested: string }
  | { reason: "agent-disabled"; requested: string }
  | { reason: "not-a-subagent"; requested: string }
  | { reason: "spawn-denied"; from: string; requested: string }
  | { reason: "depth-exceeded"; depth: number; maxDepth: number }
  | { reason: "self-recursion"; requested: string };

export type DelegationDecision =
  | { allowed: true; definition: AgentDefinition }
  | { allowed: false; refusal: DelegationRefusal };

/**
 * Resolves a delegation request against the spawn policy, recursion depth, and
 * the definitions that exist. Every refusal is typed, so the orchestrator can
 * report why rather than silently falling back to a different agent.
 */
export function resolveDelegation(input: {
  definitions: readonly AgentDefinition[];
  depth: number;
  disabled?: readonly string[];
  from: string;
  maxDepth: number;
  /** `"*"` allows any, `[]` denies all, an array allowlists by exact name. */
  spawnPolicy: "*" | readonly string[];
  requested: string;
}): DelegationDecision {
  const definition = input.definitions.find(
    ({ name }) => name === input.requested
  );

  if (!definition) {
    return {
      allowed: false,
      refusal: { reason: "unknown-agent", requested: input.requested },
    };
  }

  if (input.disabled?.includes(input.requested)) {
    return {
      allowed: false,
      refusal: { reason: "agent-disabled", requested: input.requested },
    };
  }

  // A primary agent is not a delegation target, however it is configured.
  if (definition.mode === "primary") {
    return {
      allowed: false,
      refusal: { reason: "not-a-subagent", requested: input.requested },
    };
  }

  // Self-recursion is checked before depth so the refusal names the real cause.
  if (input.requested === input.from) {
    return {
      allowed: false,
      refusal: { reason: "self-recursion", requested: input.requested },
    };
  }

  const deniedByPolicy =
    input.spawnPolicy !== "*" && !input.spawnPolicy.includes(input.requested);
  if (deniedByPolicy) {
    return {
      allowed: false,
      refusal: {
        from: input.from,
        reason: "spawn-denied",
        requested: input.requested,
      },
    };
  }

  if (input.depth >= input.maxDepth) {
    return {
      allowed: false,
      refusal: {
        depth: input.depth,
        maxDepth: input.maxDepth,
        reason: "depth-exceeded",
      },
    };
  }

  return { allowed: true, definition };
}

/**
 * Whether an agent may delegate at all, and to whom.
 *
 * An absent `spawns` means no delegation. That is deliberately the safe default:
 * an agent should be granted reach explicitly rather than inherit it, and the
 * legacy behaviour of inferring reach from a tool list is not honoured.
 */
export function mayDelegate(
  definition: AgentDefinition,
  childName: string
): boolean {
  if (definition.spawns === undefined) {
    return false;
  }
  return definition.spawns === "*" || definition.spawns.includes(childName);
}

/**
 * The agents a given agent is allowed to reach, given a catalog and policy.
 */
export function delegatableAgents(input: {
  all: readonly AgentDefinition[];
  definition: AgentDefinition;
  disabled?: readonly string[];
  spawnPolicy: "*" | readonly string[];
  depth: number;
  maxDepth: number;
}): string[] {
  return input.all
    .filter(({ name }) => mayDelegate(input.definition, name))
    .filter(
      ({ name }) =>
        resolveDelegation({
          definitions: input.all,
          depth: input.depth,
          ...(input.disabled ? { disabled: input.disabled } : {}),
          from: input.definition.name,
          maxDepth: input.maxDepth,
          requested: name,
          spawnPolicy: input.spawnPolicy,
        }).allowed
    )
    .map(({ name }) => name);
}

export function refusalMessage(refusal: DelegationRefusal): string {
  switch (refusal.reason) {
    case "unknown-agent":
      return `Unknown agent type "${refusal.requested}".`;
    case "agent-disabled":
      return `Agent type "${refusal.requested}" is disabled.`;
    case "not-a-subagent":
      return `Agent type "${refusal.requested}" is a primary agent and cannot be delegated to.`;
    case "self-recursion":
      return `Agent type "${refusal.requested}" cannot delegate to itself.`;
    case "spawn-denied":
      return `"${refusal.from}" is not permitted to delegate to "${refusal.requested}".`;
    case "depth-exceeded":
      return `Delegation depth ${refusal.depth} has reached the limit of ${refusal.maxDepth}.`;
    default: {
      // Exhaustive over the union; an unhandled refusal is a programming error.
      const unhandled: never = refusal;
      throw new Error(`Unhandled delegation refusal: ${String(unhandled)}`);
    }
  }
}
