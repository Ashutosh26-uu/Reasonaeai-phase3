import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  type RunScope,
  sandboxIdFor,
} from "@reasonateai/cto-runtime/run-scope";
import { workspaceVolumeName } from "./workspace.js";

const execFileAsync = promisify(execFile);

/** Reattach the durable workspace volume without restoring an older checkpoint over it. */
export async function prepareRecoveredSandbox(scope: RunScope): Promise<void> {
  const volume = workspaceVolumeName(scope);
  try {
    await execFileAsync("docker", ["volume", "inspect", volume]);
  } catch (cause) {
    throw new Error("The suspended run's workspace volume is unavailable.", {
      cause,
    });
  }

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
