import { describe, expect, it } from "vitest";

import {
  BUILTIN_TOOL_NAMES,
  normalizeToolName,
  normalizeToolNames,
  type ToolRegistration,
  ToolRegistry,
} from "../src/tools/registry.js";

const demo: ToolRegistration[] = [
  {
    access: ["read"],
    description: "reads",
    name: "read",
    surface: "workspace",
  },
  {
    access: ["write"],
    description: "edits",
    name: "edit",
    surface: "workspace",
  },
  {
    access: ["execute"],
    description: "runs",
    name: "bash",
    surface: "workspace",
  },
  {
    access: ["delegate"],
    description: "delegates",
    name: "task",
    surface: "delegation",
  },
];

describe("tool name normalization", () => {
  it("resolves the names another harness would use for the same tool", () => {
    expect(normalizeToolName("search")).toBe("grep");
    expect(normalizeToolName("find")).toBe("glob");
    expect(normalizeToolName("SHELL")).toBe("bash");
  });

  it("leaves an unknown name recognizable rather than mapping it somewhere surprising", () => {
    expect(normalizeToolName("frobnicate")).toBe("frobnicate");
  });

  it("deduplicates names that resolve to the same tool, keeping first-seen order", () => {
    expect(normalizeToolNames(["search", "grep", "read", "SEARCH"])).toEqual([
      "grep",
      "read",
    ]);
  });
});

describe("tool registry classification", () => {
  it("derives the read-only set from declarations instead of a hand-kept list", () => {
    const registry = new ToolRegistry(demo);
    // Only `read` declares nothing beyond reading, so it is the only safe tool
    // for an investigator. `task` delegates, which is not a read.
    expect(registry.namesWithin(["read"])).toEqual(["read"]);
  });

  it("treats any mutating, executing, or networked tool as unsuitable for a read-only agent", () => {
    const registry = new ToolRegistry(demo);
    expect(registry.mutatingNames()).toEqual(["bash", "edit"]);
  });

  it("classifies a newly added mutating tool without any other file changing", () => {
    // This is the property that makes the registry worth having: the
    // classification cannot drift from the declaration.
    const registry = new ToolRegistry([
      ...demo,
      {
        access: ["execute"],
        description: "ships",
        name: "deploy",
        surface: "control",
      },
    ]);
    expect(registry.mutatingNames()).toContain("deploy");
    expect(registry.namesWithin(["read"])).not.toContain("deploy");
  });

  it("counts a networked read as mutating reach, not as a safe read", () => {
    const registry = new ToolRegistry([
      {
        access: ["read", "network"],
        description: "fetches",
        name: "web_fetch",
        surface: "resource",
      },
    ]);
    expect(registry.namesWithin(["read"])).toEqual([]);
    expect(registry.mutatingNames()).toEqual(["web_fetch"]);
  });

  it("looks a tool up by an alias as well as its canonical name", () => {
    const registry = new ToolRegistry(demo);
    expect(registry.get("read")?.name).toBe("read");
    expect(registry.get("read")?.surface).toBe("workspace");
  });
});

describe("unknown tool diagnosis", () => {
  it("reports an unknown name with a plausible correction", () => {
    const registry = new ToolRegistry(demo);
    const problems = registry.diagnose(["reading", "edit", "writ"]);

    expect(problems.map((problem) => problem.name)).toEqual([
      "reading",
      "writ",
    ]);
    expect(problems[0]?.suggestion).toBe("read");
  });

  it("offers nothing when no name is close, because a bad suggestion misleads", () => {
    const registry = new ToolRegistry(demo);
    expect(registry.suggest("zzzzzz")).toBeUndefined();
  });

  it("accepts every canonical name, so the list and the registry cannot disagree", () => {
    const registry = new ToolRegistry();
    expect(registry.diagnose(BUILTIN_TOOL_NAMES)).toEqual([]);
  });
});
