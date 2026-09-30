import type { RunEventEnvelope } from "@reasonateai/contracts/execution-protocol";

/**
 * What one run did, as the conversation shows it while the run happens.
 *
 * The durable ledger is a sequence of transitions, and a person watching wants
 * the structure behind them: which worker was delegated what, which tool call
 * is still open, and what each one returned. Each item is one tool call or one
 * delegated worker, and a worker's own tool calls hang under it.
 */
/**
 * The state a tool call or a delegated worker is in, in the vocabulary the AI
 * Elements tool surface uses: a call whose arguments have arrived is available,
 * its result makes it output-available, and a call parked at an approval gate is
 * what the reader has to act on.
 */
export type ActivityStatus =
  | "approval-requested"
  | "input-available"
  | "output-available"
  | "output-error";

export interface ActivityItem {
  children: ActivityItem[];
  /** The argument worth reading: a command, a path, or the delegated task. */
  detail: string;
  /** The tool call or delegation this item is, as the controller named it. */
  id: string;
  kind: "subagent" | "tool";
  /** What it returned, once it did. */
  result: string;
  status: ActivityStatus;
  /** Text the worker streamed while it ran. */
  text: string;
  title: string;
}

export interface Activity {
  items: ActivityItem[];
  /** The run these items describe, or null when nothing has happened yet. */
  runId: string | null;
}

export const EMPTY_ACTIVITY: Activity = { items: [], runId: null };

/** Detail text stays one readable line. */
const MAX_DETAIL = 140;
const MAX_RESULT = 240;

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The one field of a tool's arguments a reader recognises, in the order that
 * makes a row say what the call is about rather than dumping the whole object.
 */
const ARGUMENT_KEYS = [
  "command",
  "path",
  "filePath",
  "query",
  "pattern",
  "url",
  "prompt",
  "task",
  "glob",
];

function describeArgs(args: unknown): string {
  const record = readRecord(args);
  for (const key of ARGUMENT_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return truncate(value.replaceAll(/\s+/g, " ").trim(), MAX_DETAIL);
    }
  }
  const keys = Object.keys(record);
  return keys.length === 0 ? "" : keys.join(", ");
}

/** What a tool returned, reduced to the line a reader needs. */
function describeResult(result: unknown, isError: boolean): string {
  if (typeof result === "string") {
    return truncate(result.replaceAll(/\s+/g, " ").trim(), MAX_RESULT);
  }
  const record = readRecord(result);
  const stdout = record.stdout ?? record.output ?? record.content;
  if (typeof stdout === "string" && stdout.trim().length > 0) {
    const [first = ""] = stdout.trim().split("\n");
    return truncate(first.trim(), MAX_RESULT);
  }
  const message = record.message ?? record.error ?? record.reason;
  if (typeof message === "string" && message.length > 0) {
    return truncate(message.replaceAll(/\s+/g, " ").trim(), MAX_RESULT);
  }
  return isError ? "Failed." : "";
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function newItem(input: {
  detail?: string;
  id: string;
  kind: ActivityItem["kind"];
  title: string;
}): ActivityItem {
  return {
    children: [],
    detail: input.detail ?? "",
    id: input.id,
    kind: input.kind,
    result: "",
    status: "input-available",
    text: "",
    title: input.title,
  };
}

/** Replaces the item with this id, or adds it when it is new. */
function upsert(
  items: ActivityItem[],
  id: string,
  change: (item: ActivityItem) => ActivityItem
): ActivityItem[] {
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) {
    return items;
  }
  const next = [...items];
  next[index] = change(items[index] as ActivityItem);
  return next;
}

/**
 * Closes one child of a worker: the last open call with the name the result was
 * reported under, or the newest open call when the event named none. A worker
 * may hold several calls to one tool, and only the last of them is the one a
 * result can belong to.
 */
function closeChild(
  items: ActivityItem[],
  parentId: string,
  subToolName: string,
  change: (item: ActivityItem) => ActivityItem
): ActivityItem[] {
  return upsert(items, parentId, (parent) => {
    const index = parent.children.findLastIndex(
      (child) =>
        child.status === "input-available" &&
        (subToolName.length === 0 || child.title === subToolName)
    );
    if (index === -1) {
      return parent;
    }
    const children = [...parent.children];
    children[index] = change(parent.children[index] as ActivityItem);
    return { ...parent, children };
  });
}

