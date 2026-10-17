import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import {
  LocalFilesystem,
  WORKSPACE_TOOLS,
  Workspace,
} from "@mastra/core/workspace";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkspaceInstructions } from "../src/context/workspace-instructions.js";
import { BUNDLED_RULES, BUNDLED_SKILLS } from "../src/guidance/bundled.js";
import {
  renderBundledRules,
  renderRuleCatalog,
  renderSkillCatalog,
} from "../src/guidance/catalog.js";
import { createRunResources } from "../src/resources/handlers/index.js";
import { readRunScope, runScopeKeys } from "../src/run-scope.js";
import { createReasonateCtoRuntime } from "../src/runtime.js";

const temporary: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "reasonate-guidance-"));
  temporary.push(root);
  const filesystem = new LocalFilesystem({ basePath: root });
  const requestContext = new RequestContext();
  for (const key of Object.values(runScopeKeys)) {
    requestContext.setRaw(key, randomUUID());
  }
  const scope = readRunScope(requestContext);
  return { filesystem, requestContext, root, scope };
}
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true }))
  );
});

describe("bundled guidance composition", () => {
  it("keeps the always-applied policy small and scoped rules out of the prompt", () => {
    const applied = renderBundledRules();
    const always = BUNDLED_RULES.filter((rule) => rule.always);
    const scoped = BUNDLED_RULES.filter((rule) => !rule.always);

    expect(always.length).toBeGreaterThan(0);
    expect(scoped.length).toBeGreaterThan(0);
    for (const rule of always) {
      expect(applied).toContain(rule.content);
      expect(rule.globs).toEqual([]);
      expect(renderRuleCatalog()).not.toContain(`rule://${rule.name} (`);
    }
    for (const rule of scoped) {
      // A scoped rule is advertised, never injected: the whole point is that a Go
      // rule costs no context on a Next.js run.
      expect(applied).not.toContain(rule.content);
      expect(renderRuleCatalog()).toContain(
        `- rule://${rule.name} (${rule.globs.join(", ")}) — ${rule.description}`
      );
    }
  });

  it("advertises every skill by name and description", () => {
    const catalog = renderSkillCatalog();
    for (const skill of BUNDLED_SKILLS) {
      expect(catalog).toContain(
        `- skill://${skill.name} — ${skill.description}`
      );
    }
  });

  it("lists scoped rules and skills through the read surface", async () => {
    const { root, scope } = await fixture();
    const { router } = createRunResources({
      cwd: "/workspace",
      instructionSources: [],
      root,
      scope,
    });
    const context = { cwd: "/workspace", scope };
    const rules = await router.resolve("rule://", context);
    const skills = await router.resolve("skill://", context);
    for (const rule of BUNDLED_RULES) {
      expect(rules.content).toContain(`rule://${rule.name}`);
    }
    for (const skill of BUNDLED_SKILLS) {
      expect(skills.content).toContain(`skill://${skill.name}`);
    }
    const scoped = await router.resolve("rule://typescript", context);
    expect(scoped.content).toBe(
      BUNDLED_RULES.find((rule) => rule.name === "typescript")?.content
    );
  });

  it("gives the CTO the policy inline and the scoped catalogs by reference", async () => {
    const { filesystem, requestContext } = await fixture();
    const workspace = new Workspace({ filesystem, id: "guidance-prompt" });
    const runtime = createReasonateCtoRuntime({
      budget: { tokens: 100 },
      model: "deepseek/deepseek-flash",
      workspace,
      workspaceRoot: "/workspace",
    });
    const prompt = await runtime.mainAgent.getInstructions({ requestContext });

    for (const rule of BUNDLED_RULES.filter((entry) => entry.always)) {
      expect(prompt).toContain(rule.content);
    }
    const scoped = BUNDLED_RULES.filter((entry) => !entry.always);
    for (const rule of scoped) {
      // The bulk of a scoped rule must not be in the prompt: the catalog line is
      // what buys the on-demand read, and the body is what it costs.
      expect(prompt).not.toContain(rule.content);
      expect(prompt).toContain(
        `rule://${rule.name} (${rule.globs.join(", ")})`
      );
    }
    for (const skill of BUNDLED_SKILLS) {
      expect(prompt).toContain(`skill://${skill.name} — ${skill.description}`);
      expect(prompt).not.toContain(skill.content);
    }
  });

  it("keeps the generated module current with the authored markdown", () => {
    // A rule edited without regenerating would otherwise ship the previous
    // wording to every run, which no runtime check can detect.
    expect(() =>
      execFileSync(
        process.execPath,
        ["scripts/generate-guidance.mjs", "--check"],
        {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          stdio: "pipe",
        }
      )
    ).not.toThrow();
  });
});

