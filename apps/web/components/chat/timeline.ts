import type { ConversationMessage } from "@reasonateai/contracts/execution";
import {
  type MessageSnapshot,
  MessageSnapshotSchema,
  type PlanProposal,
  PlanProposalSchema,
  type RunEventEnvelope,
  type RunLiveEvent,
} from "@reasonateai/contracts/execution-protocol";
import { isTurnEnd } from "./turn-presentation";

interface RunTimeline {
  events: Record<number, RunEventEnvelope>;
  live: Record<string, MessageSnapshot>;
  workers: Record<string, string>;
}
export interface Timeline {
  runs: Record<string, RunTimeline>;
  sawLiveText: boolean;
}
export const EMPTY_TIMELINE: Timeline = { runs: {}, sawLiveText: false };
const emptyRun = (): RunTimeline => ({ events: {}, live: {}, workers: {} });

/** Reconcile the active history without scheduling updates for unchanged input. */
export function reconcileHistory(
  timeline: Timeline,
  events: RunEventEnvelope[],
  pendingRunId?: string | null
): Timeline {
  const retained = new Set<string>(events.map((event) => event.runId));
  if (pendingRunId) {
    retained.add(pendingRunId);
  }
  const entries = Object.entries(timeline.runs);
  const active = entries.filter(([runId]) => retained.has(runId));
  const base =
    active.length === entries.length
      ? timeline
      : { ...timeline, runs: Object.fromEntries(active) };
  return events.reduce(foldDurable, base);
}

function questionText(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return;
  }
  const { question } = value as Record<string, unknown>;
  return typeof question === "string" ? question : undefined;
}

export function pendingQuestion(
  timeline: Timeline,
  runId: string
): { question: string; toolCallId: string } | undefined {
  const events = Object.values(timeline.runs[runId]?.events ?? {}).sort(
    (a, b) => a.sequence - b.sequence
  );
  let pending: { question: string; toolCallId: string } | undefined;
  for (const event of events) {
    const { payload } = event;
    if (
      event.type === "approval.requested" &&
      payload.kind === "tool_suspended" &&
      payload.toolName === "ask_user" &&
      typeof payload.toolCallId === "string"
    ) {
      pending = {
        question:
          questionText(payload.suspendPayload) ??
          questionText(payload.args) ??
          "What would you like the CTO to do?",
        toolCallId: payload.toolCallId,
      };
    }
    if (
      event.type === "approval.resolved" &&
      payload.toolCallId === pending?.toolCallId
    ) {
      pending = undefined;
    }
    if (isTurnEnd(event)) {
      pending = undefined;
    }
  }
  return pending;
}

export interface PendingPlan {
  plan: PlanProposal;
  toolCallId: string;
}

export function pendingPlan(
  timeline: Timeline,
  runId: string
): PendingPlan | undefined {
  const events = Object.values(timeline.runs[runId]?.events ?? {}).sort(
    (a, b) => a.sequence - b.sequence
  );
  let pending: PendingPlan | undefined;
  for (const event of events) {
    const { payload } = event;
    const isPlanProposed =
      (event.type === "run.plan_proposed" ||
        (event.type === "approval.requested" &&
          payload.toolName === "submit_plan") ||
        (payload.kind === "tool_suspended" &&
          payload.toolName === "submit_plan")) &&
      typeof payload.toolCallId === "string";
    if (isPlanProposed) {
      const rawPlan = payload.plan ?? payload.suspendPayload ?? payload.args;
      const parsed = PlanProposalSchema.safeParse(rawPlan);
      if (parsed.success) {
        pending = {
          plan: parsed.data,
          toolCallId: String(payload.toolCallId),
        };
      }
    }
    if (
      (event.type === "run.plan_decided" ||
        event.type === "approval.resolved" ||
        payload.kind === "answer_submitted") &&
      (!payload.toolCallId || payload.toolCallId === pending?.toolCallId)
    ) {
      pending = undefined;
    }
    if (isTurnEnd(event)) {
      pending = undefined;
    }
  }
  return pending;
}

