import type { RunEventEnvelope } from "@reasonateai/contracts/execution-protocol";

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
