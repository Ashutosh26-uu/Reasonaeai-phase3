import type { RunEventEnvelope } from "@reasonateai/contracts/execution-protocol";

export function runProgressLabel(events: RunEventEnvelope[]): string {
  if (events.length === 0) {
    return "Connecting…";
  }
  if (!events.some((event) => event.type === "run.claimed")) {
    return "Waiting for a worker…";
  }
  return "Working";
}

/** Controller subagents can finish while their parent is still working. */
export function runStreamEnded(
  events: RunEventEnvelope[],
  stopping: boolean
): boolean {
  return events.some(
    (event) =>
      ["run.completed", "run.failed", "run.cancelled"].includes(event.type) &&
      (typeof event.payload.outcome === "string" ||
        (stopping && event.type === "run.cancelled"))
  );
}
