import { describe, expect, it } from "vitest";
import {
  effectiveTools,
  mayDelegate,
  refusalMessage,
  resolveDelegation,
  type SubagentDefinition,
  SubagentDefinitionSchema,
  type SubagentToolSets,
  validateSubagentDefinition,
} from "../src/subagent-contract.js";
import {
  coreSubagentDefinitions,
  coreToolSets,
  createCoreSubagents,
  fullWorkspaceTools,
  scoutWorkspaceTools,
} from "../src/subagents.js";

const toolSets: SubagentToolSets = {
  bugfix: ["read", "write", "execute"],
  implementation: ["read", "write", "execute"],
  research: ["read", "search"],
};

function definition(
  overrides: Partial<SubagentDefinition> = {}
): SubagentDefinition {
  return SubagentDefinitionSchema.parse({
    blocking: true,
    capability: "research",
    description: "Investigates one question.",
    maxSteps: 8,
    name: "scout",
    systemPrompt: "You investigate.",
    ...overrides,
  });
}

describe("subagent definition contract", () => {
  it("rejects a definition that carries fields the contract does not declare", () => {
    expect(() =>
      SubagentDefinitionSchema.parse({
        ...definition(),
        tools: ["read"],
      })
    ).toThrow();
  });

  it("rejects an identifier or step budget a runtime cannot rely on", () => {
    expect(() => definition({ name: "Scout" })).toThrow();
    expect(() => definition({ name: "scout agent" })).toThrow();
    expect(() => definition({ maxSteps: 0 })).toThrow();
    expect(() => definition({ maxSteps: 257 })).toThrow();
    expect(() => definition({ systemPrompt: "" })).toThrow();
  });

  it("accepts an unbounded spawn policy or an explicit allowlist only", () => {
    expect(definition({ spawns: "*" }).spawns).toBe("*");
    expect(definition({ spawns: ["scout"] }).spawns).toEqual(["scout"]);
    expect(() => definition({ spawns: [] })).toThrow();
  });
});

describe("capability ceilings", () => {
  it("refuses a tool that its capability profile does not permit", () => {
    const issues = validateSubagentDefinition(
      definition({ declaredTools: ["read", "execute"] }),
      { knownAgentNames: ["scout"], toolSets }
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("execute");
    expect(issues[0]).toContain("research");
  });

  it("narrows with an allowlist and never widens past the profile", () => {
    expect(effectiveTools(definition(), toolSets)).toEqual(["read", "search"]);
    expect(
      effectiveTools(definition({ declaredTools: ["read"] }), toolSets)
    ).toEqual(["read"]);
    // A declared tool outside the profile cannot appear, even if asked for.
    expect(
      effectiveTools(definition({ declaredTools: ["execute"] }), toolSets)
    ).toEqual([]);
  });

  it("reports a spawn target that does not exist, or that is the agent itself", () => {
    const issues = validateSubagentDefinition(
      definition({ name: "coder", spawns: ["ghost", "coder"] }),
      { knownAgentNames: ["scout", "coder"], toolSets }
    );

    expect(issues.some((issue) => issue.includes("ghost"))).toBe(true);
    expect(issues.some((issue) => issue.includes("cannot spawn itself"))).toBe(
      true
    );
  });
});

describe("delegation resolution", () => {
  const definitions = [
    definition({ blocking: true, name: "scout" }),
    definition({
      blocking: false,
      capability: "implementation",
      name: "coder",
      spawns: ["scout"],
    }),
  ];

  function decide(overrides: Partial<Parameters<typeof resolveDelegation>[0]>) {
    return resolveDelegation({
      definitions,
      depth: 0,
      from: "cto",
      maxDepth: 2,
      requested: "scout",
      spawnPolicy: "*",
      ...overrides,
    });
  }

  it("allows a known, permitted agent and returns its definition", () => {
    const decision = decide({});
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.definition.name).toBe("scout");
      expect(decision.definition.blocking).toBe(true);
    }
  });

  it("refuses an unknown agent instead of falling back to a default", () => {
    const decision = decide({ requested: "frontend" });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.refusal.reason).toBe("unknown-agent");
      expect(refusalMessage(decision.refusal)).toContain("frontend");
    }
  });

  it("refuses a disabled agent", () => {
    const decision = decide({ disabled: ["scout"] });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.refusal.reason).toBe("agent-disabled");
    }
  });

  it("refuses self-recursion and names that cause before depth", () => {
    const decision = decide({
      depth: 99,
      from: "coder",
      requested: "coder",
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.refusal.reason).toBe("self-recursion");
    }
  });

  it("denies every delegation under an empty policy and allowlists otherwise", () => {
    expect(decide({ spawnPolicy: [] }).allowed).toBe(false);
    expect(decide({ spawnPolicy: ["coder"] }).allowed).toBe(false);
    expect(decide({ spawnPolicy: ["scout"] }).allowed).toBe(true);

    const denied = decide({ spawnPolicy: [] });
    if (!denied.allowed) {
      expect(refusalMessage(denied.refusal)).toContain("not permitted");
    }
  });

  it("refuses delegation once the depth limit is reached", () => {
    expect(decide({ depth: 1, maxDepth: 2 }).allowed).toBe(true);

    const decision = decide({ depth: 2, maxDepth: 2 });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.refusal.reason).toBe("depth-exceeded");
      expect(refusalMessage(decision.refusal)).toContain("limit of 2");
    }
  });

  it("treats an absent spawn policy as no delegation at all", () => {
    expect(mayDelegate(definition(), "scout")).toBe(false);
    expect(mayDelegate(definition({ spawns: "*" }), "anything")).toBe(true);
    expect(mayDelegate(definition({ spawns: ["scout"] }), "scout")).toBe(true);
    expect(mayDelegate(definition({ spawns: ["scout"] }), "coder")).toBe(false);
  });
});

describe("shipped worker definitions", () => {
  it("are internally consistent with the tool sets they claim", () => {
    const names = coreSubagentDefinitions.map(({ name }) => name);

    for (const core of coreSubagentDefinitions) {
      expect(
        validateSubagentDefinition(core, {
          knownAgentNames: names,
          toolSets: coreToolSets,
        })
      ).toEqual([]);
    }
  });

  it("keep the reader read-only and give the writers execution", () => {
    const [scout, coder, debuggerAgent] = createCoreSubagents({
      maxCoderSteps: 20,
      maxDebuggerSteps: 24,
      maxScoutSteps: 8,
    });

    expect(scout?.allowedWorkspaceTools).toEqual([...scoutWorkspaceTools]);
    expect(scout?.maxSteps).toBe(8);
    expect(coder?.allowedWorkspaceTools).toEqual(fullWorkspaceTools);
    expect(debuggerAgent?.allowedWorkspaceTools).toEqual(fullWorkspaceTools);
  });

  it("honours a per-deployment model and step override", () => {
    const [, coder] = createCoreSubagents({
      coderModel: "openai/gpt-5-mini",
      maxCoderSteps: 7,
      maxDebuggerSteps: 24,
      maxScoutSteps: 8,
    });

    expect(coder?.maxSteps).toBe(7);
    expect(coder?.defaultModelId).toBe("openai/gpt-5-mini");
  });
});