export function foldDurable(
  timeline: Timeline,
  event: RunEventEnvelope
): Timeline {
  const run = timeline.runs[event.runId] ?? emptyRun();
  if (run.events[event.sequence]) {
    return timeline;
  }
  return {
    ...timeline,
    runs: {
      ...timeline.runs,
      [event.runId]: {
        ...run,
        events: { ...run.events, [event.sequence]: event },
      },
    },
  };
}

export function foldLive(timeline: Timeline, event: RunLiveEvent): Timeline {
  const run = timeline.runs[event.runId] ?? emptyRun();
  if (event.kind === "message.snapshot") {
    const previous = run.live[event.snapshot.messageId];
    if (previous && previous.revision >= event.snapshot.revision) {
      return timeline;
    }
    return {
      runs: {
        ...timeline.runs,
        [event.runId]: {
          ...run,
          live: { ...run.live, [event.snapshot.messageId]: event.snapshot },
        },
      },
      sawLiveText: true,
    };
  }
  if (event.kind === "subagent.delta") {
    return {
      runs: {
        ...timeline.runs,
        [event.runId]: {
          ...run,
          workers: {
            ...run.workers,
            [event.toolCallId]: (
              (run.workers[event.toolCallId] ?? "") + event.delta
            ).slice(-32_000),
          },
        },
      },
      sawLiveText: true,
    };
  }
  // Legacy workers still provide completed text through message_end.
  return timeline;
}

export type ToolState =
  | "input-available"
  | "output-available"
  | "output-error"
  | "output-denied"
  | "approval-requested";
export interface ToolEntry {
  children: ToolEntry[];
  endedAt: string | null;
  error?: string;
  id: string;
  input: unknown;
  name: string;
  output: unknown;
  startedAt: string;
  state: ToolState;
  text: string;
}
export type TranscriptEntry =
  | {
      id: string;
      kind: "text" | "reasoning";
      text: string;
      streaming: boolean;
      sourceMessageId?: string;
      duration?: number;
      legacy?: boolean;
    }
  | { id: string; kind: "tool"; tool: ToolEntry }
  | {
      id: string;
      kind: "steering";
      active: boolean;
      text: string;
      status: "requested" | "delivered" | "failed";
      reason?: string;
    }
  | {
      id: string;
      kind: "plan";
      plan: PlanProposal;
      toolCallId: string;
      resolved?:
        | {
            approved: boolean;
            cancelled?: boolean;
            feedback?: string | undefined;
          }
        | undefined;
    };
export interface TranscriptTurn {
  entries: TranscriptEntry[];
  id: string;
  user?: ConversationMessage;
}

/** Legacy worker completions omit outcome; controller agent ends are progress. */
export function latestCompletedTurn(
  timeline: Timeline,
  messages: ConversationMessage[]
): TranscriptTurn | undefined {
  const turn = projectTranscript(timeline, messages).at(-1);
  if (!turn) {
    return;
  }
  const events = Object.values(timeline.runs[turn.id]?.events ?? {}).sort(
    (a, b) => a.sequence - b.sequence
  );
  const outcome = events.findLast(
    (event) => terminal(event) && event.payload.kind !== "agent_end"
  );
  if (
    outcome?.type === "run.completed" &&
    (outcome.payload.outcome === undefined ||
      outcome.payload.outcome === "succeeded")
  ) {
    return turn;
  }
}
const string = (value: unknown): string =>
  typeof value === "string" ? value : "";
const terminal = isTurnEnd;