/**
 * One durable event, folded into the run's structure.
 *
 * A new run starts a new structure, because a ledger's events belong to the run
 * that produced them and mixing two would attribute one run's tool calls to
 * another. Events that describe nothing a reader can see change nothing.
 */
export function foldDurable(
  activity: Activity,
  event: RunEventEnvelope
): Activity {
  const sameRun = activity.runId === event.runId;
  const items = sameRun ? activity.items : [];
  const kind = readString(event.payload.kind);
  const toolCallId = readString(event.payload.toolCallId);

  switch (kind) {
    case "tool_start": {
      const title = readString(event.payload.toolName) || "tool";
      return {
        items: [
          ...items,
          newItem({
            detail: describeArgs(event.payload.args),
            id: toolCallId,
            kind: "tool",
            title,
          }),
        ],
        runId: event.runId,
      };
    }

    case "tool_end": {
      const isError = event.payload.isError === true;
      const denied = event.payload.denied === true;
      return {
        items: upsert(items, toolCallId, (item) => ({
          ...item,
          result: denied
            ? "Not run: approval was declined."
            : describeResult(event.payload.result, isError),
          status: isError ? "output-error" : "output-available",
        })),
        runId: event.runId,
      };
    }

    // A delegation arrives as a tool call first and then as the worker it
    // spawned, so the row that said "agent" becomes the worker it delegated to.
    case "subagent_start": {
      const delegation = newItem({
        detail: readString(event.payload.task),
        id: toolCallId,
        kind: "subagent",
        title: readString(event.payload.agentType) || "worker",
      });
      const existing = items.find((item) => item.id === toolCallId);
      if (existing === undefined) {
        return { items: [...items, delegation], runId: event.runId };
      }
      return {
        items: upsert(items, toolCallId, () => delegation),
        runId: event.runId,
      };
    }

    case "subagent_tool_start": {
      const child = newItem({
        detail: describeArgs(event.payload.subToolArgs),
        id: `${toolCallId}:${readString(event.payload.subToolName)}:${items.find((item) => item.id === toolCallId)?.children.length ?? 0}`,
        kind: "tool",
        title: readString(event.payload.subToolName) || "tool",
      });
      return {
        items: upsert(items, toolCallId, (item) => ({
          ...item,
          children: [...item.children, child],
        })),
        runId: event.runId,
      };
    }

    case "subagent_tool_end": {
      const isError = event.payload.isError === true;
      return {
        items: closeChild(
          items,
          toolCallId,
          readString(event.payload.subToolName),
          (child) => ({
            ...child,
            result: describeResult(event.payload.subToolResult, isError),
            status: isError ? "output-error" : "output-available",
          })
        ),
        runId: event.runId,
      };
    }

    case "subagent_end": {
      const isError = event.payload.isError === true;
      return {
        items: upsert(items, toolCallId, (item) => ({
          ...item,
          result: describeResult(event.payload.result, isError),
          status: isError ? "output-error" : "output-available",
        })),
        runId: event.runId,
      };
    }

    // A call that needs a person to decide before it runs. The row is the only
    // place the request is visible, so it carries the arguments the decision is
    // about rather than a bare "approval needed".
    case "tool_approval_required":
    case "tool_suspended": {
      const title = readString(event.payload.toolName) || "tool";
      const approval = newItem({
        detail: describeArgs(event.payload.args),
        id: toolCallId,
        kind: "tool",
        title,
      });
      const withApproval: ActivityItem = {
        ...approval,
        result: "Waiting for your approval.",
        status: "approval-requested",
      };
      return {
        items: upsert(items, toolCallId, () => withApproval),
        runId: event.runId,
      };
    }

    default: {
      return sameRun ? activity : { items, runId: event.runId };
    }
  }
}

/**
 * One live frame, folded in: the text a delegated worker is writing right now.
 *
 * A worker's text is the only live frame with structure to attach to, and a
 * frame for a worker this structure does not hold is dropped rather than
 * invented — the durable events are what say a worker exists.
 */
export function foldLive(
  activity: Activity,
  event: { delta: string; kind: string; toolCallId?: string }
): Activity {
  if (event.kind !== "subagent.delta" || event.toolCallId === undefined) {
    return activity;
  }
  return {
    items: upsert(activity.items, event.toolCallId, (item) => ({
      ...item,
      text: truncate(item.text + event.delta, MAX_RESULT),
    })),
    runId: activity.runId,
  };
}
