import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";

import type { Session } from "@mastra/core/agent-controller";
import { RequestContext } from "@mastra/core/request-context";
import type {
  ExecuteCommandOptions,
  WorkspaceSandbox,
} from "@mastra/core/workspace";
import { createReasonateCtoRuntime } from "@reasonateai/cto-runtime";
import {
  type RunScope,
  readRunScope,
  runScopeKeys,
  sandboxIdFor,
} from "@reasonateai/cto-runtime/run-scope";
import {
  type CheckpointSandbox,
  type CheckpointStore,
  createGitCheckpointStore,
  restoreSandbox,
  snapshotSandbox,
} from "@reasonateai/sandbox/checkpoint";
import { frontierModel } from "../mastra/model.js";
import {
  buildSandboxEnvironment,
  reasonateBuildWorkspace,
  SANDBOX_WORKING_DIRECTORY,
} from "../mastra/workspace.js";
import { describeFailure, reportControllerRun } from "./run-report.js";

const execFileAsync = promisify(execFile);

const model = process.env.MASTRA_MODEL ?? frontierModel;

/** Named volume the build workspace mounts, so a launch has to remove it too. */
const WORKSPACE_VOLUME_SUFFIX = "-workspace";

function createRunContext(): RequestContext {
  const requestContext = new RequestContext();
  requestContext.setRaw(runScopeKeys.organizationId, randomUUID());
  requestContext.setRaw(runScopeKeys.projectId, randomUUID());
  requestContext.setRaw(runScopeKeys.buildSessionId, randomUUID());
  requestContext.setRaw(runScopeKeys.runId, randomUUID());
  return requestContext;
}

function checkpointRoot(): string {
  return (
    process.env.REASONATE_CHECKPOINT_ROOT ??
    join(homedir(), ".reasonateai", "checkpoints")
  );
}

/**
 * The checkpoint helpers speak the provider-neutral sandbox contract while the
 * workspace hands back its own sandbox; only the command and file surfaces
 * differ, so the two are bridged here instead of widening either contract.
 */
function checkpointSandboxFor(sandbox: WorkspaceSandbox): CheckpointSandbox {
  const executeCommand = sandbox.executeCommand?.bind(sandbox);
  const writeFiles = sandbox.writeFiles?.bind(sandbox);

  return {
    runCommand: async (request) => {
      if (executeCommand === undefined) {
        throw new Error("The resolved sandbox cannot execute commands.");
      }

      const options: ExecuteCommandOptions = {};
      if (request.cwd !== undefined) {
        options.cwd = request.cwd;
      }
      if (request.env !== undefined) {
        options.env = request.env;
      }
      if (request.timeoutMs !== undefined) {
        options.timeout = request.timeoutMs;
      }

      const result = await executeCommand(
        request.command,
        request.args,
        options
      );
      if (result.stdoutTruncated === true) {
        throw new Error(
          "The sandbox truncated the command's stdout; a checkpoint cannot be captured from partial output."
        );
      }
      return {
        durationMs: result.executionTimeMs,
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
        timedOut: result.timedOut ?? result.killed ?? false,
      };
    },
    writeFile: async (relativePath, content) => {
      if (writeFiles === undefined) {
        throw new Error("The resolved sandbox cannot write files.");
      }
      await writeFiles([{ content: Buffer.from(content), path: relativePath }]);
    },
  };
}

function printHelp(): void {
  stdout.write(
    "Commands: /help shows this message, /scope shows the isolated run identifiers, /quit exits.\n"
  );
}

function reportFailure(error: unknown): void {
  const failure = describeFailure(error);
  stdout.write(`Run failed: ${failure.message}\n`);
  if (failure.shape) {
    stdout.write(`Rejected request shape:\n${failure.shape}\n`);
  }
  stdout.write("\n");
}

async function restoreWorkspace(input: {
  checkpoints: CheckpointStore;
  sandbox: CheckpointSandbox;
  scope: RunScope;
}): Promise<void> {
  const latest = await input.checkpoints.latest({
    organizationId: input.scope.organizationId,
    projectId: input.scope.projectId,
  });
  if (latest === undefined) {
    stdout.write(
      "No checkpoint exists for this project; the workspace starts empty.\n\n"
    );
    return;
  }

  await restoreSandbox({
    checkpointId: latest.checkpointId,
    sandbox: input.sandbox,
    store: input.checkpoints,
  });
  stdout.write(
    `Restored workspace from checkpoint ${latest.checkpointId} (${latest.digest.slice(0, 12)}).\n\n`
  );
}

/** The build workspace names its volume after the run; nothing else is touched. */
function workspaceVolumeName(scope: RunScope): string {
  return `${sandboxIdFor(scope)}${WORKSPACE_VOLUME_SUFFIX}`;
}

/**
 * `docker rm -v` removes a container's anonymous volumes, not the named
 * workspace volume the build sandbox mounts, so the launch removes that one
 * explicitly — by exact name, never by pattern. A volume that was never
 * created is not a leak.
 */
async function removeWorkspaceVolume(scope: RunScope): Promise<void> {
  try {
    await execFileAsync("docker", [
      "volume",
      "rm",
      "-f",
      workspaceVolumeName(scope),
    ]);
  } catch {
    // Best-effort: the container may never have started, or Docker is absent.
  }
}

/**
 * Used when the launch fails before the run: nothing was captured, so the
 * volume holds no unique work and the previous checkpoint stays authoritative.
 */
async function releaseWorkspace(
  sandbox: WorkspaceSandbox,
  scope: RunScope
): Promise<void> {
  await sandbox.destroy?.();
  await removeWorkspaceVolume(scope);
}

