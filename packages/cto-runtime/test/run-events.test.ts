import type { AgentControllerEvent } from "@mastra/core/agent-controller";
import { BuildSessionIdSchema } from "@reasonateai/contracts/execution";
import {
  isReplayableSequence,
  RunEventEnvelopeSchema,
  type RunEventType,
} from "@reasonateai/contracts/execution-protocol";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
} from "@reasonateai/contracts/identity";
import { describe, expect, it } from "vitest";
import { toRunEventEnvelope, UNASSIGNED_SEQUENCE } from "../src/run-events.js";

const scope = {
  buildSessionId: BuildSessionIdSchema.parse(
    "00000000-0000-4000-8000-000000000001"
  ),
  organizationId: OrganizationIdSchema.parse(
    "00000000-0000-4000-8000-000000000002"
  ),
  projectId: ProjectIdSchema.parse("00000000-0000-4000-8000-000000000003"),
};
const runId = RunIdSchema.parse("00000000-0000-4000-8000-000000000004");
const occurredAt = new Date("2026-01-02T03:04:05.678Z");
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Message = Extract<
  AgentControllerEvent,
  { type: "message_end" }
>["message"];
type Part = Message["content"]["parts"][number];

/** A message as the controller streams and persists it. */
function message(id: string, role: Message["role"], parts: Part[]): Message {
  return { content: { format: 2, parts }, createdAt: occurredAt, id, role };
}

const assistantText = message("m-assistant", "assistant", [
  { text: "I will read the specification first.", type: "text" },
]);
const userText = message("m-user", "user", [
  { text: "Ship the preview once the checks pass.", type: "text" },
]);
const emptyText = message("m-empty", "assistant", []);
const toolOnly = message("m-tool-only", "assistant", [{ type: "step-start" }]);

/** Maps one event the way a worker does, with the suite's fixed scope. */
function map(event: AgentControllerEvent) {
  return toRunEventEnvelope({ event, occurredAt, runId, scope });
}

interface DurableCase {
  event: AgentControllerEvent;
  name: string;
  payload: Record<string, unknown>;
  type: RunEventType;
}

