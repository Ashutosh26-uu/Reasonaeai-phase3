import { randomUUID } from "node:crypto";
import { ConversationMessageSchema } from "@reasonateai/contracts/execution";
import {
  MessageSnapshotSchema,
  RunEventEnvelopeSchema,
} from "@reasonateai/contracts/execution-protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_TIMELINE, foldDurable, projectTranscript } from "./timeline";
import { Transcript } from "./transcript";
import { turnPresentation } from "./turn-presentation";

const runId = randomUUID();
const organizationId = randomUUID();
const projectId = randomUUID();
function historyEntry(
  sequence: number,
  type: string,
  payload: Record<string, unknown>
) {
  return RunEventEnvelopeSchema.parse({
    eventId: randomUUID(),
    occurredAt: "2026-10-04T00:00:00.000Z",
    organizationId,
    payload,
    projectId,
    runId,
    schemaVersion: 1,
    sequence,
    type,
  });
}
const requested = historyEntry(1, "run.steering.requested", {
  message: "Use blue\nand keep the layout",
  steeringId: "steer",
});
const delivered = historyEntry(2, "run.steering.delivered", {
  steeringId: "steer",
});
describe("saved message controls", () => {
  it("puts edit/retry on the user and copy/feedback/branch on the saved assistant answer", () => {
    const messages = [
      ConversationMessageSchema.parse({
        createdAt: "2026-10-06T08:00:00Z",
        id: randomUUID(),
        reasoning: null,
        role: "user",
        runId,
        sourceId: null,
        text: "Build this",
      }),
      ConversationMessageSchema.parse({
        createdAt: "2026-10-06T08:01:00Z",
        feedback: "positive",
        id: randomUUID(),
        reasoning: null,
        role: "assistant",
        runId,
        sourceId: null,
        text: "Done",
      }),
    ];
    const timeline = [
      historyEntry(1, "run.queued", {}),
      historyEntry(2, "agent.progress", {
        kind: "message_end",
        messageId: randomUUID(),
        role: "assistant",
        text: "Done",
      }),
      historyEntry(3, "run.completed", {}),
    ].reduce(foldDurable, EMPTY_TIMELINE);
    const html = renderToStaticMarkup(
      <Transcript
        live={false}
        messages={messages}
        onBranch={vi.fn()}
        onEdit={vi.fn()}
        onFeedback={vi.fn()}
        onRetry={vi.fn()}
        pending={false}
        timeline={timeline}
      />
    );
    const footer = html.slice(html.indexOf('aria-label="Answer actions"'));
    expect(html).toContain("Edit and resend");
    expect(html).toContain("Done");
    expect(html).not.toContain("This older response was saved");
    expect(html).toContain("Retry request");
    expect(footer).toContain("Copy answer");
    expect(footer).toContain("Good response");
    expect(footer).toContain("Poor response");
    expect(footer).toContain("Branch in new conversation");
    expect(footer).not.toContain("Edit and resend");
    expect(footer).not.toContain("Retry request");
    expect(footer).toContain('dateTime="2026-10-06T08:01:00Z"');
  });
});
function renderHistory(events: ReturnType<typeof historyEntry>[]) {
  return renderToStaticMarkup(
    <Transcript
      live={false}
      messages={[]}
      onEdit={vi.fn()}
      onRetry={vi.fn()}
      pending={false}
      timeline={events.reduce(foldDurable, EMPTY_TIMELINE)}
    />
  );
}

describe("steering message presentation", () => {
  it.each(["run.completed", "run.failed", "run.cancelled"])(
    "renders delivered steering as a normal message after %s, including history replay",
    (type) => {
      const html = renderHistory([
        requested,
        delivered,
        historyEntry(3, type, {}),
      ]);
      expect(html).toContain("Use blue\nand keep the layout");
      expect(html).toContain("msg-user-text");
      expect(html).not.toContain("Steering ·");
      expect(html).not.toContain("Delivered to the active CTO");
    }
  );
  it("keeps live delivery and waiting status visible", () => {
    expect(renderHistory([requested])).toContain(
      "Waiting for the CTO’s next step"
    );
    expect(renderHistory([requested, delivered])).toContain(
      "Delivered to the active CTO"
    );
  });
  it("keeps unconfirmed delivery visible after a terminal run", () => {
    const failed = historyEntry(2, "run.steering.failed", {
      reason: "Delivery unconfirmed after recovery",
      steeringId: "steer",
    });
    const html = renderHistory([
      requested,
      failed,
      historyEntry(3, "run.completed", {}),
    ]);
    expect(html).toContain("Delivery unconfirmed");
    expect(html).toContain("Delivery unconfirmed after recovery");
    expect(
      renderHistory([requested, historyEntry(3, "run.cancelled", {})])
    ).toContain("Waiting for the CTO’s next step");
  });
});

