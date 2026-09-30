import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApprovalPrompt } from "../components/cto-conversation/approval-prompt";
import { ConnectionStatusBadge } from "../components/cto-conversation/connection-status-badge";
import { SubagentBadge } from "../components/cto-conversation/subagent-badge";
import { TaskProgressTree } from "../components/cto-conversation/task-progress-tree";
import { ToolExecutionCard } from "../components/cto-conversation/tool-execution-card";
import type {
  ApprovalGateItem,
  SubagentDelegationItem,
  TaskItem,
  ToolExecutionItem,
} from "../lib/conversation-state";

describe("CTO Conversation Components", () => {
  it("renders ConnectionStatusBadge across states", () => {
    const htmlConnected = renderToStaticMarkup(
      <ConnectionStatusBadge state="connected" />
    );
    expect(htmlConnected).toContain("Live Stream");

    const htmlReconnecting = renderToStaticMarkup(
      <ConnectionStatusBadge detail={{ attempt: 2 }} state="reconnecting" />
    );
    expect(htmlReconnecting).toContain("Reconnecting (#2)...");

    const htmlError = renderToStaticMarkup(
      <ConnectionStatusBadge state="error" />
    );
    expect(htmlError).toContain("Disconnected");
  });

  it("renders SubagentBadge for Scout, Coder, and Debugger", () => {
    const subagentScout: SubagentDelegationItem = {
      agentType: "scout",
      durationMs: 320,
      id: "sub-1",
      sequence: 1,
      status: "completed",
      task: "Inspect PostgreSQL migrations",
      timestamp: new Date().toISOString(),
      type: "subagent_delegation",
    };

    const html = renderToStaticMarkup(
      <SubagentBadge subagent={subagentScout} />
    );
    expect(html).toContain("Scout Investigator");
    expect(html).toContain("Inspect PostgreSQL migrations");
    expect(html).toContain("320ms");
  });

  it("renders ToolExecutionCard with command arguments and status", () => {
    const toolItem: ToolExecutionItem = {
      args: { CommandLine: "pnpm test" },
      exitCode: 0,
      id: "tool-1",
      sequence: 2,
      status: "completed",
      timestamp: new Date().toISOString(),
      toolName: "run_command",
      type: "tool_execution",
    };

    const html = renderToStaticMarkup(<ToolExecutionCard tool={toolItem} />);
    expect(html).toContain("run_command");
    expect(html).toContain("pnpm test");
    expect(html).toContain("exit 0");
  });

  it("renders ApprovalPrompt for Smart Handoff", () => {
    const approval: ApprovalGateItem = {
      args: { liveMode: false },
      id: "appr-1",
      sequence: 3,
      status: "pending",
      suspendPayload: { prompt: "Please provide STRIPE_SECRET_KEY" },
      timestamp: new Date().toISOString(),
      toolCallId: "tool-call-99",
      toolName: "stripe_setup",
      type: "approval_gate",
    };

    const onResolveMock = vi.fn();
    const html = renderToStaticMarkup(
      <ApprovalPrompt approval={approval} onResolve={onResolveMock} />
    );
    expect(html).toContain("Smart Handoff Required");
    expect(html).toContain("Please provide STRIPE_SECRET_KEY");
    expect(html).toContain("Approve &amp; Continue");
  });

  it("renders TaskProgressTree with completion stats", () => {
    const tasks: TaskItem[] = [
      { id: "t1", status: "completed", title: "Setup Database Schema" },
      { id: "t2", status: "in_progress", title: "Implement API Handlers" },
      { id: "t3", status: "pending", title: "Verify with Regression Tests" },
    ];

    const html = renderToStaticMarkup(<TaskProgressTree tasks={tasks} />);
    expect(html).toContain("Execution Plan Progress");
    expect(html).toContain("1/3 (33%)");
    expect(html).toContain("Setup Database Schema");
    expect(html).toContain("Implement API Handlers");
  });
});
