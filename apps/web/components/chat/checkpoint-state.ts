import {
  type RunCheckpoint,
  RunCheckpointSchema,
  type RunEventEnvelope,
} from "@reasonateai/contracts/execution-protocol";

export interface CheckpointScope {
  buildSessionId: string;
  organizationId: string;
  projectId: string;
}

export interface TurnCheckpoint {
  checkpoint?: RunCheckpoint;
  checkpointId?: string;
  outcome: string;
  runId: string;
  sequence: number;
}

/** Controller completion precedes saving; only worker outcomes describe saved turns. */
export function turnCheckpoint(
  events: RunEventEnvelope[]
): TurnCheckpoint | undefined {
  const [event] = events
    .filter(
      (entry) =>
        ["run.completed", "run.failed", "run.cancelled"].includes(entry.type) &&
        typeof entry.payload.outcome === "string"
    )
    .sort((a, b) => b.sequence - a.sequence);
  if (!event) {
    return;
  }
  const parsed = RunCheckpointSchema.safeParse(event.payload.checkpoint);
  return {
    outcome: String(event.payload.outcome),
    runId: event.runId,
    sequence: event.sequence,
    ...(typeof event.payload.checkpointId === "string"
      ? { checkpointId: event.payload.checkpointId }
      : {}),
    ...(parsed.success ? { checkpoint: parsed.data } : {}),
  };
}