describe("collapsed tool group presentation", () => {
  it("describes consecutive actions with singular grammar and an accessible count", () => {
    const events = [
      historyEntry(1, "agent.progress", {
        args: { path: "index.html" },
        kind: "tool_start",
        toolCallId: "edit",
        toolName: "edit",
      }),
      historyEntry(2, "agent.progress", {
        isError: false,
        kind: "tool_end",
        result: "Saved",
        toolCallId: "edit",
      }),
      historyEntry(3, "agent.progress", {
        args: { command: "pnpm test" },
        kind: "tool_start",
        toolCallId: "command",
        toolName: "run_command",
      }),
      historyEntry(4, "agent.progress", {
        isError: false,
        kind: "tool_end",
        result: "Passed",
        toolCallId: "command",
      }),
    ];
    const html = renderHistory(events);
    expect(html).toContain("Edited a file, ran a command");
    expect(html).toContain("2 tool calls");
  });
});

const commentary = "I found the recovery ordering issue.";
const finalAnswer = "Refresh now preserves your latest edits.";
function recoveryHistory(withAnswer = true) {
  const at = "2026-10-07T10:00:00.000Z";
  const snapshot = MessageSnapshotSchema.parse({
    finished: false,
    messageId: "recovery",
    parts: [
      {
        endedAt: at,
        index: 0,
        startedAt: at,
        text: commentary,
        type: "text",
      },
      {
        endedAt: at,
        index: 1,
        startedAt: at,
        text: "Trace checkpoint restoration before editing.",
        type: "reasoning",
      },
      { index: 2, toolCallId: "read", type: "tool" },
      {
        endedAt: null,
        index: 3,
        startedAt: at,
        text: "Check whether the new recovery order preserves edits.",
        type: "reasoning",
      },
      ...(withAnswer
        ? [
            {
              endedAt: null,
              index: 4,
              startedAt: at,
              text: finalAnswer,
              type: "text",
            },
          ]
        : []),
    ],
    revision: 1,
    startedAt: at,
    version: 1,
  });
  return [
    { ...historyEntry(1, "run.claimed", {}), occurredAt: at },
    historyEntry(2, "agent.progress", { kind: "message_snapshot", snapshot }),
    historyEntry(3, "agent.progress", {
      args: { target: "src/preview/recovery.ts" },
      kind: "tool_start",
      toolCallId: "read",
      toolName: "read",
    }),
    historyEntry(4, "agent.progress", {
      kind: "tool_end",
      result: "Restoration currently precedes preservation.",
      toolCallId: "read",
    }),
  ];
}
function endTurn(type = "run.completed") {
  return {
    ...historyEntry(5, type, {}),
    occurredAt: "2026-10-07T10:06:42.000Z",
  };
}
function presentationFor(events: ReturnType<typeof historyEntry>[]) {
  const [turn] = projectTranscript(
    events.reduce(foldDurable, EMPTY_TIMELINE),
    []
  );
  if (!turn) {
    throw new Error("Expected the recovery turn");
  }
  return turnPresentation(turn.entries, events);
}

