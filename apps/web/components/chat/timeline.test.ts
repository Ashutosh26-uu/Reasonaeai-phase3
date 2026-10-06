import { randomUUID } from "node:crypto";
import { ConversationMessageSchema } from "@reasonateai/contracts/execution";
import {
  MessageSnapshotSchema,
  type RunEventEnvelope,
  RunEventEnvelopeSchema,
  RunLiveEventSchema,
} from "@reasonateai/contracts/execution-protocol";
import { describe, expect, it } from "vitest";
import {
  EMPTY_TIMELINE,
  foldDurable,
  foldLive,
  latestCompletedTurn,
  pendingPlan,
  pendingQuestion,
  projectTranscript,
  reconcileHistory,
} from "./timeline";

const organizationId = randomUUID();
const projectId = randomUUID();
const runId = randomUUID();
const at = "2026-09-29T00:00:00.000Z";
const event = (
  sequence: number,
  payload: Record<string, unknown>,
  run = runId,
  type = "agent.progress"
): RunEventEnvelope =>
  RunEventEnvelopeSchema.parse({
    eventId: randomUUID(),
    occurredAt: at,
    organizationId,
    payload,
    projectId,
    runId: run,
    schemaVersion: 1,
    sequence,
    type,
  });

describe("active history reconciliation", () => {
  it.each([{}, { outcome: "succeeded" }])(
    "restores a completed suggestion turn from saved history with %j",
    (payload) => {
      const timeline = [
        event(1, { kind: "message_end", role: "assistant", text: "Done" }),
        event(2, payload, runId, "run.completed"),
      ].reduce(foldDurable, EMPTY_TIMELINE);
      expect(latestCompletedTurn(timeline, [])?.entries[0]).toMatchObject({
        text: "Done",
      });
    }
  );
  it("does not suggest after a controller end or a later failed turn", () => {
    const ended = event(1, { kind: "agent_end" }, runId, "run.completed");
    expect(
      latestCompletedTurn(foldDurable(EMPTY_TIMELINE, ended), [])
    ).toBeUndefined();
    const completed = event(
      2,
      { outcome: "succeeded" },
      runId,
      "run.completed"
    );
    const failed = event(1, { outcome: "failed" }, randomUUID(), "run.failed");
    const timeline = [completed, failed].reduce(foldDurable, EMPTY_TIMELINE);
    expect(latestCompletedTurn(timeline, [])).toBeUndefined();
  });
  it("keeps unchanged snapshots stable even when callers recreate the event array", () => {
    const saved = event(1, { text: "Saved answer" });
    const timeline = reconcileHistory(EMPTY_TIMELINE, [saved]);
    expect(reconcileHistory(timeline, [saved])).toBe(timeline);
    expect(reconcileHistory(EMPTY_TIMELINE, [])).toBe(EMPTY_TIMELINE);
  });
  it("removes the superseded suffix while preserving the active replacement", () => {
    const kept = event(1, { text: "Retained prefix" });
    const supersededId = randomUUID();
    const replacementId = randomUUID();
    const superseded = event(1, { text: "Superseded answer" }, supersededId);
    const replacement = event(1, { text: "New answer" }, replacementId);
    const timeline = [kept, superseded, replacement].reduce(
      foldDurable,
      EMPTY_TIMELINE
    );
    const rewound = reconcileHistory(timeline, [kept], replacementId);
    expect(Object.keys(rewound.runs).sort()).toEqual(
      [runId, replacementId].sort()
    );
    expect(rewound.runs[replacementId]?.events[1]?.payload.text).toBe(
      "New answer"
    );
    expect(reconcileHistory(rewound, [kept], replacementId)).toBe(rewound);
  });
});
const snapshot = MessageSnapshotSchema.parse({
  finished: true,
  messageId: "m",
  parts: [
    {
      endedAt: at,
      index: 0,
      startedAt: at,
      text: "Inspect it",
      type: "reasoning",
    },
    {
      endedAt: at,
      index: 1,
      startedAt: at,
      text: "Let me check the workspace.",
      type: "text",
    },
    { index: 2, toolCallId: "c", type: "tool" },
    {
      endedAt: at,
      index: 3,
      startedAt: at,
      text: "Check the result",
      type: "reasoning",
    },
    {
      endedAt: at,
      index: 4,
      startedAt: at,
      text: "Yes — reading works fine.",
      type: "text",
    },
  ],
  revision: 1,
  startedAt: at,
  version: 1,
});
const events = [
  event(1, { kind: "message_snapshot", snapshot }),
  event(2, {
    args: { target: "index.html" },
    kind: "tool_start",
    toolCallId: "c",
    toolName: "read",
  }),
  event(3, {
    isError: false,
    kind: "tool_end",
    result: "file content",
    toolCallId: "c",
  }),
];