function newTool(
  id: string,
  name: string,
  input: unknown,
  at: string
): ToolEntry {
  return {
    children: [],
    endedAt: null,
    id,
    input,
    name,
    output: undefined,
    startedAt: at,
    state: "input-available",
    text: "",
  };
}
function finishTool(
  tool: ToolEntry,
  event: RunEventEnvelope,
  output: unknown
): void {
  tool.output = output;
  tool.endedAt = event.occurredAt;
  tool.state =
    event.payload.isError === true ? "output-error" : "output-available";
  if (event.payload.denied === true) {
    tool.state = "output-denied";
  }
  if (tool.state === "output-error") {
    tool.error =
      typeof output === "string"
        ? output
        : "The tool failed. See its result for details.";
  }
}
function updateTool(tool: ToolEntry, event: RunEventEnvelope): void {
  const p = event.payload;
  switch (p.kind) {
    case "tool_end":
    case "subagent_end":
      finishTool(tool, event, p.result);
      break;
    case "tool_approval_required":
    case "tool_suspended":
      tool.state = "approval-requested";
      tool.output = p.suspendPayload ?? "Waiting for your response.";
      break;
    case "tool_suspension_cancelled":
      tool.state = "output-denied";
      tool.endedAt = event.occurredAt;
      tool.output = p.reason;
      break;
    case "answer_submitted":
      tool.state = "input-available";
      tool.output = "Answer sent.";
      break;
    case "subagent_tool_start":
      tool.children.push(
        newTool(
          `${tool.id}:${event.sequence}`,
          string(p.subToolName),
          p.subToolArgs,
          event.occurredAt
        )
      );
      break;
    case "subagent_tool_end": {
      const child = tool.children.find(
        (item) => item.name === p.subToolName && item.endedAt === null
      );
      if (child) {
        finishTool(child, event, p.subToolResult);
      }
      break;
    }
    default:
      break;
  }
}
function sealTools(
  tools: Map<string, ToolEntry>,
  ended: RunEventEnvelope | undefined
): void {
  if (!ended) {
    return;
  }
  for (const tool of tools.values()) {
    for (const item of [tool, ...tool.children]) {
      if (item.state === "approval-requested") {
        item.state = "output-denied";
        item.output = "The run ended before this request was resolved.";
        item.endedAt = ended.occurredAt;
        continue;
      }
      if (item.state !== "input-available") {
        continue;
      }
      item.state = "output-error";
      item.error = "The run ended before this tool's result was recorded.";
      item.endedAt = ended.occurredAt;
    }
  }
}
function toolEntries(
  events: RunEventEnvelope[],
  run: RunTimeline
): Map<string, ToolEntry> {
  const tools = new Map<string, ToolEntry>();
  for (const event of events) {
    const p = event.payload;
    const id = string(p.toolCallId);
    if (!id) {
      continue;
    }
    if (p.kind === "tool_start" || p.kind === "subagent_start") {
      const old = tools.get(id);
      const next = newTool(
        id,
        string(p.toolName) || string(p.agentType) || "Tool",
        p.args ?? p.task,
        old?.startedAt ?? event.occurredAt
      );
      next.children = old?.children ?? [];
      next.text = run.workers[id] ?? "";
      tools.set(id, next);
    }
    const tool = tools.get(id);
    if (tool) {
      updateTool(tool, event);
    }
  }
  sealTools(tools, events.findLast(terminal));
  return tools;
}

function runMessages(events: RunEventEnvelope[], run: RunTimeline) {
  const messages = new Map<
    string,
    { snapshot: MessageSnapshot; sequence: number }
  >();
  for (const event of events) {
    const parsed = MessageSnapshotSchema.safeParse(event.payload.snapshot);
    if (!parsed.success) {
      continue;
    }
    const old = messages.get(parsed.data.messageId);
    if (!old || parsed.data.revision > old.snapshot.revision) {
      messages.set(parsed.data.messageId, {
        sequence:
          old?.sequence ??
          parsed.data.recovery?.sourceSequence ??
          event.sequence,
        snapshot: parsed.data,
      });
    }
  }
  // A live frame cannot invent a ledger position. Wait for its first snapshot.
  for (const [id, item] of messages) {
    const live = run.live[id];
    if (
      live &&
      live.revision > item.snapshot.revision &&
      !item.snapshot.finished
    ) {
      item.snapshot = live;
    }
  }
  return messages;
}

type SnapshotPart = MessageSnapshot["parts"][number];

function toolPartEntry(
  runId: string,
  part: Extract<SnapshotPart, { type: "tool" }>,
  tools: Map<string, ToolEntry>
): TranscriptEntry | undefined {
  const tool = tools.get(part.toolCallId);
  if (!tool) {
    return;
  }
  if (tool.name === "submit_plan") {
    const parsed = PlanProposalSchema.safeParse(tool.input);
    if (parsed.success) {
      return {
        id: `${runId}:plan:${part.toolCallId}`,
        kind: "plan",
        plan: parsed.data,
        toolCallId: part.toolCallId,
      };
    }
  }
  return {
    id: `${runId}:tool:${part.toolCallId}`,
    kind: "tool",
    tool,
  };
}

