import type { RunEventEnvelope } from "@reasonateai/contracts/execution-protocol";

export interface ChatMessageItem {
  id: string;
  role: "assistant" | "user";
  sequence: number;
  text: string;
  timestamp: string;
  type: "chat_message";
}

export interface ToolExecutionItem {
  args: Record<string, unknown>;
  exitCode?: number | undefined;
  id: string;
  isError?: boolean | undefined;
  result?: unknown | undefined;
  sequence: number;
  status: "running" | "completed" | "failed" | "denied";
  timestamp: string;
  toolName: string;
  type: "tool_execution";
}

export interface SubagentDelegationItem {
  agentType: string;
  durationMs?: number | undefined;
  id: string;
  modelId?: string | undefined;
  result?: unknown | undefined;
  sequence: number;
  status: "running" | "completed" | "failed";
  task: string;
  timestamp: string;
  type: "subagent_delegation";
}

export interface TaskItem {
  id: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  title: string;
}

export interface ApprovalGateItem {
  args: Record<string, unknown>;
  id: string;
  resolution?: unknown | undefined;
  resumeSchema?: unknown | undefined;
  sequence: number;
  status: "pending" | "resolved" | "cancelled";
  suspendPayload?: unknown | undefined;
  timestamp: string;
  toolCallId: string;
  toolName: string;
  type: "approval_gate";
}

export interface VerificationItem {
  id: string;
  sequence: number;
  status: "started" | "passed" | "failed";
  summary?: string | undefined;
  timestamp: string;
  type: "verification";
}

export interface ArtifactRecordedItem {
  artifactId?: string | undefined;
  id: string;
  kind?: string | undefined;
  sequence: number;
  timestamp: string;
  type: "artifact_recorded";
}

export interface PreviewDeploymentItem {
  id: string;
  kind: "preview" | "deployment";
  sequence: number;
  status: "started" | "ready" | "failed";
  timestamp: string;
  type: "preview_deployment";
  url?: string | undefined;
}

export interface LifecycleNoticeItem {
  id: string;
  message?: string | undefined;
  sequence: number;
  status:
    | "queued"
    | "claimed"
    | "sandbox_allocated"
    | "completed"
    | "failed"
    | "cancelled";
  timestamp: string;
  type: "lifecycle_notice";
}

export type ConversationTimelineItem =
  | ChatMessageItem
  | ToolExecutionItem
  | SubagentDelegationItem
  | ApprovalGateItem
  | VerificationItem
  | ArtifactRecordedItem
  | PreviewDeploymentItem
  | LifecycleNoticeItem;

export type RunLifecycleStatus =
  | "idle"
  | "queued"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export interface ConversationState {
  activeApproval: ApprovalGateItem | null;
  items: ConversationTimelineItem[];
  lastSequence: number;
  lifecycle: RunLifecycleStatus;
  messages: ChatMessageItem[];
  subagents: Record<string, SubagentDelegationItem>;
  tasks: TaskItem[];
  terminalReason?: string | undefined;
  toolCalls: Record<string, ToolExecutionItem>;
}

export function initialConversationState(): ConversationState {
  return {
    activeApproval: null,
    items: [],
    lastSequence: 0,
    lifecycle: "idle",
    messages: [],
    subagents: {},
    tasks: [],
    toolCalls: {},
  };
}

function resolveToolStatus(
  denied: boolean,
  isError: boolean
): ToolExecutionItem["status"] {
  if (denied) {
    return "denied";
  }
  if (isError) {
    return "failed";
  }
  return "completed";
}

function resolveVerificationStatus(
  type: RunEventEnvelope["type"]
): VerificationItem["status"] {
  if (type === "verification.started") {
    return "started";
  }
  if (type === "verification.passed") {
    return "passed";
  }
  return "failed";
}

function resolveDeploymentStatus(
  type: RunEventEnvelope["type"]
): PreviewDeploymentItem["status"] {
  if (type === "deployment.started") {
    return "started";
  }
  if (type === "deployment.ready") {
    return "ready";
  }
  return "failed";
}

interface DraftState {
  activeApproval: ApprovalGateItem | null;
  items: ConversationTimelineItem[];
  lifecycle: ConversationState["lifecycle"];
  messages: ChatMessageItem[];
  subagents: Record<string, SubagentDelegationItem>;
  tasks: TaskItem[];
  terminalReason?: string | undefined;
  toolCalls: Record<string, ToolExecutionItem>;
}