describe("conversation transcript", () => {
  it("retains user steering at its original position and updates delivery on replay", () => {
    const requested = event(
      2,
      { message: "Use blue", steeringId: "steer" },
      runId,
      "run.steering.requested"
    );
    const delivered = event(
      4,
      { steeringId: "steer" },
      runId,
      "run.steering.delivered"
    );
    const history = [
      event(1, {
        kind: "message_end",
        messageId: "first",
        role: "assistant",
        text: "Working",
      }),
      requested,
      event(3, {
        kind: "message_end",
        messageId: "last",
        role: "assistant",
        text: "Changed",
      }),
      delivered,
    ];
    const entries = projectTranscript(
      history.reduce(foldDurable, EMPTY_TIMELINE),
      []
    )[0]?.entries;
    expect(entries?.map((entry) => entry.kind)).toEqual([
      "text",
      "steering",
      "text",
    ]);
    expect(entries?.[1]).toMatchObject({
      status: "delivered",
      text: "Use blue",
    });
    const failed = event(
      5,
      { reason: "Delivery unconfirmed", steeringId: "steer" },
      runId,
      "run.steering.failed"
    );
    expect(
      projectTranscript(
        [...history, failed].reduce(foldDurable, EMPTY_TIMELINE),
        []
      )[0]?.entries[1]
    ).toMatchObject({ reason: "Delivery unconfirmed", status: "failed" });
  });
  it("shows only the unanswered ask_user question for an active run", () => {
    const asked = event(
      4,
      {
        kind: "tool_suspended",
        suspendPayload: { question: "Which region?" },
        toolCallId: "ask-1",
        toolName: "ask_user",
      },
      runId,
      "approval.requested"
    );
    const timeline = foldDurable(EMPTY_TIMELINE, asked);
    expect(pendingQuestion(timeline, runId)).toEqual({
      question: "Which region?",
      toolCallId: "ask-1",
    });
    const resolved = foldDurable(
      timeline,
      event(
        5,
        {
          kind: "answer_submitted",
          toolCallId: "ask-1",
        },
        runId,
        "approval.resolved"
      )
    );
    expect(pendingQuestion(resolved, runId)).toBeUndefined();
  });
  it("tracks pending structured plan proposals and clears on decision or terminal event", () => {
    const plan = {
      files: [
        {
          action: "create" as const,
          description: "Main entry point",
          path: "src/index.ts",
        },
      ],
      rationale: "Implement the feature architecture",
      risk: "low",
      steps: ["Create entry point", "Write tests"],
      summary: "Add new feature module",
      title: "Feature Implementation Plan",
    };
    const proposed = event(
      4,
      {
        args: plan,
        kind: "tool_suspended",
        toolCallId: "plan-1",
        toolName: "submit_plan",
      },
      runId,
      "run.plan_proposed"
    );
    const timeline = foldDurable(EMPTY_TIMELINE, proposed);
    expect(pendingPlan(timeline, runId)).toEqual({
      plan,
      toolCallId: "plan-1",
    });

    const approved = foldDurable(
      timeline,
      event(
        5,
        {
          approved: true,
          toolCallId: "plan-1",
        },
        runId,
        "run.plan_decided"
      )
    );
    expect(pendingPlan(approved, runId)).toBeUndefined();
  });
  it("renders plan proposals as plan transcript entries with approval outcome", () => {
    const plan = {
      files: [
        {
          action: "modify" as const,
          description: "Update config",
          path: "config.json",
        },
      ],
      rationale: "Update production configuration",
      risk: "medium",
      steps: ["Edit config.json"],
      summary: "Config update",
      title: "Update Config Plan",
    };
    const history = [
      event(
        1,
        {
          args: plan,
          kind: "tool_suspended",
          toolCallId: "plan-call",
          toolName: "submit_plan",
        },
        runId,
        "run.plan_proposed"
      ),
      event(
        2,
        {
          approved: true,
          toolCallId: "plan-call",
        },
        runId,
        "run.plan_decided"
      ),
    ];
    const entries = projectTranscript(
      history.reduce(foldDurable, EMPTY_TIMELINE),
      []
    )[0]?.entries;
    expect(entries).toHaveLength(1);
    expect(entries?.[0]).toMatchObject({
      kind: "plan",
      plan,
      resolved: { approved: true },
      toolCallId: "plan-call",
    });
  });
  it("renders the reported sequence at equal timestamps and with tool results arriving later", () => {
    const timeline = events.reduce(foldDurable, EMPTY_TIMELINE);
    const entries = projectTranscript(timeline, [])[0]?.entries;
    expect(entries?.map((entry) => entry.kind)).toEqual([
      "reasoning",
      "text",
      "tool",
      "reasoning",
      "text",
    ]);
    expect(entries?.[1]).toMatchObject({ text: "Let me check the workspace." });
    expect(entries?.[2]).toMatchObject({
      tool: {
        input: { target: "index.html" },
        output: "file content",
        state: "output-available",
      },
    });
    expect(entries?.[4]).toMatchObject({ text: "Yes — reading works fine." });
  });
  it("replaying duplicate events never duplicates tools or messages", () => {
    const timeline = [...events, ...events].reduce(foldDurable, EMPTY_TIMELINE);
    expect(projectTranscript(timeline, [])).toEqual(
      projectTranscript(events.reduce(foldDurable, EMPTY_TIMELINE), [])
    );
  });
  it("keeps all earlier runs and their originating user requests", () => {
    const secondRun = randomUUID();
    const timeline = [
      ...events,
      event(
        1,
        { args: {}, kind: "tool_start", toolCallId: "c", toolName: "list" },
        secondRun
      ),
    ].reduce(foldDurable, EMPTY_TIMELINE);
    const users = [runId, secondRun].map((id) =>
      ConversationMessageSchema.parse({
        createdAt: at,
        id,
        reasoning: null,
        role: "user",
        runId: id,
        sourceId: null,
        text: id === runId ? "Inspect the app" : "List files",
      })
    );
    const turns = projectTranscript(timeline, users);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.entries).toHaveLength(5);
    expect(turns[1]?.entries).toHaveLength(1);
    expect(turns[0]?.user?.text).toBe("Inspect the app");
  });
  it("anchors early live frames and ignores stale frames after final durable replacement", () => {
    const frame = RunLiveEventSchema.parse({
      kind: "message.snapshot",
      organizationId,
      projectId,
      runId,
      schemaVersion: 1,
      snapshot: { ...snapshot, finished: false, revision: 2 },
    });
    let timeline = foldLive(EMPTY_TIMELINE, frame);
    expect(projectTranscript(timeline, [])[0]?.entries).toEqual([]);
    timeline = foldDurable(
      timeline,
      event(1, {
        kind: "message_snapshot",
        snapshot: { ...snapshot, finished: false },
      })
    );
    const completed = event(4, {
      kind: "message_snapshot",
      snapshot: { ...snapshot, revision: 3 },
    });
    timeline = foldDurable(timeline, completed);
    const late = foldLive(timeline, frame);
    expect(projectTranscript(late, [])).toEqual(
      projectTranscript(
        [
          event(1, {
            kind: "message_snapshot",
            snapshot: { ...snapshot, finished: false },
          }),
          completed,
        ].reduce(foldDurable, EMPTY_TIMELINE),
        []
      )
    );
  });
  it("does not claim unfinished tools succeeded when the run ends", () => {
    const timeline = [events[1], event(4, {}, runId, "run.cancelled")]
      .filter((item): item is RunEventEnvelope => item !== undefined)
      .reduce(foldDurable, EMPTY_TIMELINE);
    expect(projectTranscript(timeline, [])[0]?.entries[0]).toMatchObject({
      tool: { state: "output-error" },
    });
  });
});
