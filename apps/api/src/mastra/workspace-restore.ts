import type { BuildSession } from "@reasonateai/contracts/execution";
import { WorkspaceRestoreResponseSchema } from "@reasonateai/contracts/execution-protocol";
import type { TenantScope } from "@reasonateai/project-state/postgres";
import {
  type CheckpointSandbox,
  type CheckpointStore,
  restoreSandbox,
  snapshotSandbox,
} from "@reasonateai/sandbox/checkpoint";

export class WorkspaceRestoreFailure extends Error {
  readonly recoveryCheckpointId: string | undefined;
  readonly recoveryError: unknown;
  constructor(
    recoveryCheckpointId: string | undefined,
    options: ErrorOptions,
    recoveryError?: unknown
  ) {
    super(
      recoveryCheckpointId
        ? `Restoration failed. Your preceding workspace is saved as ${recoveryCheckpointId}.`
        : "The recovery checkpoint could not be saved. No workspace files were replaced.",
      options
    );
    this.name = "WorkspaceRestoreFailure";
    this.recoveryCheckpointId = recoveryCheckpointId;
    this.recoveryError = recoveryError;
  }
}

async function cleanRestoredWorkspace(sandbox: CheckpointSandbox) {
  const result = await sandbox.runCommand({
    args: ["clean", "-fd"],
    command: "git",
    cwd: "/workspace",
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(
      "The restored workspace could not remove files absent from the checkpoint."
    );
  }
}

/** Called only while the store holds the project's exclusive restoration lock. */
export async function restoreWorkspace(input: {
  checkpointId: string;
  digest: string;
  sandbox: CheckpointSandbox;
  scope: TenantScope;
  session: BuildSession;
  store: CheckpointStore;
}) {
  const snapshotInput = {
    ...input.scope,
    buildSessionId: input.session.buildSessionId,
    runId: input.session.runId,
    sandbox: input.sandbox,
    store: input.store,
  };
  // Do not touch the current tree unless its tracked and untracked edits are durable.
  const recovery = await snapshotSandbox(snapshotInput).catch(
    (cause: unknown) => {
      throw new WorkspaceRestoreFailure(undefined, { cause });
    }
  );
  try {
    await restoreSandbox({
      checkpointId: input.checkpointId,
      sandbox: input.sandbox,
      store: input.store,
    });
    await cleanRestoredWorkspace(input.sandbox);
    // Publish a new immutable checkpoint. All existing readers and workers use it.
    const restored = await snapshotSandbox(snapshotInput);
    return WorkspaceRestoreResponseSchema.parse({
      checkpointId: input.checkpointId,
      digest: input.digest,
      recoveryCheckpointId: recovery.checkpointId,
      restoredAt: new Date().toISOString(),
      workspaceCheckpointId: restored.checkpointId,
    });
  } catch (cause) {
    let recoveryError: unknown;
    try {
      await restoreSandbox({
        checkpointId: recovery.checkpointId,
        sandbox: input.sandbox,
        store: input.store,
      });
      await cleanRestoredWorkspace(input.sandbox);
    } catch (recoveryCause) {
      recoveryError = recoveryCause;
    }
    throw new WorkspaceRestoreFailure(
      recovery.checkpointId,
      { cause },
      recoveryError
    );
  }
}
