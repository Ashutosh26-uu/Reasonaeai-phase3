import { describe, expect, it } from "vitest";
import { readRunLiveEvent } from "../src/run-live-stream.js";

const scope = {
  buildSessionId: "00000000-0000-4000-8000-000000000001",
  organizationId: "00000000-0000-4000-8000-000000000002",
  projectId: "00000000-0000-4000-8000-000000000003",
  runId: "00000000-0000-4000-8000-000000000004",
};
const frame = {
  delta: "First token",
  kind: "message.delta",
  messageId: "message",
  mode: "append",
  organizationId: scope.organizationId,
  projectId: scope.projectId,
  runId: scope.runId,
  schemaVersion: 1,
};

describe("live frame decoding during worker rollout", () => {
  it("delivers both current frames and retained same-session worker frames", () => {
    expect(readRunLiveEvent(JSON.stringify(frame), scope)).toEqual(frame);
    expect(
      readRunLiveEvent(
        JSON.stringify({ ...frame, buildSessionId: scope.buildSessionId }),
        scope
      )
    ).toEqual(frame);
  });
  it.each([
    { buildSessionId: "00000000-0000-4000-8000-000000000005" },
    { organizationId: "00000000-0000-4000-8000-000000000005" },
    { projectId: "00000000-0000-4000-8000-000000000005" },
    { runId: "00000000-0000-4000-8000-000000000005" },
    { unexpected: "field" },
  ])("refuses mismatched scope or other unknown fields: %j", (extra) => {
    expect(
      readRunLiveEvent(
        JSON.stringify({
          ...frame,
          buildSessionId: scope.buildSessionId,
          ...extra,
        }),
        scope
      )
    ).toBeInstanceOf(Error);
  });
});
