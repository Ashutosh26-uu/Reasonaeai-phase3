import type {
  AgentControllerEvent,
  Session,
} from "@mastra/core/agent-controller";

const ARG_LIMIT = 300;
const RESULT_LIMIT = 600;
const TASK_LIMIT = 240;

function shorten(value: string, limit: number): string {
  return value.length > limit
    ? `${value.slice(0, limit)}… (+${value.length - limit} chars)`
    : value;
}

function stringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Reads the message off an error without dumping its stack. A provider error
 * reaching this harness is an `Error`, a serialized `Error`-shaped object, or an
 * arbitrary value; only the first two carry a usable message.
 */
function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (
    error !== null &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return shorten(stringify(error), RESULT_LIMIT);
}

/**
 * Summarizes one message of a rejected request without echoing its content. A
 * provider rejection is only actionable when the message list that produced it
 * is visible: an assistant turn looks identical whether its reasoning survived
 * conversion or was dropped.
 */
function describeMessage(message: unknown, index: number): string {
  if (message === null || typeof message !== "object") {
    return `  [${index}] <unreadable>`;
  }
  const role = "role" in message ? String(message.role) : "?";
  if (role !== "assistant") {
    return `  [${index}] ${role}`;
  }
  const toolCalls =
    "tool_calls" in message && Array.isArray(message.tool_calls)
      ? message.tool_calls.length
      : 0;
  const reasoning =
    "reasoning_content" in message &&
    typeof message.reasoning_content === "string"
      ? `present (${message.reasoning_content.length} chars)`
      : "ABSENT";
  return `  [${index}] assistant tool_calls=${toolCalls} reasoning_content=${reasoning}`;
}

/** Walks the cause chain for the request body a provider call was built from. */
function findRejectedMessages(error: unknown): unknown[] | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current === null || typeof current !== "object") {
      return;
    }
    if (
      "requestBodyValues" in current &&
      current.requestBodyValues !== null &&
      typeof current.requestBodyValues === "object" &&
      "messages" in current.requestBodyValues &&
      Array.isArray(current.requestBodyValues.messages)
    ) {
      return current.requestBodyValues.messages;
    }
    current = "cause" in current ? current.cause : undefined;
  }
}

export interface FailureReport {
  message: string;
  /** Shape of the rejected request, when the failure carries one. */
  shape?: string;
}

export function describeFailure(error: unknown): FailureReport {
  const message = messageOf(error);
  const messages = findRejectedMessages(error);
  if (!messages) {
    return { message };
  }
  return { message, shape: messages.map(describeMessage).join("\n") };
}

/** The assistant text carried by a streamed or persisted message. */
function textOf(message: unknown): string {
  if (
    message === null ||
    typeof message !== "object" ||
    !("content" in message)
  ) {
    return "";
  }
  const { content } = message;
  if (typeof content === "string") {
    return content;
  }
  if (
    content === null ||
    typeof content !== "object" ||
    !("parts" in content) ||
    !Array.isArray(content.parts)
  ) {
    return "";
  }
  let text = "";
  for (const part of content.parts) {
    if (
      part !== null &&
      typeof part === "object" &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string"
    ) {
      text += part.text;
    }
  }
  return text;
}

type MessageEvent = Extract<
  AgentControllerEvent,
  { type: "message_start" | "message_update" | "message_end" }
>;
type ToolEvent = Extract<
  AgentControllerEvent,
  {
    type:
      | "command_exit"
      | "shell_output"
      | "tool_end"
      | "tool_input_delta"
      | "tool_input_start"
      | "tool_start";
  }
>;
type WorkerEvent = Extract<
  AgentControllerEvent,
  {
    type:
      | "subagent_end"
      | "subagent_start"
      | "subagent_text_delta"
      | "subagent_tool_end"
      | "subagent_tool_start";
  }
>;
type RunEvent = Extract<
  AgentControllerEvent,
  { type: "agent_end" | "error" | "info" }
>;

interface RenderState {
  endReason?: string;
  error?: string;
  /** Characters of the streaming message already written. */
  streamedLength: number;
  /** Id of the message currently streaming; a new id restarts the count. */
  streamedMessageId?: string;
  text: string;
  toolCalls: number;
  workers: number;
  write: (text: string) => void;
}

/**
 * Writes only the text not yet written, so a message that arrives repeatedly
 * while it streams produces each delta exactly once.
 */
function renderMessage(state: RenderState, event: MessageEvent): void {
  if (event.type === "message_end" && textOf(event.message) === "") {
    return;
  }
  const messageId =
    "id" in event.message ? String(event.message.id) : "current";
  const full = textOf(event.message);
  if (messageId !== state.streamedMessageId) {
    state.streamedMessageId = messageId;
    state.streamedLength = 0;
  }
  if (full.length > state.streamedLength) {
    state.write(full.slice(state.streamedLength));
    state.text += full.slice(state.streamedLength);
    state.streamedLength = full.length;
  }
  if (event.type === "message_end") {
    state.write("\n");
  }
}

/** How a finished tool call resolved, distinguishing a refusal from a failure. */
function outcomeOf(event: { denied?: boolean; isError: boolean }): string {
  if (event.denied === true) {
    return "denied";
  }
  return event.isError ? "failed" : "returned";
}

