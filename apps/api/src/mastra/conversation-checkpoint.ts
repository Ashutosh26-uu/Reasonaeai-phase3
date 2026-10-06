import type { BuildSessionId } from "@reasonateai/contracts/execution";
import type {
  ProjectStateStore,
  TenantScope,
} from "@reasonateai/project-state/postgres";
import {
  type CheckpointReference,
  type CheckpointStore,
  parseCheckpointId,
} from "@reasonateai/sandbox/checkpoint";

export async function conversationCheckpoint(input: {
  buildSessionId: BuildSessionId;
  checkpoints: CheckpointStore;
  scope: TenantScope;
  store: ProjectStateStore;
}): Promise<
  (CheckpointReference & { commit?: string; empty?: boolean }) | undefined
> {
  const head = await input.store.history.head(
    input.scope,
    input.buildSessionId
  );
  if (!(head?.isolated && head.checkpointId)) {
    return await input.checkpoints.latest(input.scope);
  }
  const parsed = parseCheckpointId(head.checkpointId);
  if (
    parsed.organizationId !== input.scope.organizationId ||
    parsed.projectId !== input.scope.projectId
  ) {
    throw new Error("Conversation checkpoint scope mismatch.");
  }
  return {
    checkpointId: head.checkpointId,
    ...(head.checkpointCommit ? { commit: head.checkpointCommit } : {}),
    digest: parsed.digest,
    empty: head.checkpointEmpty,
  };
}