const DURABLE: DurableCase[] = [
  {
    event: { type: "agent_start" },
    name: "the agent starting",
    payload: { kind: "agent_start" },
    type: "agent.started",
  },
  {
    event: { reason: "complete", type: "agent_end" },
    name: "the agent finishing a run",
    payload: { kind: "agent_end", reason: "complete" },
    type: "run.completed",
  },
  {
    event: { type: "agent_end" },
    name: "an agent end that named no reason, as one that finished",
    payload: { kind: "agent_end", reason: "complete" },
    type: "run.completed",
  },
  {
    event: { reason: "error", type: "agent_end" },
    name: "the agent ending on an error",
    payload: { kind: "agent_end", reason: "error" },
    type: "run.failed",
  },
  {
    event: { reason: "aborted", type: "agent_end" },
    name: "the agent ending because it was aborted",
    payload: { kind: "agent_end", reason: "aborted" },
    type: "run.cancelled",
  },
  {
    event: { reason: "suspended", type: "agent_end" },
    name: "the agent ending suspended, which is progress rather than an outcome",
    payload: { kind: "agent_end", reason: "suspended" },
    type: "agent.progress",
  },
  {
    event: { message: assistantText, type: "message_end" },
    name: "assistant text",
    payload: {
      kind: "message_end",
      messageId: "m-assistant",
      role: "assistant",
      text: "I will read the specification first.",
    },
    type: "agent.progress",
  },
  {
    event: { message: userText, type: "message_end" },
    name: "the user's own instruction",
    payload: {
      kind: "message_end",
      messageId: "m-user",
      role: "user",
      text: "Ship the preview once the checks pass.",
    },
    type: "agent.progress",
  },
  {
    event: {
      args: { command: "pnpm --filter @reasonateai/api test" },
      toolCallId: "call-shell",
      toolName: "run_command",
      type: "tool_start",
    },
    name: "a tool call with its arguments",
    payload: {
      args: { command: "pnpm --filter @reasonateai/api test" },
      kind: "tool_start",
      toolCallId: "call-shell",
      toolName: "run_command",
    },
    type: "agent.progress",
  },
  {
    event: {
      isError: false,
      result: { exitCode: 0, stdout: "218 passed" },
      toolCallId: "call-shell",
      type: "tool_end",
    },
    name: "a tool result",
    payload: {
      denied: false,
      isError: false,
      kind: "tool_end",
      result: { exitCode: 0, stdout: "218 passed" },
      toolCallId: "call-shell",
    },
    type: "agent.progress",
  },
  {
    event: {
      denied: true,
      isError: false,
      result: { reason: "the user declined" },
      toolCallId: "call-deploy",
      type: "tool_end",
    },
    name: "a tool call that resolved without running",
    payload: {
      denied: true,
      isError: false,
      kind: "tool_end",
      result: { reason: "the user declined" },
      toolCallId: "call-deploy",
    },
    type: "agent.progress",
  },
  {
    event: {
      exitCode: 1,
      success: false,
      toolCallId: "call-shell",
      type: "command_exit",
    },
    name: "a command's exit code",
    payload: {
      exitCode: 1,
      kind: "command_exit",
      success: false,
      toolCallId: "call-shell",
    },
    type: "agent.progress",
  },
  {
    event: {
      args: { path: "/etc/hosts" },
      toolCallId: "call-deploy",
      toolName: "deploy",
      type: "tool_approval_required",
    },
    name: "a tool parked at its approval gate",
    payload: {
      args: { path: "/etc/hosts" },
      kind: "tool_approval_required",
      toolCallId: "call-deploy",
      toolName: "deploy",
    },
    type: "approval.requested",
  },
  {
    event: {
      args: { question: "Which region?" },
      resumeSchema: '{"type":"object"}',
      suspendPayload: { question: "Which region?" },
      toolCallId: "call-ask",
      toolName: "ask_user",
      type: "tool_suspended",
    },
    name: "a tool suspended until something outside the run answers",
    payload: {
      args: { question: "Which region?" },
      kind: "tool_suspended",
      resumeSchema: '{"type":"object"}',
      suspendPayload: { question: "Which region?" },
      toolCallId: "call-ask",
      toolName: "ask_user",
    },
    type: "approval.requested",
  },
  {
    event: {
      args: { question: "Which region?" },
      suspendPayload: { question: "Which region?" },
      toolCallId: "call-ask",
      toolName: "ask_user",
      type: "tool_suspended",
    },
    name: "a suspension that declared no resume schema",
    payload: {
      args: { question: "Which region?" },
      kind: "tool_suspended",
      suspendPayload: { question: "Which region?" },
      toolCallId: "call-ask",
      toolName: "ask_user",
    },
    type: "approval.requested",
  },
  {
    event: {
      reason: "the run was cancelled",
      toolCallId: "call-ask",
      toolName: "ask_user",
      type: "tool_suspension_cancelled",
    },
    name: "a suspension that was cancelled",
    payload: {
      kind: "tool_suspension_cancelled",
      reason: "the run was cancelled",
      resolution: "cancelled",
      toolCallId: "call-ask",
      toolName: "ask_user",
    },
    type: "approval.resolved",
  },
  {
    event: {
      agentType: "researcher",
      forked: true,
      modelId: "openai/gpt-5",
      task: "Read the API contract and report the auth boundaries.",
      toolCallId: "call-delegate",
      type: "subagent_start",
    },
    name: "a subagent starting",
    payload: {
      agentType: "researcher",
      forked: true,
      kind: "subagent_start",
      modelId: "openai/gpt-5",
      task: "Read the API contract and report the auth boundaries.",
      toolCallId: "call-delegate",
    },
    type: "agent.started",
  },
  {
    event: {
      agentType: "researcher",
      subToolArgs: { path: "packages/contracts/src/execution-protocol.ts" },
      subToolName: "read_file",
      toolCallId: "call-delegate",
      type: "subagent_tool_start",
    },
    name: "a subagent's own tool call",
    payload: {
      agentType: "researcher",
      kind: "subagent_tool_start",
      subToolArgs: { path: "packages/contracts/src/execution-protocol.ts" },
      subToolName: "read_file",
      toolCallId: "call-delegate",
    },
    type: "agent.progress",
  },
  {
    event: {
      agentType: "researcher",
      isError: false,
      subToolName: "read_file",
      subToolResult: { lines: 181 },
      toolCallId: "call-delegate",
      type: "subagent_tool_end",
    },
    name: "a subagent's own tool result",
    payload: {
      agentType: "researcher",
      isError: false,
      kind: "subagent_tool_end",
      subToolName: "read_file",
      subToolResult: { lines: 181 },
      toolCallId: "call-delegate",
    },
    type: "agent.progress",
  },
  {
    event: {
      agentType: "researcher",
      durationMs: 1810,
      isError: false,
      result: "The contract is strict about sequences.",
      toolCallId: "call-delegate",
      type: "subagent_end",
    },
    name: "a subagent finishing",
    payload: {
      agentType: "researcher",
      durationMs: 1810,
      isError: false,
      kind: "subagent_end",
      result: "The contract is strict about sequences.",
      toolCallId: "call-delegate",
    },
    type: "agent.progress",
  },
  {
    event: {
      tasks: [
        {
          activeForm: "Reading the specification",
          content: "Read the specification",
          id: "1",
          status: "in_progress",
        },
      ],
      type: "task_updated",
    },
    name: "the run's task list",
    payload: {
      kind: "task_updated",
      tasks: [
        {
          activeForm: "Reading the specification",
          content: "Read the specification",
          id: "1",
          status: "in_progress",
        },
      ],
    },
    type: "task.updated",
  },
  {
    event: {
      error: new Error("The provider rejected the request."),
      errorType: "provider_error",
      type: "error",
    },
    name: "a failure the controller will not retry",
    payload: {
      errorType: "provider_error",
      kind: "error",
      message: "The provider rejected the request.",
    },
    type: "run.failed",
  },
  {
    event: {
      error: new Error("The connection reset."),
      maxRetries: 3,
      retryAttempt: 1,
      retryable: true,
      type: "error",
    },
    name: "a retryable failure the run is recovering from",
    payload: {
      kind: "error",
      maxRetries: 3,
      message: "The connection reset.",
      retryAttempt: 1,
      retryable: true,
    },
    type: "agent.progress",
  },
  {
    event: {
      message: "Restored the workspace from checkpoint 41.",
      type: "info",
    },
    name: "an informational note",
    payload: {
      kind: "info",
      message: "Restored the workspace from checkpoint 41.",
    },
    type: "agent.progress",
  },
];