function resolveFailureReason(payload: Record<string, unknown>): string {
  if (typeof payload.message === "string") {
    return payload.message;
  }
  if (typeof payload.reason === "string") {
    return payload.reason;
  }
  return "Run failed.";
}

function handleLifecycleEvent(
  draft: DraftState,
  event: RunEventEnvelope,
  payload: Record<string, unknown>
): void {
  switch (event.type) {
    case "run.queued": {
      draft.lifecycle = "queued";
      draft.items.push({
        id: event.eventId,
        message: "Run queued in execution plane...",
        sequence: event.sequence,
        status: "queued",
        timestamp: event.occurredAt,
        type: "lifecycle_notice",
      });
      break;
    }

    case "run.claimed": {
      draft.lifecycle = "running";
      draft.items.push({
        id: event.eventId,
        message: "Run claimed by private worker.",
        sequence: event.sequence,
        status: "claimed",
        timestamp: event.occurredAt,
        type: "lifecycle_notice",
      });
      break;
    }

    case "sandbox.allocated": {
      draft.lifecycle = "running";
      draft.items.push({
        id: event.eventId,
        message: "Isolated workspace sandbox container ready.",
        sequence: event.sequence,
        status: "sandbox_allocated",
        timestamp: event.occurredAt,
        type: "lifecycle_notice",
      });
      break;
    }

    case "run.completed": {
      draft.lifecycle = "completed";
      draft.terminalReason =
        typeof payload.reason === "string"
          ? payload.reason
          : "Run completed successfully.";
      draft.items.push({
        id: event.eventId,
        message: draft.terminalReason,
        sequence: event.sequence,
        status: "completed",
        timestamp: event.occurredAt,
        type: "lifecycle_notice",
      });
      break;
    }

    case "run.failed": {
      draft.lifecycle = "failed";
      draft.terminalReason = resolveFailureReason(payload);
      draft.items.push({
        id: event.eventId,
        message: draft.terminalReason,
        sequence: event.sequence,
        status: "failed",
        timestamp: event.occurredAt,
        type: "lifecycle_notice",
      });
      break;
    }

    case "run.cancelled": {
      draft.lifecycle = "cancelled";
      draft.terminalReason = "Run cancelled by user.";
      draft.items.push({
        id: event.eventId,
        message: draft.terminalReason,
        sequence: event.sequence,
        status: "cancelled",
        timestamp: event.occurredAt,
        type: "lifecycle_notice",
      });
      break;
    }

    default:
      break;
  }
}

function handleAgentProgressMessage(
  draft: DraftState,
  event: RunEventEnvelope,
  payload: Record<string, unknown>
): void {
  const text = typeof payload.text === "string" ? payload.text : "";
  const role = payload.role === "user" ? "user" : "assistant";
  const messageId = String(payload.messageId ?? event.eventId);

  const chatMsg: ChatMessageItem = {
    id: messageId,
    role,
    sequence: event.sequence,
    text,
    timestamp: event.occurredAt,
    type: "chat_message",
  };
  draft.messages.push(chatMsg);
  draft.items.push(chatMsg);
}

function handleToolStart(
  draft: DraftState,
  event: RunEventEnvelope,
  payload: Record<string, unknown>
): void {
  const toolCallId = String(payload.toolCallId ?? event.eventId);
  const toolName = String(payload.toolName ?? "tool");
  const args = (payload.args ?? {}) as Record<string, unknown>;

  const toolItem: ToolExecutionItem = {
    args,
    id: toolCallId,
    sequence: event.sequence,
    status: "running",
    timestamp: event.occurredAt,
    toolName,
    type: "tool_execution",
  };
  draft.toolCalls[toolCallId] = toolItem;
  draft.items.push(toolItem);
}

function handleToolEnd(
  draft: DraftState,
  payload: Record<string, unknown>
): void {
  const toolCallId = String(payload.toolCallId ?? "");
  const existing = draft.toolCalls[toolCallId];
  if (!existing) {
    return;
  }

  const isError = payload.isError === true;
  const denied = payload.denied === true;
  const updated: ToolExecutionItem = {
    ...existing,
    isError,
    result: payload.result,
    status: resolveToolStatus(denied, isError),
  };
  draft.toolCalls[toolCallId] = updated;
  const idx = draft.items.findIndex((it) => it.id === toolCallId);
  if (idx !== -1) {
    draft.items[idx] = updated;
  }
}

