import type { AgentControllerEvent } from "@mastra/core/agent-controller";
import { RunLiveEventSchema } from "@reasonateai/contracts/execution-protocol";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
} from "@reasonateai/contracts/identity";
import { describe, expect, it } from "vitest";
import { RunLiveEventMapper } from "../src/run-live-events.js";

const scope = {
  organizationId: OrganizationIdSchema.parse(
    "00000000-0000-4000-8000-000000000001"
  ),
  projectId: ProjectIdSchema.parse("00000000-0000-4000-8000-000000000002"),
  runId: RunIdSchema.parse("00000000-0000-4000-8000-000000000003"),
};
type Message = Extract<
  AgentControllerEvent,
  { type: "message_update" }
>["message"];
const at = new Date("2026-09-29T00:00:00Z");
const message = (parts: Message["content"]["parts"]): Message => ({
  content: { format: 2, parts },
  createdAt: at,
  id: "m",
  role: "assistant",
});

describe("ordered controller display snapshots", () => {
  it("preserves reasoning, narration, tool references, and final prose without concatenating them", () => {
    const mapper = new RunLiveEventMapper({ scope });
    const source = message([
      {
        details: [{ text: "Inspect the file first", type: "text" }],
        reasoning: "Inspect the file first",
        type: "reasoning",
      },
      { text: "Let me check the workspace.", type: "text" },
      {
        toolInvocation: {
          args: { target: "index.html" },
          state: "call",
          toolCallId: "c1",
          toolName: "read",
        },
        type: "tool-invocation",
      },
      { text: "Yes — reading works fine.", type: "text" },
    ]);
    const frame = mapper.map({ message: source, type: "message_end" }, at);
    expect(frame?.kind).toBe("message.snapshot");
    if (frame?.kind !== "message.snapshot") {
      throw new Error("Missing snapshot");
    }
    expect(frame.snapshot.parts.map((part) => part.type)).toEqual([
      "reasoning",
      "text",
      "tool",
      "text",
    ]);
    expect(frame.snapshot.parts[1]).toMatchObject({
      text: "Let me check the workspace.",
    });
    expect(frame.snapshot.parts[3]).toMatchObject({
      text: "Yes — reading works fine.",
    });
    expect(RunLiveEventSchema.parse(frame)).toEqual(frame);
  });
  it("snapshots the mutable source before a later update changes it", () => {
    const mapper = new RunLiveEventMapper({ scope });
    const source = message([{ text: "First", type: "text" }]);
    const first = mapper.map({ message: source, type: "message_update" }, at);
    source.content.parts.push({ text: "Second", type: "text" });
    const second = mapper.map(
      { message: source, type: "message_end" },
      new Date(at.getTime() + 1000)
    );
    expect(first).toMatchObject({
      snapshot: { finished: false, parts: [{ text: "First" }], revision: 1 },
    });
    expect(second).toMatchObject({
      snapshot: {
        finished: true,
        parts: [
          { endedAt: "2026-09-29T00:00:01.000Z", text: "First" },
          { text: "Second" },
        ],
        revision: 2,
      },
    });
  });
  it("keeps reasoning-only output and seals it when interrupted without message_end", () => {
    const mapper = new RunLiveEventMapper({ scope });
    mapper.map(
      {
        message: message([
          { details: [], reasoning: "Checking", type: "reasoning" },
        ]),
        type: "message_update",
      },
      at
    );
    expect(mapper.finish(new Date(at.getTime() + 1500))).toMatchObject([
      {
        snapshot: {
          finished: true,
          parts: [
            {
              endedAt: "2026-09-29T00:00:01.500Z",
              text: "Checking",
              type: "reasoning",
            },
          ],
        },
      },
    ]);
    expect(mapper.finish()).toEqual([]);
  });
  it("does not render empty compatibility reasoning or repeat unchanged content", () => {
    const mapper = new RunLiveEventMapper({ scope });
    expect(
      mapper.map(
        {
          message: message([{ details: [], reasoning: "", type: "reasoning" }]),
          type: "message_update",
        },
        at
      )
    ).toBeUndefined();
    const source = message([{ text: "hello", type: "text" }]);
    mapper.map({ message: source, type: "message_update" }, at);
    expect(
      mapper.map({ message: source, type: "message_update" }, at)
    ).toBeUndefined();
    expect(
      mapper.map({ message: source, type: "message_end" }, at)
    ).toMatchObject({ snapshot: { finished: true } });
  });
});
