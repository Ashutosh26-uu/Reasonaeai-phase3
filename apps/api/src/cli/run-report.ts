import type { ChunkType } from "@mastra/core/stream";

const ARG_LIMIT = 300;
const RESULT_LIMIT = 600;

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

export interface RunReport {
  /** First reported run error, when the stream failed instead of finishing. */
  error?: string;
  /** The assistant's own text, accumulated across every step. */
  text: string;
  toolCalls: number;
}

/**
 * Renders a live agent run to the terminal.
 *
 * A non-streaming `generate()` call returns only the final text, so every tool
 * call, tool result, and reasoning step the CTO performs stays invisible until
 * the run ends. Consuming the run stream instead makes the hidden work visible
 * while it happens: step boundaries, what the model is thinking, which tool it
 * called with which arguments, and what that tool returned.
 */
export async function reportRun(
  chunks: AsyncIterable<ChunkType>,
  write: (text: string) => void
): Promise<RunReport> {
  const started = Date.now();
  let steps = 0;
  let toolCalls = 0;
  let thinking = false;
  let text = "";
  let error: string | undefined;

  const endThinking = () => {
    if (thinking) {
      write("\n");
      thinking = false;
    }
  };

  for await (const chunk of chunks) {
    switch (chunk.type) {
      case "step-start": {
        endThinking();
        steps += 1;
        write(`\n── step ${steps} ──\n`);
        break;
      }
      case "reasoning-delta": {
        if (!thinking) {
          write("[thinking] ");
          thinking = true;
        }
        write(chunk.payload.text);
        break;
      }
      case "reasoning-end": {
        endThinking();
        break;
      }
      case "text-delta": {
        endThinking();
        text += chunk.payload.text;
        write(chunk.payload.text);
        break;
      }
      case "tool-call": {
        endThinking();
        toolCalls += 1;
        write(
          `\n[tool] ${chunk.payload.toolName} ${shorten(
            stringify(chunk.payload.args),
            ARG_LIMIT
          )}\n`
        );
        break;
      }
      case "tool-result": {
        write(
          `[tool] ${chunk.payload.toolName} returned ${shorten(
            stringify(chunk.payload.result),
            RESULT_LIMIT
          )}\n`
        );
        break;
      }
      case "tool-error": {
        write(
          `[tool] ${chunk.payload.toolName} failed ${shorten(
            stringify(chunk.payload.error),
            RESULT_LIMIT
          )}\n`
        );
        break;
      }
      case "error": {
        endThinking();
        const failure = describeFailure(chunk.payload.error);
        error ??= failure.message;
        write(`[error] ${failure.message}\n`);
        if (failure.shape) {
          write(`Rejected request shape:\n${failure.shape}\n`);
        }
        break;
      }
      default: {
        break;
      }
    }
  }

  endThinking();
  write(
    `\n[done: ${steps} step(s), ${toolCalls} tool call(s), ${(
      (Date.now() - started) / 1000
    ).toFixed(1)}s]\n`
  );

  return error === undefined ? { text, toolCalls } : { error, text, toolCalls };
}
