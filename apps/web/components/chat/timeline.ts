import type { ConversationMessage } from "@reasonateai/contracts/execution";
import {
  type MessageSnapshot,
  MessageSnapshotSchema,
  type RunEventEnvelope,
  type RunLiveEvent,
} from "@reasonateai/contracts/execution-protocol";

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
      duration?: number;
      legacy?: boolean;
    }
  | { id: string; kind: "tool"; tool: ToolEntry };
export interface TranscriptTurn {
  entries: TranscriptEntry[];
  id: string;
  user?: ConversationMessage;
}
const string = (value: unknown): string =>
  typeof value === "string" ? value : "";
const terminal = (event: RunEventEnvelope) =>
  ["run.completed", "run.failed", "run.cancelled"].includes(event.type);

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

function messageEntries(
  runId: string,
  snapshot: MessageSnapshot,
  tools: Map<string, ToolEntry>,
  ended: boolean
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const part of snapshot.parts) {
    if (part.type === "tool") {
      const tool = tools.get(part.toolCallId);
      if (tool) {
        entries.push({
          id: `${runId}:tool:${part.toolCallId}`,
          kind: "tool",
          tool,
        });
      }
    } else {
      entries.push({
        id: `${runId}:${snapshot.messageId}:${part.index}`,
        kind: part.type,
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
      });
    }
  }
  return entries;
}

/** One projection is used for initial history, streaming, and replay. */
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
  const seenTools = new Set<string>();
  for (const event of events) {
    const id = string(event.payload.toolCallId);
    const tool = tools.get(id);
    if (tool && !ownedTools.has(id) && !seenTools.has(id)) {
      seenTools.add(id);
      ordered.push({
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
        ordered.push({
          entries: [
            {
              id: `${runId}:${event.eventId}`,
              kind: "text",
              legacy: true,
              streaming: false,
              text,
            },
          ],
          sequence: event.sequence,
        });
      }
    }
  }
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
