import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  type RunScope,
  sandboxIdFor,
} from "@reasonateai/cto-runtime/run-scope";
import { workspaceVolumeName } from "./workspace.js";

const execFileAsync = promisify(execFile);
const MISSING_VOLUME = /no such volume/i;

/** Missing workspaces are distinct from an unavailable Docker daemon. */
export async function recoveredWorkspaceExists(
  scope: RunScope
): Promise<boolean> {
  try {
    await execFileAsync("docker", [
      "volume",
      "inspect",
      workspaceVolumeName(scope),
    ]);
    return true;
  } catch (cause) {
    if (cause instanceof Error && MISSING_VOLUME.test(cause.message)) {
      return false;
    }
    throw new Error(
      "Could not inspect the interrupted run's workspace volume.",
      { cause }
    );
  }
}

/** Reattach the durable workspace volume without restoring an older checkpoint over it. */
export async function prepareRecoveredSandbox(scope: RunScope): Promise<void> {
  const volume = workspaceVolumeName(scope);
  try {
    await execFileAsync("docker", ["volume", "inspect", volume]);
  } catch {
    // If the volume does not exist (e.g. clean worker node or reclaimed volume),
    // sandbox start and checkpoint restoration will reconstruct the workspace safely.
  }

  await stopRecoveredSandbox(scope);
}

/** Stop the expired owner's container while preserving its named workspace. */
export async function stopRecoveredSandbox(scope: RunScope): Promise<void> {
  const container = sandboxIdFor(scope);
  try {
    await execFileAsync("docker", ["container", "inspect", container]);
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes("No such container")) {
      return;
    }
    throw new Error("Could not inspect the suspended run's container.", {
      cause,
    });
  }
  // A process whose lease expired cannot keep owning the container. Named
  // workspace volumes survive docker rm -v, so the new lease holder remounts it.
  await execFileAsync("docker", ["rm", "-f", "-v", container]);
}
