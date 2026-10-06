import { randomUUID } from "node:crypto";
import {
  MessageSnapshotSchema,
  RunEventEnvelopeSchema,
} from "@reasonateai/contracts/execution-protocol";
import { describe, expect, it } from "vitest";
import { EMPTY_TIMELINE, foldDurable, projectTranscript } from "./timeline";

const at = "2026-10-06T00:00:00.000Z";
const scope = {
  organizationId: randomUUID(),
  projectId: randomUUID(),
  runId: randomUUID(),
};
const plan = {
  files: [{ action: "create", description: "Login", path: "login.ts" }],
  rationale: "Access control",
  risk: "low",
  steps: ["Build login"],
  summary: "Email login",
  title: "Add login",
};
function event(
  sequence: number,
  type: string,
  payload: Record<string, unknown>
) {
  return RunEventEnvelopeSchema.parse({
    ...scope,
    eventId: randomUUID(),
    occurredAt: at,
    payload,
    schemaVersion: 1,
    sequence,
    type,
  });
}
const proposed = event(1, "run.plan_proposed", {
  args: plan,
  kind: "tool_suspended",
  toolCallId: "plan-1",
  toolName: "submit_plan",
});
function entries(history: ReturnType<typeof event>[]) {
  return projectTranscript(history.reduce(foldDurable, EMPTY_TIMELINE), [])[0]
    ?.entries;
}

describe("plan decision replay", () => {
  it("preserves explicit approval with feedback after generic answer resolution and reload", () => {
    const history = [
      proposed,
      event(2, "run.plan_decided", {
        approved: true,
        feedback: "Keep the existing design",
        toolCallId: "plan-1",
      }),
      event(3, "approval.resolved", {
        kind: "answer_submitted",
        toolCallId: "plan-1",
      }),
      event(4, "run.completed", {}),
    ];
    expect(entries(history)).toMatchObject([
      {
        kind: "plan",
        resolved: { approved: true, feedback: "Keep the existing design" },
      },
    ]);
    expect(entries([...history, ...history])).toEqual(entries(history));
  });
  it("does not invent approval from an answer acknowledgement", () => {
    expect(
      entries([
        proposed,
        event(2, "approval.resolved", {
          kind: "answer_submitted",
          toolCallId: "plan-1",
        }),
      ])
    ).toMatchObject([{ kind: "plan", resolved: undefined }]);
  });
  it("keeps another tool's decision separate", () => {
    expect(
      entries([
        proposed,
        event(2, "run.plan_decided", {
          approved: true,
          toolCallId: "other-plan",
        }),
      ])
    ).toMatchObject([{ kind: "plan", resolved: undefined }]);
  });
  it("renders cancellation as cancellation instead of approval", () => {
    expect(
      entries([
        proposed,
        event(2, "approval.resolved", {
          resolution: "cancelled",
          toolCallId: "plan-1",
        }),
      ])
    ).toMatchObject([
      { kind: "plan", resolved: { approved: false, cancelled: true } },
    ]);
  });
  it("renders one card when the proposal appears in both a snapshot and durable events", () => {
    const snapshot = MessageSnapshotSchema.parse({
      finished: true,
      messageId: "m",
      parts: [{ index: 0, toolCallId: "plan-1", type: "tool" }],
      revision: 1,
      startedAt: at,
      version: 1,
    });
    const history = [
      proposed,
      event(2, "agent.progress", {
        args: plan,
        kind: "tool_start",
        toolCallId: "plan-1",
        toolName: "submit_plan",
      }),
      event(3, "agent.progress", { kind: "message_snapshot", snapshot }),
      event(4, "run.plan_decided", {
        approved: false,
        feedback: "Use magic links",
        toolCallId: "plan-1",
      }),
    ];
    expect(entries(history)).toMatchObject([
      {
        kind: "plan",
        resolved: { approved: false, feedback: "Use magic links" },
      },
    ]);
    expect(entries(history)).toHaveLength(1);
  });
});