function textPartEntry(
  runId: string,
  snapshot: MessageSnapshot,
  part: Exclude<SnapshotPart, { type: "tool" }>,
  ended: boolean
): TranscriptEntry {
  return {
    id: `${runId}:${snapshot.messageId}:${part.index}`,
    kind: part.type,
    sourceMessageId: snapshot.messageId,
    streaming: !(ended || snapshot.finished) && part.endedAt === null,
    text: part.text,
    ...(part.endedAt && !snapshot.recovery
      ? {
          duration: Math.max(
            0,
            (Date.parse(part.endedAt) - Date.parse(part.startedAt)) / 1000
          ),
        }
      : {}),
  };
}

function messageEntries(
  runId: string,
  snapshot: MessageSnapshot,
  tools: Map<string, ToolEntry>,
  ended: boolean
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const part of snapshot.parts) {
    if (part.type === "tool") {
      const entry = toolPartEntry(runId, part, tools);
      if (entry) {
        entries.push(entry);
      }
    } else {
      entries.push(textPartEntry(runId, snapshot, part, ended));
    }
  }
  return entries;
}

/** One projection is used for initial history, streaming, and replay. */
function steeringEntry(
  event: RunEventEnvelope,
  events: RunEventEnvelope[]
): TranscriptEntry | undefined {
  if (
    !(
      event.type === "run.steering.requested" &&
      typeof event.payload.message === "string" &&
      typeof event.payload.steeringId === "string"
    )
  ) {
    return;
  }
  const outcome = events.findLast(
    (candidate) =>
      candidate.payload.steeringId === event.payload.steeringId &&
      ["run.steering.delivered", "run.steering.failed"].includes(candidate.type)
  );
  const status =
    outcome?.type === "run.steering.delivered" ? "delivered" : "requested";
  return {
    active: !events.some(terminal),
    id: `${event.runId}:steering:${event.payload.steeringId}`,
    kind: "steering",
    status: outcome?.type === "run.steering.failed" ? "failed" : status,
    text: event.payload.message,
    ...(typeof outcome?.payload.reason === "string"
      ? { reason: outcome.payload.reason }
      : {}),
  };
}

function findPlanDecision(
  events: RunEventEnvelope[],
  planToolCallId: string
):
  | { approved: boolean; cancelled?: boolean; feedback?: string | undefined }
  | undefined {
  const decisionEvent = events.findLast(
    (e) =>
      e.type === "run.plan_decided" &&
      typeof e.payload.approved === "boolean" &&
      e.payload.toolCallId === planToolCallId
  );
  if (!decisionEvent) {
    const cancelled = events.some(
      (e) =>
        ((e.type === "run.cancelled" || e.type === "run.failed") &&
          isTurnEnd(e)) ||
        (e.type === "approval.resolved" &&
          e.payload.toolCallId === planToolCallId &&
          e.payload.resolution === "cancelled")
    );
    return cancelled ? { approved: false, cancelled: true } : undefined;
  }
  return {
    approved: decisionEvent.payload.approved === true,
    feedback:
      typeof decisionEvent.payload.feedback === "string"
        ? decisionEvent.payload.feedback
        : undefined,
  };
}

function extractPlanProposalEntry(
  runId: string,
  event: RunEventEnvelope,
  events: RunEventEnvelope[]
): { entry: TranscriptEntry; toolCallId: string } | undefined {
  const isPlanProposed =
    (event.type === "run.plan_proposed" ||
      (event.type === "approval.requested" &&
        event.payload.toolName === "submit_plan") ||
      (event.payload.kind === "tool_suspended" &&
        event.payload.toolName === "submit_plan")) &&
    typeof event.payload.toolCallId === "string";
  if (!isPlanProposed) {
    return;
  }
  const planToolCallId = string(event.payload.toolCallId);
  const rawPlan =
    event.payload.plan ?? event.payload.suspendPayload ?? event.payload.args;
  const parsed = PlanProposalSchema.safeParse(rawPlan);
  if (!parsed.success) {
    return;
  }
  const resolved = findPlanDecision(events, planToolCallId);
  return {
    entry: {
      id: `${runId}:plan:${planToolCallId}`,
      kind: "plan",
      plan: parsed.data,
      resolved,
      toolCallId: planToolCallId,
    },
    toolCallId: planToolCallId,
  };
}

