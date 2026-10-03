import { randomUUID } from "node:crypto";
import { RunEventEnvelopeSchema } from "@reasonateai/contracts/execution-protocol";
import { describe, expect, it } from "vitest";
import { runStreamEnded } from "./run-state";

const event = (type: string, payload: Record<string, unknown>) =>
  RunEventEnvelopeSchema.parse({
    eventId: randomUUID(),
    occurredAt: "2026-10-03T00:00:00.000Z",
    organizationId: randomUUID(),
    payload,
    projectId: randomUUID(),
    runId: randomUUID(),
    schemaVersion: 1,
    sequence: 1,
    type,
  });

describe("composer run state", () => {
  it("does not show Stop after cancellation is confirmed by the controller", () => {
    expect(runStreamEnded([event("run.cancel.requested", {})], true)).toBe(
      false
    );
    expect(
      runStreamEnded(
        [event("run.cancelled", { kind: "agent_end", reason: "aborted" })],
        true
      )
    ).toBe(true);
  });
  it("keeps the parent working when a delegated agent finishes", () => {
    expect(
      runStreamEnded(
        [event("run.completed", { kind: "agent_end", reason: "complete" })],
        false
      )
    ).toBe(false);
    expect(
      runStreamEnded(
        [event("run.failed", { kind: "agent_end", reason: "error" })],
        false
      )
    ).toBe(false);
  });
  it("stops on each saved worker terminal outcome", () => {
    for (const [type, outcome] of [
      ["run.completed", "succeeded"],
      ["run.failed", "failed"],
      ["run.cancelled", "cancelled"],
    ]) {
      expect(runStreamEnded([event(type ?? "", { outcome })], false)).toBe(
        true
      );
    }
  });
});
