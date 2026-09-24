import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCatalogFromDefinitions,
  diagnoseUnknownTools,
  getAgentDefinition,
  loadAgentCatalog,
} from "../src/agents/catalog.js";
import { BUILTIN_AGENT_DEFINITIONS } from "../src/agents/definitions/index.js";
import {
  reasonateToolUniverse,
  scoutWorkspaceTools,
  writeCapableTools,
} from "../src/agents/definitions/workers.js";
import {
  delegatableAgents,
  mayDelegate,
  refusalMessage,
  resolveDelegation,
} from "../src/agents/delegation.js";
import { parseAgentFrontmatter } from "../src/agents/frontmatter.js";
import { loadDiscoveredAgents } from "../src/agents/loader.js";
import {
  materializeDelegatableSubagents,
  materializeSubagent,
} from "../src/agents/materialize.js";
import {
  filterToolsByDefinition,
  holdsWriteCapableTool,
  normalizeToolName,
  unknownToolNames,
} from "../src/agents/tool-filter.js";
import type { AgentCatalog, AgentDefinition } from "../src/agents/types.js";

function frontmatter(header: string, body = "body"): string {
  return `---
${header}
---
${body}`;
}

const agent = (overrides: Partial<AgentDefinition> = {}): AgentDefinition => ({
  description: "test agent",
  mode: "subagent",
  name: "tester",
  prompt: "test prompt",
  ...overrides,
});

describe("frontmatter", () => {
  it("parses a header, aliases, lists, and a nested output block", () => {
    const raw = frontmatter(
      'name: reviewer\ndescription: Reviews a change\nmode: subagent\ntools: read, grep\ndisallowed-tools: write\nspawns: "*"\nblocking: yes\nmax-turns: 12\nthinking-level: HIGH\nread-summarize: false\noutput:\n  { "type": "object" }',
      "You review changes."
    );

    const parsed = parseAgentFrontmatter(raw, "reviewer.md");

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.frontmatter?.tools).toEqual(["read", "grep"]);
    expect(parsed.frontmatter?.disallowedTools).toEqual(["write"]);
    expect(parsed.frontmatter?.spawns).toBe("*");
    expect(parsed.frontmatter?.blocking).toBe(true);
    expect(parsed.frontmatter?.maxTurns).toBe(12);
    expect(parsed.frontmatter?.thinkingLevel).toBe("high");
    expect(parsed.frontmatter?.readSummarize).toBe(false);
    expect(parsed.frontmatter?.output).toEqual({ type: "object" });
    expect(parsed.body).toBe("You review changes.");
  });

  it("accepts a JSON array for a list field", () => {
    const parsed = parseAgentFrontmatter(
      `---\nname: a\ndescription: b\ntools: ["read", "write"]\n---\nbody`,
      "a.md"
    );

    expect(parsed.frontmatter?.tools).toEqual(["read", "write"]);
  });

  it("reports a missing block and an invalid enum without throwing", () => {
    const noBlock = parseAgentFrontmatter("just text", "a.md");
    expect(noBlock.frontmatter).toBe(null);
    expect(noBlock.diagnostics[0]?.kind).toBe("parse");

    const badMode = parseAgentFrontmatter(
      "---\nname: a\ndescription: b\nmode: wizard\n---\nbody",
      "b.md"
    );
    expect(badMode.diagnostics[0]?.kind).toBe("validation");
    expect(badMode.frontmatter?.mode).toBeUndefined();
  });

  it("ignores fields this contract does not model", () => {
    const parsed = parseAgentFrontmatter(
      "---\nname: a\ndescription: b\nutterly-unknown: 42\n---\nbody",
      "a.md"
    );

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.frontmatter?.name).toBe("a");
  });
});