describe("bundled guidance and verified project instructions", () => {
  it("reads empty project rules and every advertised bundled item without a missing-file failure", async () => {
    const { root, scope } = await fixture();
    const { router } = createRunResources({
      cwd: "/workspace",
      instructionSources: [],
      root,
      scope,
    });
    const context = { cwd: "/workspace", scope };
    const listing = await router.resolve("rule://", context);
    expect(listing.content).toContain("No project-specific instruction files");
    for (const [scheme, entries] of [
      ["rule", BUNDLED_RULES],
      ["skill", BUNDLED_SKILLS],
    ] as const) {
      for (const entry of entries) {
        // biome-ignore lint/performance/noAwaitInLoops: each advertised item is checked independently through the router
        const resource = await router.resolve(
          `${scheme}://${entry.name}`,
          context
        );
        expect(resource.content).toBe(entry.content);
        expect(resource.immutable).toBe(true);
        expect(resource.sourcePath).toBeUndefined();
      }
    }
    await expect(
      router.resolve("skill://../../AGENTS.md", context)
    ).rejects.toThrow("Unknown skill");
    await expect(
      router.resolve("rule://missing-rule", context)
    ).rejects.toThrow("Unknown rule");
  });

  it("loads bounded imports only inside the verified workspace, without host or other-project instructions", async () => {
    const first = await fixture();
    const second = await fixture();
    await mkdir(join(first.root, ".reasonate"));
    await writeFile(
      join(first.root, "AGENTS.md"),
      "First project\n@import .reasonate/conventions.md\n"
    );
    await writeFile(
      join(first.root, ".reasonate/conventions.md"),
      "First conventions"
    );
    await writeFile(join(second.root, "AGENTS.md"), "Second project");
    const sources = await loadWorkspaceInstructions(
      first.filesystem,
      "/workspace"
    );
    expect(sources.map((source) => source.content)).toEqual([
      "First project\nFirst conventions\n",
    ]);
    const { router } = createRunResources({
      cwd: second.root,
      instructionSources: sources,
      root: first.root,
      scope: first.scope,
    });
    const rule = await router.resolve("rule://AGENTS.md", {
      cwd: "/workspace",
      scope: first.scope,
    });
    expect(rule.content).toContain("First conventions");
    expect(rule.content).not.toContain("Second project");
    await writeFile(join(first.root, "AGENTS.md"), "@import ../outside.md");
    await expect(
      loadWorkspaceInstructions(first.filesystem, "/workspace")
    ).rejects.toThrow("escapes the verified workspace");
  });

  it("rejects cyclic and oversized project instructions", async () => {
    const { filesystem, root } = await fixture();
    await writeFile(join(root, "AGENTS.md"), "@import CLAUDE.md");
    await writeFile(join(root, "CLAUDE.md"), "@import AGENTS.md");
    await expect(
      loadWorkspaceInstructions(filesystem, "/workspace")
    ).rejects.toThrow("cycle/depth limit");
    await writeFile(join(root, "AGENTS.md"), "x".repeat(64_001));
    await expect(
      loadWorkspaceInstructions(filesystem, "/workspace")
    ).rejects.toThrow("bounded context size");
  });

  it("gives the actual reviewer named resource reads while withholding direct editing tools", async () => {
    const { filesystem, requestContext, root } = await fixture();
    await writeFile(join(root, "AGENTS.md"), "Use the project's check script.");
    const workspace = new Workspace({ filesystem, id: "guidance-tools" });
    const runtime = createReasonateCtoRuntime({
      budget: { tokens: 100 },
      limits: { reviewerMaxSteps: 12 },
      model: "deepseek/deepseek-flash",
      subagentModels: { reviewer: "deepseek/deepseek-reasoner" },
      workspace,
      workspaceRoot: "/workspace",
    });
    const reviewer = runtime.subagents.find((entry) => entry.id === "reviewer");
    if (!reviewer) {
      throw new Error("Reviewer is missing.");
    }
    const agent = new Agent({
      id: "reviewer-test",
      instructions: reviewer.instructions,
      model: "deepseek/deepseek-flash",
      name: reviewer.name,
      tools: reviewer.tools ?? {},
    });
    const tools = await agent.listTools();
    expect(reviewer.defaultModelId).toBe("deepseek/deepseek-reasoner");
    expect(reviewer.maxSteps).toBe(12);
    expect(reviewer.stopWhen).toEqual(
      expect.arrayContaining([runtime.budget?.stopWhen])
    );
    const instructions = await agent.getInstructions({ requestContext });
    expect(instructions).toContain("deepseek-reasoner");
    expect(Object.keys(tools)).toEqual(["read"]);
    expect(reviewer.allowedWorkspaceTools).toContain(
      WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND
    );
    expect(reviewer.allowedWorkspaceTools).not.toContain(
      WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE
    );
    const { read } = tools;
    if (!(read && "execute" in read && read.execute)) {
      throw new Error("Reviewer has no callable read tool.");
    }
    const result = await read.execute(
      { target: "skill://security-review" },
      { requestContext }
    );
    expect(result).toBe(
      BUNDLED_SKILLS.find((skill) => skill.name === "security-review")?.content
    );
    const rules = await read.execute({ target: "rule://" }, { requestContext });
    expect(rules).toContain("AGENTS.md");
    const scout = runtime.subagents.find((entry) => entry.id === "scout");
    expect(Object.keys(scout?.tools ?? {})).toEqual(["read"]);
    expect(scout?.allowedWorkspaceTools).not.toContain(
      WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND
    );
    const coder = runtime.subagents.find((entry) => entry.id === "coder");
    expect(Object.keys(coder?.tools ?? {}).sort()).toEqual([
      "edit",
      "read",
      "submit_plan",
      "write",
    ]);
  });
});