async function checkpointAndRelease(input: {
  checkpoints: CheckpointStore;
  sandbox: WorkspaceSandbox;
  scope: RunScope;
}): Promise<void> {
  let checkpointed = false;
  try {
    const written = await snapshotSandbox({
      buildSessionId: input.scope.buildSessionId,
      organizationId: input.scope.organizationId,
      projectId: input.scope.projectId,
      runId: input.scope.runId,
      sandbox: checkpointSandboxFor(input.sandbox),
      store: input.checkpoints,
    });
    checkpointed = true;
    stdout.write(
      `Workspace checkpoint ${written.checkpointId} saved (${written.bytes} bytes).\n`
    );
  } catch (error) {
    const failure = describeFailure(error);
    stdout.write(`Checkpoint failed: ${failure.message}\n`);
  } finally {
    // Order matters: the workspace is only reclaimable once its bytes are in
    // the store, so a failed checkpoint keeps the volume instead of dropping
    // the only copy of the run's work.
    await input.sandbox.destroy?.();
    if (checkpointed) {
      await removeWorkspaceVolume(input.scope);
    } else {
      stdout.write(
        `The workspace volume ${workspaceVolumeName(input.scope)} was kept because the checkpoint failed.\n`
      );
    }
  }
}

/** `/scope` prints the identifiers that isolate this launch, never the keys. */
function printScope(requestContext: RequestContext): void {
  stdout.write(
    `${JSON.stringify(
      Object.fromEntries(
        Object.entries(runScopeKeys).map(([name, key]) => [
          name,
          requestContext.getRaw(key),
        ])
      )
    )}\n`
  );
}

/**
 * One prompt through the controller session. The transcript is what the next
 * prompt replays, so it only grows once the run returned text, and a failed run
 * is reported without ending the chat.
 */
async function runPrompt(input: {
  prompt: string;
  requestContext: RequestContext;
  session: Session;
  transcript: string[];
}): Promise<void> {
  const request = [...input.transcript, `User: ${input.prompt}`, "CTO:"].join(
    "\n\n"
  );
  try {
    const report = await reportControllerRun(
      input.session,
      { content: request, requestContext: input.requestContext },
      (text) => stdout.write(text)
    );
    if (report.error === undefined) {
      const response = report.text.trim() || "The model returned no text.";
      input.transcript.push(`User: ${input.prompt}\n\nCTO: ${response}`);
      if (input.transcript.length > 8) {
        input.transcript.shift();
      }
    } else {
      stdout.write(`Run failed: ${report.error}\n`);
    }
    stdout.write("\n");
  } catch (error) {
    reportFailure(error);
  }
}

/**
 * One line of chat input: a blank line or a recognized command is consumed
 * without a run, and `/quit` or `/exit` returns false to end the loop.
 */
async function handleLine(input: {
  line: string;
  requestContext: RequestContext;
  session: Session;
  transcript: string[];
}): Promise<boolean> {
  const prompt = input.line.trim();
  if (prompt === "") {
    return true;
  }
  if (prompt === "/quit" || prompt === "/exit") {
    return false;
  }
  if (prompt === "/help") {
    printHelp();
    return true;
  }
  if (prompt === "/scope") {
    printScope(input.requestContext);
    return true;
  }

  await runPrompt({
    prompt,
    requestContext: input.requestContext,
    session: input.session,
    transcript: input.transcript,
  });
  return true;
}

async function main(): Promise<void> {
  const requestContext = createRunContext();
  const runtime = createReasonateCtoRuntime({
    ...buildSandboxEnvironment,
    model,
    workspace: reasonateBuildWorkspace,
    workspaceRoot: SANDBOX_WORKING_DIRECTORY,
  });
  const input = createInterface({
    input: stdin,
    output: stdout,
    terminal: true,
  });
  const transcript: string[] = [];

  /**
   * The run is driven through a controller session, not the agent directly: the
   * session is what holds the delegation tool, the mode, the thread, and the
   * approval gates. The project is the memory resource, so sessions of one
   * project share durable state, and the build session is the isolation scope,
   * so two sessions over one project never share a run loop or a thread.
   */
  await runtime.controller.init();
  const scope = readRunScope(requestContext);
  const session = await runtime.controller.createSession({
    requestContext,
    resourceId: scope.projectId,
    scope: scope.buildSessionId,
  });

  /**
   * Resolved through the workspace rather than built here, so the launch
   * restores, snapshots, and destroys the very sandbox the tools ran in.
   */
  const sandbox = await reasonateBuildWorkspace.resolveSandbox({
    requestContext,
  });
  if (sandbox === undefined) {
    throw new Error("The build workspace resolved no sandbox for this run.");
  }
  await sandbox.start?.();

  const checkpoints = createGitCheckpointStore({ root: checkpointRoot() });

  stdout.write(`ReasonateAI CTO sandbox chat\nModel: ${model}\n`);
  stdout.write(
    "Each launch uses one new isolated Docker workspace. Type /help for commands.\n\n"
  );

  try {
    await restoreWorkspace({
      checkpoints,
      sandbox: checkpointSandboxFor(sandbox),
      scope,
    });
  } catch (error) {
    await releaseWorkspace(sandbox, scope);
    throw error;
  }

  try {
    for await (const line of input) {
      const keepGoing = await handleLine({
        line,
        requestContext,
        session,
        transcript,
      });
      if (!keepGoing) {
        break;
      }
    }
  } finally {
    input.close();
    await checkpointAndRelease({ checkpoints, sandbox, scope });
  }
}

await main();
