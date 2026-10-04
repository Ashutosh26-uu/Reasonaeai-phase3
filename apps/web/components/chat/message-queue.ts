import type { PromptAttachment } from "@reasonateai/contracts/execution";

export const MAX_QUEUED_MESSAGES = 10;
const MAX_QUEUE_BYTES = 24 * 1024 * 1024;

export interface PromptSubmissionInput {
  attachments: PromptAttachment[];
  message: string;
  preserveDraft?: boolean;
  requestId?: string;
  targetRunId?: string;
}

export type QueueDeliveryIntent =
  | { kind: "turn" }
  | { kind: "side-chat" }
  | { kind: "steer"; targetRunId: string };

export interface QueuedMessage {
  attachments: PromptAttachment[];
  delivery?: QueueDeliveryIntent;
  id: string;
  message: string;
  projectId: string;
  scopeKey: string;
}

/** Bind before the network call: a lost response cannot change the endpoint on retry. */
export function bindQueuedDelivery(
  message: QueuedMessage,
  targetRunId: string | null,
  sideChat = false
): QueuedMessage {
  if (message.delivery) {
    if (sideChat && message.delivery.kind !== "side-chat") {
      throw new Error(
        "Retry this message's original delivery, or edit it to start a new request."
      );
    }
    return message;
  }
  if (sideChat) {
    return { ...message, delivery: { kind: "side-chat" } };
  }
  if (targetRunId) {
    return { ...message, delivery: { kind: "steer", targetRunId } };
  }
  return { ...message, delivery: { kind: "turn" } };
}

export function mayAutomaticallyDeliver(message: QueuedMessage) {
  return !message.delivery || message.delivery.kind === "turn";
}

/** Queue admission is bounded across chats, including retained attachment data. */
export function appendQueuedMessage(
  queue: QueuedMessage[],
  message: QueuedMessage
): QueuedMessage[] {
  if (!message.projectId) {
    throw new Error("Choose a project before queuing a message.");
  }
  if (!(message.message.trim() || message.attachments.length)) {
    throw new Error("Write a message or attach a file to queue.");
  }
  if (queue.length >= MAX_QUEUED_MESSAGES) {
    throw new Error(`Queue up to ${MAX_QUEUED_MESSAGES} messages.`);
  }
  const next = [...queue, message];
  const bytes = next.reduce(
    (total, item) =>
      total +
      item.message.length * 2 +
      item.attachments.reduce(
        (size, attachment) => size + attachment.data.length * 2,
        0
      ),
    0
  );
  if (bytes > MAX_QUEUE_BYTES) {
    throw new Error(
      "Queued files are too large. Send or remove a queued message first."
    );
  }
  return next;
}

export function removeQueuedMessage(queue: QueuedMessage[], id: string) {
  return queue.filter((message) => message.id !== id);
}

/** Acknowledgement removes only its own row; later submissions retain their IDs. */
export function queuedSubmission(
  message: QueuedMessage
): PromptSubmissionInput {
  const input: PromptSubmissionInput = {
    attachments: message.attachments,
    message: message.message,
    preserveDraft: true,
    requestId: message.id,
  };
  if (message.delivery?.kind === "steer") {
    input.targetRunId = message.delivery.targetRunId;
  }
  return input;
}