/** Events that carry nothing durable: the live view only. */
const LIVE_ONLY: Array<{ event: AgentControllerEvent; name: string }> = [
  {
    event: { message: assistantText, type: "message_start" },
    name: "a message starting to stream",
  },
  {
    event: { message: assistantText, type: "message_update" },
    name: "a message updating as it streams",
  },
  {
    event: { message: emptyText, type: "message_end" },
    name: "a message that carried no text",
  },
  {
    event: { message: toolOnly, type: "message_end" },
    name: "an assistant turn that only called tools",
  },
  {
    event: {
      toolCallId: "c",
      toolName: "run_command",
      type: "tool_input_start",
    },
    name: "tool arguments starting",
  },
  {
    event: {
      argsTextDelta: '{"comm',
      toolCallId: "c",
      type: "tool_input_delta",
    },
    name: "tool arguments streaming",
  },
  {
    event: { toolCallId: "c", type: "tool_input_end" },
    name: "tool arguments ending",
  },
  {
    event: {
      partialResult: { stdout: "half a line" },
      toolCallId: "c",
      type: "tool_update",
    },
    name: "a partial tool result",
  },
  {
    event: {
      output: "half a line",
      stream: "stdout",
      toolCallId: "c",
      type: "shell_output",
    },
    name: "live shell output",
  },
  {
    event: { modeId: "cto", previousModeId: "default", type: "mode_changed" },
    name: "a mode change",
  },
  {
    event: { modelId: "openai/gpt-5", type: "model_changed" },
    name: "a model change",
  },
  {
    event: { previousThreadId: null, threadId: "t-1", type: "thread_changed" },
    name: "a thread change",
  },
  {
    event: { threadId: "t-1", type: "thread_deleted" },
    name: "a thread being deleted",
  },
  {
    event: {
      changedKeys: ["mode"],
      state: { mode: "cto" },
      type: "state_changed",
    },
    name: "controller state changing",
  },
  {
    event: {
      threadId: "t-1",
      title: "Preview deploy",
      type: "thread_title_updated",
    },
    name: "a thread being retitled",
  },
  {
    event: {
      type: "usage_update",
      usage: { completionTokens: 12, promptTokens: 900, totalTokens: 912 },
    },
    name: "a token usage update",
  },
  { event: { count: 1, type: "follow_up_queued" }, name: "a queued follow-up" },
  {
    event: {
      agentType: "researcher",
      textDelta: "The ",
      toolCallId: "c",
      type: "subagent_text_delta",
    },
    name: "subagent text streaming",
  },
  {
    event: {
      modelId: "openai/gpt-5",
      scope: "thread",
      type: "subagent_model_changed",
    },
    name: "a subagent's model change",
  },
  {
    event: { error: new Error("no workspace"), type: "workspace_error" },
    name: "a workspace error",
  },
  {
    event: {
      type: "workspace_ready",
      workspaceId: "w-1",
      workspaceName: "build",
    },
    name: "a workspace becoming ready",
  },
  {
    event: {
      cycleId: "cy-1",
      operationType: "observation",
      tokensToObserve: 4096,
      type: "om_observation_start",
    },
    name: "context observation starting",
  },
  {
    event: {
      cycleId: "cy-1",
      durationMs: 120,
      error: "timeout",
      type: "om_observation_failed",
    },
    name: "context observation failing",
  },
  {
    event: {
      cycleId: "cy-1",
      operationType: "reflection",
      tokensToBuffer: 2048,
      type: "om_buffering_start",
    },
    name: "context buffering starting",
  },
  {
    event: {
      modelId: "openai/gpt-5-mini",
      role: "observer",
      type: "om_model_changed",
    },
    name: "a context model change",
  },
];

