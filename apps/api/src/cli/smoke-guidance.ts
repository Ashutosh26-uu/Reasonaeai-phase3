import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { noopObserve } from "@mastra/core/tools";
import {
  executeCommandTool,
  WORKSPACE_TOOLS,
  Workspace,
} from "@mastra/core/workspace";
import { createReasonateCtoRuntime } from "@reasonateai/cto-runtime";
import {
  readRunScope,
  runScopeKeys,
  sandboxIdFor,
} from "@reasonateai/cto-runtime/run-scope";
import { frontierModel } from "../mastra/model.js";
import {
  buildSandboxEnvironment,
  reasonateBuildWorkspace,
  SANDBOX_WORKING_DIRECTORY,
} from "../mastra/workspace.js";

const exec = promisify(execFile);
const SYMLINK_DENIED = /Symbolic links are not allowed/;

/** Real Docker/tool smoke. It intentionally makes no inference call or model-behavior claim. */
async function main(): Promise<void> {
  const requestContext = new RequestContext();
  for (const key of Object.values(runScopeKeys)) {
    requestContext.setRaw(key, randomUUID());
  }
  const scope = readRunScope(requestContext);
  const resourcesRoot = await mkdtemp(
    join(tmpdir(), "reasonate-guidance-smoke-")
  );
  const sandbox = await reasonateBuildWorkspace.resolveSandbox({
    requestContext,
  });
  assert.ok(sandbox, "verified workspace resolves a real sandbox");
  try {
    await sandbox.start?.();
    const runtime = createReasonateCtoRuntime({
      ...buildSandboxEnvironment,
      model: frontierModel,
      resourcesRoot,
      workspace: reasonateBuildWorkspace,
      workspaceRoot: SANDBOX_WORKING_DIRECTORY,
    });
    const reviewer = runtime.subagents.find(
      (candidate) => candidate.id === "reviewer"
    );
    assert.ok(reviewer, "reviewer is registered");
    assert.ok(
      reviewer.allowedWorkspaceTools?.includes(
        WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND
      ),
      "reviewer is allowed to execute checks"
    );
    const agent = new Agent({
      id: "guidance-smoke-reviewer",
      instructions: reviewer.instructions,
      model: frontierModel,
      name: reviewer.name,
      tools: reviewer.tools ?? {},
    });
    const tools = await agent.listTools();
    assert.deepEqual(
      Object.keys(tools),
      ["read"],
      "reviewer has no direct source mutation tool"
    );
    const { read } = tools;
    assert.ok(
      read && "execute" in read && read.execute,
      "reviewer read is callable"
    );
    const rules = await read.execute({ target: "rule://" }, { requestContext });
    assert.ok(
      typeof rules === "string" &&
        rules.includes("No project-specific instruction files"),
      "empty project rules resolve normally"
    );
    const skill = await read.execute(
      { target: "skill://security-review" },
      { requestContext }
    );
    assert.ok(
      typeof skill === "string" && skill.includes("# Security review"),
      "reviewer resolves its bundled skill"
    );
    const filesystem = await reasonateBuildWorkspace.resolveFilesystem({
      requestContext,
    });
    assert.ok(filesystem, "sandbox filesystem is available");
    // The workspace tool wrapper resolves dynamic adapters before executing a
    // native tool. Use those same scoped adapters for this direct-tool smoke.
    const resolvedWorkspace = new Workspace({
      filesystem,
      id: "guidance-smoke-workspace",
      sandbox,
    });
    await filesystem.writeFile(
      "AGENTS.md",
      "Use check mode and preserve project ownership.\n"
    );
    await filesystem.writeFile(
      "verification.js",
      "const value = 42;\nconsole.log(value);\n"
    );
    assert.ok(executeCommandTool.execute, "command tool is callable");
    const check = await executeCommandTool.execute(
      {
        command:
          "node --check verification.js && node -p \"'guidance-check-passed'\"",
        cwd: SANDBOX_WORKING_DIRECTORY,
        timeout: 10_000,
      },
      { observe: noopObserve, requestContext, workspace: resolvedWorkspace }
    );
    assert.ok(
      typeof check === "string" && check.includes("guidance-check-passed"),
      "real check completes"
    );
    await filesystem.writeFile("verification.js", "const value = ;\n");
    const failedCheck = await executeCommandTool.execute(
      {
        command: "node --check verification.js",
        cwd: SANDBOX_WORKING_DIRECTORY,
        timeout: 10_000,
      },
      { observe: noopObserve, requestContext, workspace: resolvedWorkspace }
    );
    assert.ok(
      typeof failedCheck === "string" &&
        failedCheck.includes("SyntaxError") &&
        failedCheck.includes("Exit code: 1"),
      "real failed check exposes its diagnostic and exit status"
    );
    const nextContext = new RequestContext(requestContext.entries());
    nextContext.setRaw(runScopeKeys.runId, randomUUID());
    const nextRules = await read.execute(
      { target: "rule://AGENTS.md" },
      { requestContext: nextContext }
    );
    assert.equal(
      nextRules,
      "Use check mode and preserve project ownership.\n",
      "next run reads only its sandbox instructions"
    );
    const instructions = await agent.getInstructions({
      requestContext: nextContext,
    });
    assert.ok(
      typeof instructions === "string" &&
        instructions.includes("Use check mode and preserve project ownership."),
      "reviewer receives project instructions"
    );
    await filesystem.mkdir(".reasonate");
    const linked = await executeCommandTool.execute(
      {
        command: "ln -s /etc/hostname .reasonate/outside.md",
        cwd: SANDBOX_WORKING_DIRECTORY,
        timeout: 10_000,
      },
      { observe: noopObserve, requestContext, workspace: resolvedWorkspace }
    );
    assert.ok(typeof linked === "string", "sandbox link fixture executes");
    await filesystem.writeFile("AGENTS.md", "@import .reasonate/outside.md\n");
    const linkedContext = new RequestContext(requestContext.entries());
    linkedContext.setRaw(runScopeKeys.runId, randomUUID());
    await assert.rejects(
      async () =>
        read.execute?.(
          { target: "rule://AGENTS.md" },
          { requestContext: linkedContext }
        ),
      SYMLINK_DENIED,
      "project instruction imports cannot follow a sandbox symlink"
    );
    process.stdout.write(
      "PASS: real Docker guidance reads, empty rule listing, reviewer resource/tool access, sandbox check success/failure, next-run project instructions, and symlink denial. No inference call was made.\n"
    );
  } finally {
    await sandbox.stop?.();
    await exec("docker", ["rm", "-f", sandboxIdFor(scope)]);
    await exec("docker", ["volume", "rm", `${sandboxIdFor(scope)}-workspace`]);
    await rm(resourcesRoot, { force: true, recursive: true });
    reasonateBuildWorkspace.clearSandboxCache(sandboxIdFor(scope));
  }
}

await main();