describe("turn activity presentation", () => {
  it("groups interleaved thinking and tools while leaving streaming commentary visible", () => {
    const html = renderHistory(recoveryHistory(false));
    expect(html).toContain(commentary);
    expect(html).toContain("Thinking");
    expect(html).toContain("1 tool call, 2 thinking blocks");
    expect(html).not.toContain("Worked for");
    const presentation = presentationFor(recoveryHistory(false));
    expect(presentation.visible.map((entry) => entry.kind)).toEqual([
      "text",
      "reasoning",
      "tool",
      "reasoning",
    ]);
    expect(presentation.history).toEqual([]);
  });

  it.each([
    { kind: "agent_end", type: "run.completed" },
    { kind: "error", type: "run.failed" },
  ])(
    "waits for the worker outcome after controller $kind",
    ({ kind, type }) => {
      const events = [
        ...recoveryHistory(false),
        historyEntry(5, type, { kind }),
      ];
      const presentation = presentationFor(events);
      expect(presentation.end).toBeUndefined();
      expect(presentation.visible.at(-1)).toMatchObject({
        kind: "reasoning",
        streaming: true,
      });
      expect(renderHistory(events)).not.toContain("Worked for");
    }
  );

  it("keeps plan approval visible while waiting and never promotes its preceding commentary", () => {
    const proposal = historyEntry(2, "run.plan_proposed", {
      plan: {
        files: [
          {
            action: "modify",
            description: "Preserve before restoring",
            path: "src/preview/recovery.ts",
          },
        ],
        rationale: "Prevent lost edits on refresh",
        risk: "low",
        steps: [
          "Preserve pending edits",
          "Restore the checkpoint",
          "Verify refresh",
        ],
        summary: "Change recovery ordering",
        title: "Preserve preview edits",
      },
      toolCallId: "plan",
    });
    const events = [
      historyEntry(1, "agent.progress", {
        kind: "message_end",
        role: "assistant",
        text: "I’ll submit the recovery plan.",
      }),
      proposal,
    ];
    expect(renderHistory(events)).toContain("Preserve preview edits");
    const ended = [...events, endTurn("run.cancelled")];
    expect(presentationFor(ended).answer).toBeUndefined();
    expect(renderHistory(ended)).not.toContain(
      "I’ll submit the recovery plan."
    );
    expect(presentationFor(ended).history.at(-1)?.kind).toBe("plan");
  });

  it("collapses progress on completion and history replay, retaining only the final answer", () => {
    const events = [...recoveryHistory(), endTurn()];
    const html = renderHistory(events);
    expect(html).toContain("Worked for 6m 42s");
    expect(html).toContain(finalAnswer);
    expect(html).not.toContain(commentary);
    expect(html).not.toContain("Trace checkpoint");
    expect(html).toContain("Copy answer");
    const presentation = presentationFor(events);
    expect(presentation.answer?.text).toBe(finalAnswer);
    expect(presentation.history.map((entry) => entry.kind)).toEqual([
      "text",
      "reasoning",
      "tool",
      "reasoning",
    ]);
    expect(presentation.visible).toEqual([presentation.answer]);
  });

  it.each(["run.completed", "run.failed", "run.cancelled"])(
    "does not promote earlier commentary when %s ends without a final answer",
    (type) => {
      const events = [...recoveryHistory(false), endTurn(type)];
      const html = renderHistory(events);
      expect(html).toContain("Worked for 6m 42s");
      expect(html).not.toContain(commentary);
      expect(presentationFor(events).answer).toBeUndefined();
      if (type !== "run.completed") {
        expect(html).toContain(type === "run.failed" ? "Failed" : "Cancelled");
      }
    }
  );

  it("keeps every trailing text part of the final response without retaining earlier assistant messages", () => {
    const events = recoveryHistory();
    const saved = events.find((event) => event.payload.snapshot);
    if (!saved) {
      throw new Error("Expected snapshot fixture");
    }
    const snapshot = MessageSnapshotSchema.parse(saved.payload.snapshot);
    snapshot.parts.push({
      endedAt: null,
      index: 5,
      startedAt: snapshot.startedAt,
      text: " Browser and recovery tests pass.",
      type: "text",
    });
    saved.payload.snapshot = snapshot;
    const presentation = presentationFor([...events, endTurn()]);
    expect(presentation.answer?.text).toBe(
      `${finalAnswer} Browser and recovery tests pass.`
    );
    expect(presentation.history.map((entry) => entry.kind)).toEqual([
      "text",
      "reasoning",
      "tool",
      "reasoning",
    ]);
    const separateReplies = [
      historyEntry(1, "agent.progress", {
        kind: "message_end",
        messageId: "progress",
        role: "assistant",
        text: "Almost ready.",
      }),
      historyEntry(2, "agent.progress", {
        kind: "message_end",
        messageId: "final",
        role: "assistant",
        text: finalAnswer,
      }),
      endTurn(),
    ];
    expect(presentationFor(separateReplies).answer?.text).toBe(finalAnswer);
  });

  it("ends an unanswered tool approval on cancellation rather than keeping history actionable", () => {
    const events = [
      historyEntry(1, "agent.progress", {
        args: { question: "Which region?" },
        kind: "tool_start",
        toolCallId: "question",
        toolName: "ask_user",
      }),
      historyEntry(2, "approval.requested", {
        kind: "tool_suspended",
        suspendPayload: { question: "Which region?" },
        toolCallId: "question",
        toolName: "ask_user",
      }),
    ];
    expect(presentationFor(events).visible[0]).toMatchObject({
      kind: "tool",
      tool: { state: "approval-requested" },
    });
    expect(
      presentationFor([...events, endTurn("run.cancelled")]).history[0]
    ).toMatchObject({
      kind: "tool",
      tool: { endedAt: "2026-10-07T10:06:42.000Z", state: "output-denied" },
    });
  });
});
