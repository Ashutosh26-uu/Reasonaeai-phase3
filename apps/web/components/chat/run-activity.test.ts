import { randomUUID } from "node:crypto";
import {
  type RunEventEnvelope,
  RunEventEnvelopeSchema,
  type RunEventType,
} from "@reasonateai/contracts/execution-protocol";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
} from "@reasonateai/contracts/identity";
import { describe, expect, it } from "vitest";
import { EMPTY_ACTIVITY, foldDurable, foldLive } from "./run-activity";

const organizationId = OrganizationIdSchema.parse(randomUUID());
const projectId = ProjectIdSchema.parse(randomUUID());
const runId = RunIdSchema.parse(randomUUID());

let sequence = 0;

/** One durable event, as the run's ledger records it and the browser receives it. */
function event(
  type: RunEventType,
  payload: Record<string, unknown>
): RunEventEnvelope {
  sequence += 1;
  return RunEventEnvelopeSchema.parse({
    eventId: randomUUID(),
    occurredAt: new Date(sequence * 1000).toISOString(),
    organizationId,
    payload,
    projectId,
    runId,
    schemaVersion: 1,
    sequence,
    type,
  });
}

const toolStart = (toolCallId: string, toolName: string, args: unknown) =>
  event("agent.progress", { args, kind: "tool_start", toolCallId, toolName });

const toolEnd = (
  toolCallId: string,
  result: unknown,
  isError = false,
  denied = false
) =>
  event("agent.progress", {
    denied,
    isError,
    kind: "tool_end",
    result,
    toolCallId,
  });

describe("run activity", () => {
  it("opens a row for a tool call and closes it with what it returned", () => {
    const opened = foldDurable(
      EMPTY_ACTIVITY,
      toolStart("call-1", "run_command", { command: "pnpm test" })
    );

    expect(opened.items).toEqual([
      expect.objectContaining({
        detail: "pnpm test",
        id: "call-1",
        result: "",
        status: "input-available",
        title: "run_command",
      }),
    ]);

    const closed = foldDurable(
      opened,
      toolEnd("call-1", { exitCode: 1, stdout: "218 passed\n1 failed" })
    );
    expect(closed.items[0]).toMatchObject({
      result: "218 passed",
      status: "output-available",
    });
  });

  it("marks a failed call as an error rather than a finished one", () => {
    const opened = foldDurable(
      EMPTY_ACTIVITY,
      toolStart("call-1", "write", { path: "src/app.ts" })
    );
    const closed = foldDurable(
      opened,
      toolEnd("call-1", { message: "permission denied" }, true)
    );

    expect(closed.items[0]?.status).toBe("output-error");
    expect(closed.items[0]?.result).toBe("permission denied");
  });

  it("turns the row a delegation opened into the worker it spawned", () => {
    const delegated = foldDurable(
      EMPTY_ACTIVITY,
      toolStart("call-1", "agent", { prompt: "map the app" })
    );
    const started = foldDurable(
      delegated,
      event("agent.started", {
        agentType: "scout",
        forked: false,
        kind: "subagent_start",
        modelId: "m",
        task: "Map every route and report the risky ones.",
        toolCallId: "call-1",
      })
    );

    expect(started.items).toHaveLength(1);
    expect(started.items[0]).toMatchObject({
      detail: "Map every route and report the risky ones.",
      kind: "subagent",
      status: "input-available",
      title: "scout",
    });
  });

  it("nests a worker's own calls under it and closes them in order", () => {
    let activity = foldDurable(
      EMPTY_ACTIVITY,
      event("agent.started", {
        agentType: "scout",
        kind: "subagent_start",
        task: "Trace the checkout route.",
        toolCallId: "call-1",
      })
    );
    activity = foldDurable(
      activity,
      event("agent.progress", {
        agentType: "scout",
        kind: "subagent_tool_start",
        subToolArgs: { path: "app/api/checkout/route.ts" },
        subToolName: "read",
        toolCallId: "call-1",
      })
    );
    activity = foldDurable(
      activity,
      event("agent.progress", {
        agentType: "scout",
        kind: "subagent_tool_start",
        subToolArgs: { query: "checkout" },
        subToolName: "search",
        toolCallId: "call-1",
      })
    );
    activity = foldDurable(
      activity,
      event("agent.progress", {
        agentType: "scout",
        isError: false,
        kind: "subagent_tool_end",
        subToolName: "read",
        subToolResult: { content: "export async function POST() {}" },
        toolCallId: "call-1",
      })
    );
    activity = foldDurable(
      activity,
      event("agent.progress", {
        agentType: "scout",
        durationMs: 1200,
        isError: false,
        kind: "subagent_end",
        result: "Checkout posts to the payment provider without a retry.",
        toolCallId: "call-1",
      })
    );

    const [worker] = activity.items;
    expect(worker?.children.map((child) => child.title)).toEqual([
      "read",
      "search",
    ]);
    expect(worker?.children[0]).toMatchObject({
      status: "output-available",
    });
    expect(worker?.children[1]?.status).toBe("input-available");
    expect(worker?.status).toBe("output-available");
    expect(worker?.result).toContain("without a retry");
  });

  it("keeps each run's work in its own structure", () => {
    const otherRunId = RunIdSchema.parse(randomUUID());
    const first = foldDurable(
      EMPTY_ACTIVITY,
      toolStart("call-1", "read", { path: "README.md" })
    );
    const second = foldDurable(first, {
      ...event("agent.progress", {
        args: { path: "AGENTS.md" },
        kind: "tool_start",
        toolCallId: "call-2",
        toolName: "read",
      }),
      runId: otherRunId,
    });

    expect(second.items.map((item) => item.id)).toEqual(["call-2"]);
    expect(second.runId).toBe(otherRunId);
  });

  it("appends a worker's streamed text to that worker only", () => {
    let activity = foldDurable(
      EMPTY_ACTIVITY,
      event("agent.started", {
        agentType: "coder",
        kind: "subagent_start",
        task: "Fix the retry.",
        toolCallId: "call-1",
      })
    );
    activity = foldDurable(
      activity,
      event("agent.started", {
        agentType: "reviewer",
        kind: "subagent_start",
        task: "Check the fix.",
        toolCallId: "call-2",
      })
    );

    activity = foldLive(activity, {
      delta: "Editing ",
      kind: "subagent.delta",
      toolCallId: "call-1",
    });
    activity = foldLive(activity, {
      delta: "app/api/checkout/route.ts",
      kind: "subagent.delta",
      toolCallId: "call-1",
    });

    expect(activity.items[0]?.text).toBe("Editing app/api/checkout/route.ts");
    expect(activity.items[1]?.text).toBe("");
  });

  it("shows a call that needs a decision, with the arguments at stake", () => {
    const opened = foldDurable(
      EMPTY_ACTIVITY,
      toolStart("call-1", "deploy", { command: "pnpm deploy --prod" })
    );
    const parked = foldDurable(
      opened,
      event("approval.requested", {
        args: { command: "pnpm deploy --prod" },
        kind: "tool_approval_required",
        toolCallId: "call-1",
        toolName: "deploy",
      })
    );

    expect(parked.items[0]).toMatchObject({
      detail: "pnpm deploy --prod",
      status: "approval-requested",
      title: "deploy",
    });
  });

  it("ignores events that describe nothing a reader can see", () => {
    const activity = foldDurable(
      EMPTY_ACTIVITY,
      toolStart("call-1", "read", { path: "README.md" })
    );
    const files = foldDurable(
      activity,
      event("verification.started", { kind: "usage_update" })
    );

    expect(files).toBe(activity);
  });
});
