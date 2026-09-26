import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ExecuteCommandOptions,
  WorkspaceSandbox,
} from "@mastra/core/workspace";
import type { RunScope } from "@reasonateai/cto-runtime/run-scope";
import {
  type CheckpointReference,
  type CheckpointSandbox,
  type CheckpointStore,
  type CheckpointWriteResult,
  restoreSandbox,
  snapshotSandbox,
} from "@reasonateai/sandbox/checkpoint";
import { SANDBOX_WORKING_DIRECTORY, workspaceVolumeName } from "./workspace.js";

const execFileAsync = promisify(execFile);

/**
 * Checkpointing for the execution plane.
 *
 * A run's workspace is disposable: it is restored from the project's latest
 * accepted Git checkpoint before the agent starts, and snapshotted again before
 * the container is discarded. The snapshot is what makes the container
 * reclaimable — a failed snapshot keeps the volume, because it holds the only
 * copy of the run's work.
 */

/**
 * The checkpoint helpers speak the provider-neutral sandbox contract while the
 * workspace hands back its own sandbox; only the command and file surfaces
 * differ, so the two are bridged here instead of widening either contract.
 */
export function checkpointSandboxFor(
  sandbox: WorkspaceSandbox
): CheckpointSandbox {
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

/**
 * Restores the project's latest accepted checkpoint into a freshly started
 * sandbox. A project with no checkpoint yet starts empty, which is not a
 * failure: the first run of a project has nothing to restore from.
 */
export async function restoreLatestCheckpoint(input: {
  checkpoints: CheckpointStore;
  sandbox: CheckpointSandbox;
  scope: RunScope;
}): Promise<CheckpointReference | undefined> {
  const latest = await input.checkpoints.latest({
    organizationId: input.scope.organizationId,
    projectId: input.scope.projectId,
  });
  if (latest === undefined) {
    return;
  }

  await restoreSandbox({
    checkpointId: latest.checkpointId,
    sandbox: input.sandbox,
    store: input.checkpoints,
    workdir: SANDBOX_WORKING_DIRECTORY,
  });

  return latest;
}

/** Commits the workspace inside the sandbox and stores the resulting bundle. */
export async function snapshotWorkspaceCheckpoint(input: {
  checkpoints: CheckpointStore;
  sandbox: CheckpointSandbox;
  scope: RunScope;
}): Promise<CheckpointWriteResult> {
  return await snapshotSandbox({
    buildSessionId: input.scope.buildSessionId,
    organizationId: input.scope.organizationId,
    projectId: input.scope.projectId,
    runId: input.scope.runId,
    sandbox: input.sandbox,
    store: input.checkpoints,
    workdir: SANDBOX_WORKING_DIRECTORY,
  });
}

/**
 * `docker rm -v` removes a container's anonymous volumes, not the named
 * workspace volume the build sandbox mounts, so the worker removes that one
 * explicitly — by exact name, never by pattern. A volume that was never created
 * is not a leak.
 */
export async function removeWorkspaceVolume(scope: RunScope): Promise<void> {
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
