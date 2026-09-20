import { z } from "zod";

/**
 * The subagent contract.
 *
 * Modelled on the harness contract in oh-my-pi: a definition is data, not code.
 * It names the role, describes when the orchestrator should reach for it, and
 * carries its own system prompt, capability profile, and spawn policy. The
 * runtime validates the data and materialises execution from it, so a second
 * way to declare an agent can never appear beside this one.
 *
 * This module is deliberately free of Mastra imports. Tool sets are supplied by
 * the caller, which keeps the contract testable without a runtime.
 */

export const subagentCapabilityProfiles = [
  "research",
  "implementation",
  "bugfix",
] as const;
export const SubagentCapabilityProfileSchema = z.enum(
  subagentCapabilityProfiles
);
export type SubagentCapabilityProfile = z.infer<
  typeof SubagentCapabilityProfileSchema
>;

/** Identifiers are lowercase so they read the same everywhere they appear. */
export const SubagentNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/);

/**
 * `spawns` answers "which agent types may this agent reach?". `"*"` allows any
 * resolvable type; an array allowlists by exact name. An absent value means the
 * agent cannot delegate at all, which is the safe default.
 */
export const SubagentSpawnsSchema = z.union([
  z.literal("*"),
  z.array(SubagentNameSchema).min(1),
]);
export type SubagentSpawns = z.infer<typeof SubagentSpawnsSchema>;

export const SubagentDefinitionSchema = z.strictObject({
  /** Whether a delegation waits for the result or runs in the background. */
  blocking: z.boolean(),
  /**
   * Which capability profile governs the tools this agent may hold. A profile is
   * a ceiling: `declaredTools` may narrow it, never widen it.
   */
  capability: SubagentCapabilityProfileSchema,
  /** Narrowing allowlist. Omitted means every tool the profile permits. */
  declaredTools: z.array(z.string().min(1)).optional(),
  description: z.string().min(1).max(500),
  /** Bounded step budget, so no agent can run unbounded. */
  maxSteps: z.number().int().min(1).max(256),
  model: z.string().min(1).max(128).optional(),
  name: SubagentNameSchema,
  /** Optional structured result schema the orchestrator can rely on. */
  output: z.record(z.string(), z.unknown()).optional(),
  spawns: SubagentSpawnsSchema.optional(),
  systemPrompt: z.string().min(1).max(12_000),
});
export type SubagentDefinition = z.infer<typeof SubagentDefinitionSchema>;

export interface SubagentToolSets {
  bugfix: readonly string[];
  implementation: readonly string[];
  research: readonly string[];
}

export type DelegationRefusal =
  | { reason: "unknown-agent"; requested: string }
  | { reason: "agent-disabled"; requested: string }
  | { reason: "spawn-denied"; from: string; requested: string }
  | { reason: "depth-exceeded"; depth: number; maxDepth: number }
  | { reason: "self-recursion"; requested: string };

export type DelegationDecision =
  | { allowed: true; definition: SubagentDefinition }
  | { allowed: false; refusal: DelegationRefusal };

/**
 * Checks a definition against the tool sets it claims and the agents that exist.
 * Returns every problem rather than the first, so one authoring pass fixes all
 * of them.
 */
export function validateSubagentDefinition(
  definition: SubagentDefinition,
  input: { knownAgentNames: readonly string[]; toolSets: SubagentToolSets }
): string[] {
  const issues: string[] = [];
  const permitted = input.toolSets[definition.capability];

  for (const tool of definition.declaredTools ?? []) {
    if (!permitted.includes(tool)) {
      issues.push(
        `Tool "${tool}" is outside the "${definition.capability}" capability profile.`
      );
    }
  }

  if (definition.spawns !== undefined && definition.spawns !== "*") {
    for (const spawned of definition.spawns) {
      if (!input.knownAgentNames.includes(spawned)) {
        issues.push(`Spawns unknown agent "${spawned}".`);
      }
      if (spawned === definition.name) {
        issues.push(`Agent "${definition.name}" cannot spawn itself.`);
      }
    }
  }

  return issues;
}

/**
 * Resolves a delegation request against the spawn policy, recursion depth, and
 * the definitions that exist. Every refusal is typed, so the orchestrator can
 * report why rather than silently falling back to a different agent.
 */
export function resolveDelegation(input: {
  definitions: readonly SubagentDefinition[];
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
 * The tool names an agent may actually hold: its profile, narrowed by its own
 * allowlist. This is the single place capability ceilings are applied.
 */
export function effectiveTools(
  definition: SubagentDefinition,
  toolSets: SubagentToolSets
): string[] {
  const permitted = toolSets[definition.capability];
  if (definition.declaredTools === undefined) {
    return [...permitted];
  }
  return permitted.filter((tool) => definition.declaredTools?.includes(tool));
}

/**
 * Whether this agent may delegate at all, and to whom. A definition that cannot
 * spawn has no delegation path regardless of depth.
 */
export function mayDelegate(
  definition: SubagentDefinition,
  childName: string
): boolean {
  if (definition.spawns === undefined) {
    return false;
  }
  return definition.spawns === "*" || definition.spawns.includes(childName);
}

export function refusalMessage(refusal: DelegationRefusal): string {
  switch (refusal.reason) {
    case "unknown-agent":
      return `Unknown agent type "${refusal.requested}".`;
    case "agent-disabled":
      return `Agent type "${refusal.requested}" is disabled.`;
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