describe("tool resolution", () => {
  const universe = ["read_file", "write_file", "edit_file", "execute_command"];

  it("inherits everything when no allowlist is given", () => {
    expect(filterToolsByDefinition(universe, agent())).toEqual(universe);
  });

  it("allowlists, then subtracts a denylist", () => {
    expect(
      filterToolsByDefinition(
        universe,
        agent({ tools: ["read_file", "write_file"] })
      )
    ).toEqual(["read_file", "write_file"]);

    expect(
      filterToolsByDefinition(
        universe,
        agent({
          disallowedTools: ["execute_command"],
          tools: ["read_file", "execute_command"],
        })
      )
    ).toEqual(["read_file"]);
  });

  it("resolves aliases so an author's spelling still matches", () => {
    expect(normalizeToolName("Read")).toBe("read_file");
    expect(normalizeToolName("bash")).toBe("execute_command");
    expect(
      filterToolsByDefinition(universe, agent({ tools: ["Read", "Bash"] }))
    ).toEqual(["read_file", "execute_command"]);
  });

  it("reports tool names the deployment does not provide", () => {
    expect(
      unknownToolNames(agent({ tools: ["read_file", "ghost"] }), universe)
    ).toEqual(["ghost"]);
  });

  it("detects whether resolved tools can write or execute", () => {
    const readOnly = filterToolsByDefinition(reasonateToolUniverse, {
      ...BUILTIN_AGENT_DEFINITIONS.scout,
    } as AgentDefinition);

    expect(holdsWriteCapableTool(readOnly, writeCapableTools)).toBe(false);
    expect(
      holdsWriteCapableTool(reasonateToolUniverse, writeCapableTools)
    ).toBe(true);
  });
});

describe("delegation guard", () => {
  const definitions = [
    agent({ mode: "primary", name: "cto" }),
    agent({ blocking: true, name: "scout", tools: [...scoutWorkspaceTools] }),
    agent({ name: "coder", spawns: ["scout"] }),
  ];

  const decide = (
    overrides: Partial<Parameters<typeof resolveDelegation>[0]> = {}
  ) =>
    resolveDelegation({
      definitions,
      depth: 0,
      from: "cto",
      maxDepth: 2,
      requested: "scout",
      spawnPolicy: "*",
      ...overrides,
    });

  it("allows a resolvable subagent", () => {
    expect(decide().allowed).toBe(true);
  });

  it("refuses an unknown agent rather than defaulting", () => {
    const decision = decide({ requested: "frontend" });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.refusal.reason).toBe("unknown-agent");
    }
  });

  it("refuses a primary agent as a delegation target", () => {
    const decision = decide({ requested: "cto" });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.refusal.reason).toBe("not-a-subagent");
      expect(refusalMessage(decision.refusal)).toContain("primary agent");
    }
  });

  it("refuses disabled agents and self-recursion, naming the real cause", () => {
    expect(decide({ disabled: ["scout"] }).allowed).toBe(false);
    expect(decide({ from: "scout", requested: "scout" }).allowed).toBe(false);

    const decision = decide({ depth: 99, from: "coder", requested: "coder" });
    if (!decision.allowed) {
      expect(decision.refusal.reason).toBe("self-recursion");
    }
  });

  it("honours the spawn policy and the depth limit", () => {
    expect(decide({ spawnPolicy: [] }).allowed).toBe(false);
    expect(decide({ spawnPolicy: ["coder"] }).allowed).toBe(false);
    expect(decide({ spawnPolicy: ["scout"] }).allowed).toBe(true);
    expect(decide({ depth: 1, maxDepth: 2 }).allowed).toBe(true);
    expect(decide({ depth: 2, maxDepth: 2 }).allowed).toBe(false);
  });

  it("treats an absent spawn policy as no delegation at all", () => {
    expect(mayDelegate(agent(), "scout")).toBe(false);
    expect(mayDelegate(agent({ spawns: "*" }), "anything")).toBe(true);
    expect(mayDelegate(agent({ spawns: ["scout"] }), "coder")).toBe(false);
  });

  it("lists only what an agent may actually reach", () => {
    const reach = delegatableAgents({
      all: definitions,
      definition: definitions[2] as AgentDefinition,
      depth: 0,
      maxDepth: 2,
      spawnPolicy: "*",
    });

    expect(reach).toEqual(["scout"]);
  });
});

function requireAgent(catalog: AgentCatalog, name: string): AgentDefinition {
  const found = getAgentDefinition(name, catalog);
  if (!found) {
    throw new Error(`Expected agent "${name}" in the catalog.`);
  }
  return found;
}