function renderTool(state: RenderState, event: ToolEvent): void {
  switch (event.type) {
    case "tool_input_start": {
      state.write(`\n[tool] ${event.toolName} `);
      break;
    }
    case "tool_input_delta": {
      state.write(
        shorten(
          typeof event.argsTextDelta === "string"
            ? event.argsTextDelta
            : stringify(event.argsTextDelta),
          ARG_LIMIT
        )
      );
      break;
    }
    case "tool_start": {
      state.toolCalls += 1;
      state.write(
        `\n[tool] ${event.toolName} ${shorten(stringify(event.args), ARG_LIMIT)}\n`
      );
      break;
    }
    case "shell_output": {
      const prefix = event.stream === "stderr" ? "  ! " : "  | ";
      const body = event.output
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => prefix + line)
        .join("\n");
      if (body !== "") {
        state.write(`${body}\n`);
      }
      break;
    }
    case "command_exit": {
      state.write(`  -> exit ${event.exitCode}\n`);
      break;
    }
    default: {
      state.write(
        `[tool] ${outcomeOf(event)} ${shorten(
          stringify(event.result),
          RESULT_LIMIT
        )}\n`
      );
      break;
    }
  }
}

function renderWorker(state: RenderState, event: WorkerEvent): void {
  switch (event.type) {
    case "subagent_start": {
      state.workers += 1;
      state.write(
        `\n[worker] ${event.agentType} (${event.modelId}) ${shorten(
          event.task,
          TASK_LIMIT
        )}\n`
      );
      break;
    }
    case "subagent_text_delta": {
      state.write(`  ${event.textDelta}\n`);
      break;
    }
    case "subagent_tool_start": {
      state.write(
        `  [worker tool] ${event.subToolName} ${shorten(
          stringify(event.subToolArgs),
          ARG_LIMIT
        )}\n`
      );
      break;
    }
    case "subagent_tool_end": {
      state.write(
        `  [worker tool] ${event.subToolName} ${outcomeOf(event)} ${shorten(
          stringify(event.subToolResult),
          RESULT_LIMIT
        )}\n`
      );
      break;
    }
    default: {
      state.write(
        `[worker] ${event.agentType} ${outcomeOf(event)} in ${
          event.durationMs
        }ms: ${shorten(event.result, RESULT_LIMIT)}\n`
      );
      break;
    }
  }
}

function renderRunEvent(state: RenderState, event: RunEvent): void {
  switch (event.type) {
    case "agent_end": {
      state.endReason = event.reason ?? "complete";
      break;
    }
    case "info": {
      state.write(`[info] ${event.message}\n`);
      break;
    }
    default: {
      const failure = describeFailure(event.error);
      state.error ??= failure.message;
      const retry =
        event.retryable === true
          ? ` (retryable, attempt ${event.retryAttempt ?? "?"})`
          : "";
      state.write(`\n[error] ${failure.message}${retry}\n`);
      if (failure.shape) {
        state.write(`Rejected request shape:\n${failure.shape}\n`);
      }
      break;
    }
  }
}

function renderEvent(state: RenderState, event: AgentControllerEvent): void {
  switch (event.type) {
    case "message_end":
    case "message_start":
    case "message_update": {
      renderMessage(state, event);
      break;
    }
    case "command_exit":
    case "shell_output":
    case "tool_end":
    case "tool_input_delta":
    case "tool_input_start":
    case "tool_start": {
      renderTool(state, event);
      break;
    }
    case "subagent_end":
    case "subagent_start":
    case "subagent_text_delta":
    case "subagent_tool_end":
    case "subagent_tool_start": {
      renderWorker(state, event);
      break;
    }
    case "agent_end":
    case "error":
    case "info": {
      renderRunEvent(state, event);
      break;
    }
    default: {
      break;
    }
  }
}

export interface RunReport {
  /** Terminal reason the controller reported, when the run ended. */
  endReason?: string;
  /** First reported run error, when the run failed instead of finishing. */
  error?: string;
  /** The assistant's own text, accumulated across every step. */
  text: string;
  toolCalls: number;
  workers: number;
}

/**
 * Renders a driven controller session to the terminal.
 *
 * The session is the unit that holds the delegation tool, the mode, the thread,
 * and the approval gates, so subscribing to it is what makes a run's real work
 * visible: tool arguments while they stream, live shell output and exit codes,
 * and each worker's own text and tool calls as the worker performs them.
 */
export async function reportControllerRun(
  session: Session,
  input: {
    content: string;
    requestContext: Parameters<Session["sendMessage"]>[0]["requestContext"];
  },
  write: (text: string) => void
): Promise<RunReport> {
  const started = Date.now();
  const state: RenderState = {
    streamedLength: 0,
    text: "",
    toolCalls: 0,
    workers: 0,
    write,
  };

  const unsubscribe = session.subscribe((event) => renderEvent(state, event));
  try {
    await session.sendMessage({
      content: input.content,
      requestContext: input.requestContext,
      untilIdle: true,
    });
  } catch (error) {
    state.error ??= describeFailure(error).message;
    write(`\n[error] ${state.error}\n`);
  } finally {
    unsubscribe();
  }

  const ended =
    state.endReason === undefined ? "" : `, ended ${state.endReason}`;
  write(
    `\n[done: ${state.toolCalls} tool call(s), ${
      state.workers
    } worker(s), ${((Date.now() - started) / 1000).toFixed(1)}s${ended}]\n`
  );

  return {
    endReason: state.endReason,
    error: state.error,
    text: state.text,
    toolCalls: state.toolCalls,
    workers: state.workers,
  };
}
