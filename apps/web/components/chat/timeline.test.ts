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
  projectTranscript,
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
