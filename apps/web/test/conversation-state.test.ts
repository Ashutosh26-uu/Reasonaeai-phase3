import {
  type RunEventEnvelope,
  RunEventIdSchema,
} from "@reasonateai/contracts/execution-protocol";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
} from "@reasonateai/contracts/identity";
import { describe, expect, it } from "vitest";
import {
  initialConversationState,
  reduceConversationEvent,
} from "../lib/conversation-state";

describe("Conversation State Reducer", () => {
  const mockOrgId = OrganizationIdSchema.parse(
    "00000000-0000-4000-8000-000000000001"
  );
  const mockProjId = ProjectIdSchema.parse(
    "00000000-0000-4000-8000-000000000002"
  );
  const mockRunId = RunIdSchema.parse("00000000-0000-4000-8000-000000000003");

  function makeEvent(
    sequence: number,
    type: RunEventEnvelope["type"],
    payload: Record<string, unknown> = {}
  ): RunEventEnvelope {
    return {
      eventId: RunEventIdSchema.parse(
        `00000000-0000-4000-8000-0000000000${sequence.toString().padStart(2, "0")}`
      ),
      occurredAt: new Date().toISOString(),
      organizationId: mockOrgId,
      payload,
      projectId: mockProjId,
      runId: mockRunId,
      schemaVersion: 1,
      sequence,
      type,
    };
  }

  it("handles lifecycle notices and chat messages", () => {
    let state = initialConversationState();
    expect(state.lifecycle).toBe("idle");

    state = reduceConversationEvent(state, makeEvent(1, "run.queued"));
    expect(state.lifecycle).toBe("queued");
    expect(state.items).toHaveLength(1);

    state = reduceConversationEvent(state, makeEvent(2, "run.claimed"));
    expect(state.lifecycle).toBe("running");
    expect(state.items).toHaveLength(2);

    state = reduceConversationEvent(
      state,
      makeEvent(3, "agent.progress", {
        kind: "message_end",
        messageId: "msg-1",
        role: "assistant",
        text: "I have drafted the architecture.",
      })
    );

    expect(state.messages).toHaveLength(1);
    const [msg] = state.messages;
    expect(msg).toBeDefined();
    if (msg) {
      expect(msg.text).toBe("I have drafted the architecture.");
      expect(msg.role).toBe("assistant");
    }
    expect(state.items).toHaveLength(3);
  });

  it("handles tool execution lifecycle and updates", () => {
    let state = initialConversationState();

    state = reduceConversationEvent(
      state,
      makeEvent(1, "agent.progress", {
        args: { command: "pnpm test" },
        kind: "tool_start",
        toolCallId: "tool-100",
        toolName: "run_command",
      })
    );

    const tool1 = state.toolCalls["tool-100"];
    expect(tool1).toBeDefined();
    if (tool1) {
      expect(tool1.status).toBe("running");
      expect(tool1.toolName).toBe("run_command");
    }

    state = reduceConversationEvent(
      state,
      makeEvent(2, "agent.progress", {
        exitCode: 0,
        kind: "command_exit",
        success: true,
        toolCallId: "tool-100",
      })
    );

    const tool2 = state.toolCalls["tool-100"];
    expect(tool2).toBeDefined();
    if (tool2) {
      expect(tool2.status).toBe("completed");
      expect(tool2.exitCode).toBe(0);
    }

    state = reduceConversationEvent(
      state,
      makeEvent(3, "agent.progress", {
        isError: false,
        kind: "tool_end",
        result: { output: "Tests passed." },
        toolCallId: "tool-100",
      })
    );

    const tool3 = state.toolCalls["tool-100"];
    expect(tool3).toBeDefined();
    if (tool3) {
      expect(tool3.result).toEqual({
        output: "Tests passed.",
      });
    }
  });

  it("handles subagent delegation lifecycle", () => {
    let state = initialConversationState();

    state = reduceConversationEvent(
      state,
      makeEvent(1, "agent.started", {
        agentType: "scout",
        kind: "subagent_start",
        task: "Scan database migrations",
        toolCallId: "sub-1",
      })
    );

    const sub1 = state.subagents["sub-1"];
    expect(sub1).toBeDefined();
    if (sub1) {
      expect(sub1.status).toBe("running");
      expect(sub1.agentType).toBe("scout");
    }

    state = reduceConversationEvent(
      state,
      makeEvent(2, "agent.progress", {
        durationMs: 450,
        isError: false,
        kind: "subagent_end",
        result: { schemaFound: true },
        toolCallId: "sub-1",
      })
    );

    const sub2 = state.subagents["sub-1"];
    expect(sub2).toBeDefined();
    if (sub2) {
      expect(sub2.status).toBe("completed");
      expect(sub2.durationMs).toBe(450);
    }
  });

  it("handles approval requested and resolved (Smart Handoff)", () => {
    let state = initialConversationState();

    state = reduceConversationEvent(
      state,
      makeEvent(1, "approval.requested", {
        args: { scope: "payments" },
        suspendPayload: { prompt: "Please provide STRIPE_SECRET_KEY" },
        toolCallId: "appr-1",
        toolName: "stripe_setup",
      })
    );

    expect(state.lifecycle).toBe("awaiting_approval");
    expect(state.activeApproval).toBeDefined();
    if (state.activeApproval) {
      expect(state.activeApproval.toolCallId).toBe("appr-1");
      expect(state.activeApproval.status).toBe("pending");
    }

    state = reduceConversationEvent(
      state,
      makeEvent(2, "approval.resolved", {
        resolution: "approved",
        toolCallId: "appr-1",
      })
    );

    expect(state.lifecycle).toBe("running");
    expect(state.activeApproval).toBeNull();
  });

  it("handles tasks, verification, previews, and terminal states", () => {
    let state = initialConversationState();

    state = reduceConversationEvent(
      state,
      makeEvent(1, "task.updated", {
        tasks: [
          { id: "t1", status: "completed", title: "Setup Database" },
          { id: "t2", status: "in_progress", title: "Implement API" },
        ],
      })
    );

    expect(state.tasks).toHaveLength(2);
    const [task1] = state.tasks;
    expect(task1).toBeDefined();
    if (task1) {
      expect(task1.status).toBe("completed");
    }

    state = reduceConversationEvent(
      state,
      makeEvent(2, "preview.ready", {
        url: "http://localhost:3000/preview/123",
      })
    );

    const prevItem = state.items.find((i) => i.type === "preview_deployment");
    expect(prevItem).toBeDefined();

    state = reduceConversationEvent(
      state,
      makeEvent(3, "run.completed", {
        reason: "All requirements met and verified.",
      })
    );

    expect(state.lifecycle).toBe("completed");
    expect(state.terminalReason).toBe("All requirements met and verified.");
  });

  it("ignores out-of-order sequence events", () => {
    let state = initialConversationState();
    state = reduceConversationEvent(state, makeEvent(5, "run.claimed"));
    expect(state.lastSequence).toBe(5);

    // Sequence 3 should be ignored
    state = reduceConversationEvent(state, makeEvent(3, "run.queued"));
    expect(state.lastSequence).toBe(5);
    expect(state.items).toHaveLength(1);
  });
});