function handleCommandExit(
  draft: DraftState,
  payload: Record<string, unknown>
): void {
  const toolCallId = String(payload.toolCallId ?? "");
  const existing = draft.toolCalls[toolCallId];
  if (!existing) {
    return;
  }

  const exitCode =
    typeof payload.exitCode === "number" ? payload.exitCode : undefined;
  const updated: ToolExecutionItem = {
    ...existing,
    exitCode,
    status: exitCode === 0 ? "completed" : "failed",
  };
  draft.toolCalls[toolCallId] = updated;
  const idx = draft.items.findIndex((it) => it.id === toolCallId);
  if (idx !== -1) {
    draft.items[idx] = updated;
  }
}

function handleAgentProgressTool(
  draft: DraftState,
  event: RunEventEnvelope,
  payload: Record<string, unknown>,
  kind: string | undefined
): void {
  if (kind === "tool_start") {
    handleToolStart(draft, event, payload);
    return;
  }
  if (kind === "tool_end") {
    handleToolEnd(draft, payload);
    return;
  }
  if (kind === "command_exit") {
    handleCommandExit(draft, payload);
  }
}

function handleAgentProgressSubagent(
  draft: DraftState,
  event: RunEventEnvelope,
  payload: Record<string, unknown>,
  kind: string | undefined
): void {
  if (kind === "subagent_start") {
    const toolCallId = String(payload.toolCallId ?? event.eventId);
    const subagentItem: SubagentDelegationItem = {
      agentType: String(payload.agentType ?? "worker"),
      id: toolCallId,
      modelId:
        typeof payload.modelId === "string" ? payload.modelId : undefined,
      sequence: event.sequence,
      status: "running",
      task: String(payload.task ?? "Delegated sub-task"),
      timestamp: event.occurredAt,
      type: "subagent_delegation",
    };
    draft.subagents[toolCallId] = subagentItem;
    draft.items.push(subagentItem);
    return;
  }

  if (kind === "subagent_end") {
    const toolCallId = String(payload.toolCallId ?? "");
    const existing = draft.subagents[toolCallId];
    if (existing) {
      const updated: SubagentDelegationItem = {
        ...existing,
        durationMs:
          typeof payload.durationMs === "number"
            ? payload.durationMs
            : undefined,
        result: payload.result,
        status: payload.isError === true ? "failed" : "completed",
      };
      draft.subagents[toolCallId] = updated;
      const idx = draft.items.findIndex((it) => it.id === toolCallId);
      if (idx !== -1) {
        draft.items[idx] = updated;
      }
    }
  }
}

function handleAgentEvent(
  draft: DraftState,
  event: RunEventEnvelope,
  payload: Record<string, unknown>,
  kind: string | undefined
): void {
  if (event.type === "agent.started") {
    draft.lifecycle = "running";
    if (kind === "subagent_start") {
      handleAgentProgressSubagent(draft, event, payload, kind);
    }
    return;
  }

  if (event.type === "agent.progress") {
    if (draft.lifecycle === "queued") {
      draft.lifecycle = "running";
    }

    if (kind === "message_end") {
      handleAgentProgressMessage(draft, event, payload);
    } else if (
      kind === "tool_start" ||
      kind === "tool_end" ||
      kind === "command_exit"
    ) {
      handleAgentProgressTool(draft, event, payload, kind);
    } else if (kind === "subagent_end") {
      handleAgentProgressSubagent(draft, event, payload, kind);
    }
  }
}

