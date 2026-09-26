/**
 * Reduces any thrown value to a bounded, loggable description.
 *
 * A run's failure has to reach the ledger and the logs without carrying a model
 * prompt, a tool result, or a provider request body with it, so only the error's
 * name and message survive, the message is capped, and its line structure is
 * flattened so one failure is one log line.
 */

const MAX_MESSAGE_LENGTH = 500;

export interface FailureDescription {
  message: string;
  name: string;
}

/** Reads the message off an error without dumping its stack. */
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
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error) ?? "Unknown failure";
  } catch {
    return "Unknown failure";
  }
}

export function describeFailure(error: unknown): FailureDescription {
  const message = messageOf(error).replaceAll(/\s+/g, " ").trim();
  return {
    message:
      message.length > MAX_MESSAGE_LENGTH
        ? `${message.slice(0, MAX_MESSAGE_LENGTH)}…`
        : message,
    name: error instanceof Error && error.name !== "" ? error.name : "Error",
  };
}