function resolvePendingPlans(
  ordered: { sequence: number; entries: TranscriptEntry[] }[],
  events: RunEventEnvelope[]
): void {
  for (const item of ordered) {
    for (const entry of item.entries) {
      if (entry.kind === "plan" && !entry.resolved) {
        entry.resolved = findPlanDecision(events, entry.toolCallId);
      }
    }
  }
}

function collectEventEntries(
  runId: string,
  events: RunEventEnvelope[],
  tools: Map<string, ToolEntry>,
  ownedTools: Set<string>,
  messages: Map<string, { sequence: number; snapshot: MessageSnapshot }>
): { sequence: number; entries: TranscriptEntry[] }[] {
  const result: { sequence: number; entries: TranscriptEntry[] }[] = [];
  const seenTools = new Set<string>();

  for (const event of events) {
    const steering = steeringEntry(event, events);
    if (steering) {
      result.push({ entries: [steering], sequence: event.sequence });
    }

    const planItem = extractPlanProposalEntry(runId, event, events);
    if (
      planItem &&
      !ownedTools.has(planItem.toolCallId) &&
      !seenTools.has(planItem.toolCallId)
    ) {
      seenTools.add(planItem.toolCallId);
      result.push({ entries: [planItem.entry], sequence: event.sequence });
    }

    const id = string(event.payload.toolCallId);
    const tool = tools.get(id);
    if (
      tool &&
      tool.name !== "submit_plan" &&
      !ownedTools.has(id) &&
      !seenTools.has(id)
    ) {
      seenTools.add(id);
      result.push({
        entries: [{ id: `${runId}:tool:${id}`, kind: "tool", tool }],
        sequence: event.sequence,
      });
    }

    if (
      event.payload.kind === "message_end" &&
      event.payload.role === "assistant" &&
      !messages.has(string(event.payload.messageId))
    ) {
      const text = string(event.payload.text);
      if (text) {
        result.push({
          entries: [
            {
              id: `${runId}:${event.eventId}`,
              kind: "text",
              legacy: true,
              sourceMessageId: string(event.payload.messageId),
              streaming: false,
              text,
            },
          ],
          sequence: event.sequence,
        });
      }
    }
  }

  return result;
}

function projectRun(runId: string, run: RunTimeline): TranscriptEntry[] {
  const events = Object.values(run.events).sort(
    (a, b) => a.sequence - b.sequence
  );
  const ended = events.some(terminal);
  const tools = toolEntries(events, run);
  const messages = runMessages(events, run);
  const ownedTools = new Set(
    [...messages.values()].flatMap(({ snapshot }) =>
      snapshot.parts.flatMap((part) =>
        part.type === "tool" ? [part.toolCallId] : []
      )
    )
  );
  const ordered: { sequence: number; entries: TranscriptEntry[] }[] = [];
  for (const { snapshot, sequence } of messages.values()) {
    const entries = messageEntries(runId, snapshot, tools, ended);
    ordered.push({ entries, sequence });
  }

  ordered.push(
    ...collectEventEntries(runId, events, tools, ownedTools, messages)
  );

  resolvePendingPlans(ordered, events);

  return ordered
    .sort((a, b) => a.sequence - b.sequence)
    .flatMap((item) => item.entries);
}

export function projectTranscript(
  timeline: Timeline,
  messages: ConversationMessage[]
): TranscriptTurn[] {
  const turns = new Map<string, TranscriptTurn>();
  for (const message of messages) {
    const runId =
      message.runId ?? (message.role === "user" ? message.id : undefined);
    if (message.role === "user" && runId) {
      turns.set(runId, { entries: [], id: runId, user: message });
    }
  }
  for (const [id, run] of Object.entries(timeline.runs)) {
    turns.set(id, { ...turns.get(id), entries: projectRun(id, run), id });
  }
  return [...turns.values()];
}
