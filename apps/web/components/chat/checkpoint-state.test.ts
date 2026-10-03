import { randomUUID } from "node:crypto";
import { RunEventEnvelopeSchema } from "@reasonateai/contracts/execution-protocol";
import { describe, expect, it } from "vitest";
import { turnCheckpoint } from "./checkpoint-state";

const organizationId = randomUUID();
const projectId = randomUUID();
const runId = randomUUID();
function event(
  sequence: number,
  payload: Record<string, unknown>,
  type = "run.completed"
) {
  return RunEventEnvelopeSchema.parse({
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    organizationId,
    payload,
    projectId,
    runId,
    schemaVersion: 1,
    sequence,
    type,
  });
}
const checkpointId = `${organizationId}.${projectId}.${"1".repeat(64)}`;
const checkpoint = {
  added: 3,
  baseCommit: null,
  checkpointId,
  commit: "2".repeat(40),
  fileCount: 1,
  files: [{ added: 3, path: "index.html", removed: 0, status: "added" }],
  removed: 0,
  status: "available",
  truncated: false,
  version: 1,
};

describe("turn checkpoints", () => {
  it("waits for a durable worker outcome instead of treating controller completion as a saved checkpoint", () => {
    expect(turnCheckpoint([event(1, { kind: "agent_end" })])).toBeUndefined();
  });
  it("uses the saved event and exact replay sequence even when delivery order is reversed", () => {
    expect(
      turnCheckpoint([
        event(4, { checkpoint, checkpointId, outcome: "succeeded" }),
        event(2, { kind: "agent_end" }),
      ])
    ).toMatchObject({ checkpoint, runId, sequence: 4 });
  });
  it("keeps a failed outcome when work was saved after the failure", () => {
    expect(
      turnCheckpoint([
        event(
          2,
          { outcome: "failed", reason: "provider unavailable" },
          "run.failed"
        ),
        event(3, { checkpoint, checkpointId, outcome: "failed" }, "run.failed"),
      ])
    ).toMatchObject({ checkpoint, outcome: "failed", sequence: 3 });
  });
  it("leaves legacy and invalid summaries unavailable without inventing counts", () => {
    expect(
      turnCheckpoint([event(1, { checkpointId, outcome: "succeeded" })])
    ).toEqual({ checkpointId, outcome: "succeeded", runId, sequence: 1 });
    expect(
      turnCheckpoint([
        event(1, {
          checkpoint: { ...checkpoint, added: -1 },
          checkpointId,
          outcome: "succeeded",
        }),
      ])?.checkpoint
    ).toBeUndefined();
    expect(
      turnCheckpoint([event(1, { checkpointId: null, outcome: "succeeded" })])
        ?.checkpointId
    ).toBeUndefined();
  });
});