describe("catalog", () => {
  it("keeps hidden and primary agents out of the offered lists", () => {
    const catalog = buildCatalogFromDefinitions(BUILTIN_AGENT_DEFINITIONS);

    expect(catalog.subagents).toEqual(["coder", "debugger", "scout"]);
    expect(catalog.subagents).not.toContain("title");
    expect(catalog.subagents).not.toContain("compaction");
    // Hidden agents stay resolvable: that is what makes them useful.
    expect(getAgentDefinition("title", catalog)?.hidden).toBe(true);
    expect(getAgentDefinition("compaction", catalog)?.hidden).toBe(true);
  });

  it("diagnoses a definition that names a tool the deployment lacks", () => {
    const diagnostics = diagnoseUnknownTools(
      { broken: agent({ tools: ["ghost_tool"] }) },
      reasonateToolUniverse,
      (name) => `${name}.md`
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("ghost_tool");
  });

  it("lets a discovered agent replace a builtin of the same name", async () => {
    const root = await mkdtemp(join(tmpdir(), "reasonate-agents-"));
    const agentsDir = join(root, ".reasonate", "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, "scout.md"),
      "---\nname: scout\ndescription: A project override\nmode: subagent\ntools: read\n---\nProject scout prompt."
    );

    const catalog = await loadAgentCatalog({
      builtins: BUILTIN_AGENT_DEFINITIONS,
      cwd: root,
      toolUniverse: reasonateToolUniverse,
    });

    const override = requireAgent(catalog, "scout");
    expect(override.description).toBe("A project override");
    expect(override.prompt).toBe("Project scout prompt.");
    expect(override.source).toContain("scout.md");
    // The rest of the builtins survive.
    expect(requireAgent(catalog, "coder").name).toBe("coder");
  });

  it("discovers the nearest project definition over a parent one", async () => {
    const root = await mkdtemp(join(tmpdir(), "reasonate-nearest-"));
    const child = join(root, "packages", "app");
    const parentDir = join(root, ".reasonate", "agents");
    const childDir = join(child, ".reasonate", "agents");
    await mkdir(parentDir, { recursive: true });
    await mkdir(childDir, { recursive: true });

    await writeFile(
      join(parentDir, "helper.md"),
      frontmatter("name: helper\ndescription: from the parent", "Parent.")
    );
    await writeFile(
      join(childDir, "helper.md"),
      frontmatter("name: helper\ndescription: from the child", "Child.")
    );

    const discovered = await loadDiscoveredAgents(child);
    const helper = discovered.agents.find(
      ({ definition }) => definition.name === "helper"
    );

    expect(helper?.definition.description).toBe("from the child");
    expect(helper?.definition.prompt).toBe("Child.");
  });
});

describe("materialisation", () => {
  it("applies the definition's tool set to the Mastra subagent", () => {
    const scout = materializeSubagent(
      BUILTIN_AGENT_DEFINITIONS.scout as AgentDefinition
    );

    expect(scout.id).toBe("scout");
    expect(scout.allowedWorkspaceTools).toEqual([...scoutWorkspaceTools]);
  });

  it("omits a step cap unless one is configured", () => {
    const uncapped = materializeSubagent(
      BUILTIN_AGENT_DEFINITIONS.scout as AgentDefinition
    );
    expect(uncapped.maxSteps).toBeUndefined();

    const capped = materializeSubagent(
      BUILTIN_AGENT_DEFINITIONS.scout as AgentDefinition,
      { overrides: { scout: { maxTurns: 5 } } }
    );
    expect(capped.maxSteps).toBe(5);
  });

  it("does not offer hidden agents as delegation targets", () => {
    const ids = materializeDelegatableSubagents().map(({ id }) => id);

    expect(ids).toEqual(["coder", "debugger", "scout"]);
    expect(ids).not.toContain("title");
    expect(ids).not.toContain("compaction");
  });

  it("ships maintenance agents that are read-only and resolve by name", () => {
    const title = materializeSubagent(
      BUILTIN_AGENT_DEFINITIONS.title as AgentDefinition
    );
    const compaction = materializeSubagent(
      BUILTIN_AGENT_DEFINITIONS.compaction as AgentDefinition
    );

    expect(title.allowedWorkspaceTools).toEqual([]);
    expect(compaction.allowedWorkspaceTools).toEqual([]);
  });
});