function handleApprovalEvent(
  draft: DraftState,
  event: RunEventEnvelope,
  payload: Record<string, unknown>
): void {
  if (event.type === "approval.requested") {
    draft.lifecycle = "awaiting_approval";
    const toolCallId = String(payload.toolCallId ?? event.eventId);
    const approvalItem: ApprovalGateItem = {
      args: (payload.args ?? {}) as Record<string, unknown>,
      id: event.eventId,
      resumeSchema: payload.resumeSchema,
      sequence: event.sequence,
      status: "pending",
      suspendPayload: payload.suspendPayload,
      timestamp: event.occurredAt,
      toolCallId,
      toolName: String(payload.toolName ?? "Requested Action"),
      type: "approval_gate",
    };
    draft.activeApproval = approvalItem;
    draft.items.push(approvalItem);
    return;
  }

  if (event.type === "approval.resolved") {
    if (draft.lifecycle === "awaiting_approval") {
      draft.lifecycle = "running";
    }
    draft.activeApproval = null;
    const toolCallId = String(payload.toolCallId ?? "");
    const idx = draft.items.findIndex(
      (it) =>
        it.type === "approval_gate" &&
        (it.toolCallId === toolCallId || it.id === event.eventId)
    );
    if (idx !== -1) {
      const existing = draft.items[idx] as ApprovalGateItem;
      draft.items[idx] = {
        ...existing,
        resolution: payload.resolution,
        status: payload.resolution === "cancelled" ? "cancelled" : "resolved",
      };
    }
  }
}

function handleTaskAndPreviewEvent(
  draft: DraftState,
  event: RunEventEnvelope,
  payload: Record<string, unknown>
): void {
  switch (event.type) {
    case "task.updated": {
      if (Array.isArray(payload.tasks)) {
        draft.tasks = payload.tasks.map((t: unknown) => {
          const taskObj = (t ?? {}) as Record<string, unknown>;
          return {
            id: String(taskObj.id ?? crypto.randomUUID()),
            status: (taskObj.status as TaskItem["status"]) ?? "in_progress",
            title: String(taskObj.title ?? taskObj.name ?? "Task"),
          };
        });
      }
      break;
    }

    case "verification.started":
    case "verification.passed":
    case "verification.failed": {
      draft.items.push({
        id: event.eventId,
        sequence: event.sequence,
        status: resolveVerificationStatus(event.type),
        summary:
          typeof payload.summary === "string" ? payload.summary : undefined,
        timestamp: event.occurredAt,
        type: "verification",
      });
      break;
    }

    case "artifact.recorded": {
      draft.items.push({
        artifactId:
          typeof payload.artifactId === "string"
            ? payload.artifactId
            : undefined,
        id: event.eventId,
        kind: typeof payload.kind === "string" ? payload.kind : undefined,
        sequence: event.sequence,
        timestamp: event.occurredAt,
        type: "artifact_recorded",
      });
      break;
    }

    case "preview.ready": {
      draft.items.push({
        id: event.eventId,
        kind: "preview",
        sequence: event.sequence,
        status: "ready",
        timestamp: event.occurredAt,
        type: "preview_deployment",
        url: typeof payload.url === "string" ? payload.url : undefined,
      });
      break;
    }

    case "deployment.started":
    case "deployment.ready":
    case "deployment.failed": {
      draft.items.push({
        id: event.eventId,
        kind: "deployment",
        sequence: event.sequence,
        status: resolveDeploymentStatus(event.type),
        timestamp: event.occurredAt,
        type: "preview_deployment",
        url: typeof payload.url === "string" ? payload.url : undefined,
      });
      break;
    }

    default:
      break;
  }
}

export function reduceConversationEvent(
  state: ConversationState,
  event: RunEventEnvelope
): ConversationState {
  // Enforce monotonicity
  if (event.sequence <= state.lastSequence && state.lastSequence > 0) {
    return state;
  }

  const nextSequence = Math.max(state.lastSequence, event.sequence);
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const kind = typeof payload.kind === "string" ? payload.kind : undefined;

  const draft: DraftState = {
    activeApproval: state.activeApproval,
    items: [...state.items],
    lifecycle: state.lifecycle,
    messages: [...state.messages],
    subagents: { ...state.subagents },
    tasks: [...state.tasks],
    terminalReason: state.terminalReason,
    toolCalls: { ...state.toolCalls },
  };

  handleLifecycleEvent(draft, event, payload);
  handleAgentEvent(draft, event, payload, kind);
  handleApprovalEvent(draft, event, payload);
  handleTaskAndPreviewEvent(draft, event, payload);

  return {
    activeApproval: draft.activeApproval,
    items: draft.items,
    lastSequence: nextSequence,
    lifecycle: draft.lifecycle,
    messages: draft.messages,
    subagents: draft.subagents,
    tasks: draft.tasks,
    terminalReason: draft.terminalReason,
    toolCalls: draft.toolCalls,
  };
}