describe("controller events to run events", () => {
  for (const item of DURABLE) {
    it(`maps ${item.name} into the run's ledger scope as ${item.type}`, () => {
      const envelope = map(item.event);

      expect(envelope?.type).toBe(item.type);
      expect(envelope?.payload).toEqual({
        buildSessionId: scope.buildSessionId,
        ...item.payload,
      });
      expect(envelope?.runId).toBe(runId);
      expect(envelope?.organizationId).toBe(scope.organizationId);
      expect(envelope?.projectId).toBe(scope.projectId);
      expect(envelope?.occurredAt).toBe(occurredAt.toISOString());
      expect(envelope?.schemaVersion).toBe(1);
      expect(envelope?.eventId).toMatch(UUID_PATTERN);
      expect(RunEventEnvelopeSchema.safeParse(envelope).success).toBe(true);
    });
  }

  for (const item of LIVE_ONLY) {
    it(`records nothing durable for ${item.name}`, () => {
      expect(map(item.event)).toBeUndefined();
    });
  }

  it("reports the unassigned cursor rather than inventing a ledger position", () => {
    const sequences = DURABLE.flatMap((item) => {
      const first = map(item.event);
      const second = map(item.event);
      const advances = [first?.sequence, second?.sequence];
      expect(advances).toEqual([UNASSIGNED_SEQUENCE, UNASSIGNED_SEQUENCE]);
      return advances;
    });

    expect(sequences.every((each) => each === UNASSIGNED_SEQUENCE)).toBe(true);
    // The store owns the sequence; zero is the contract's own cursor for
    // "nothing has been delivered yet", never a position of one.
    expect(UNASSIGNED_SEQUENCE).toBe(0);
    expect(isReplayableSequence(UNASSIGNED_SEQUENCE)).toBe(true);
  });

  it("gives every mapped event its own identity", () => {
    const event: AgentControllerEvent = { type: "agent_start" };
    const first = map(event);
    const second = map(event);

    expect(first?.eventId).toMatch(UUID_PATTERN);
    expect(second?.eventId).toMatch(UUID_PATTERN);
    expect(first?.eventId).not.toBe(second?.eventId);
  });

  it("stamps the identity of the run it was given, not of the event", () => {
    const otherRun = RunIdSchema.parse("00000000-0000-4000-8000-000000000020");
    const otherScope = {
      buildSessionId: BuildSessionIdSchema.parse(
        "00000000-0000-4000-8000-000000000021"
      ),
      organizationId: OrganizationIdSchema.parse(
        "00000000-0000-4000-8000-000000000022"
      ),
      projectId: ProjectIdSchema.parse("00000000-0000-4000-8000-000000000023"),
    };

    const envelope = toRunEventEnvelope({
      event: { message: "working", type: "info" },
      occurredAt,
      runId: otherRun,
      scope: otherScope,
    });

    expect(envelope?.runId).toBe(otherRun);
    expect(envelope?.organizationId).toBe(otherScope.organizationId);
    expect(envelope?.projectId).toBe(otherScope.projectId);
    expect(envelope?.payload.buildSessionId).toBe(otherScope.buildSessionId);
    expect(envelope?.payload.buildSessionId).not.toBe(scope.buildSessionId);
  });

  it("carries the assistant text of a message the controller re-sent", () => {
    const long = message("m-long", "assistant", [
      { text: "first ", type: "text" },
      { text: "second", type: "text" },
    ]);

    const envelope = map({ message: long, type: "message_end" });

    expect(envelope?.payload.text).toBe("first second");
  });
});
