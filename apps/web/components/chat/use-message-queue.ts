"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  appendQueuedMessage,
  bindQueuedDelivery,
  mayAutomaticallyDeliver,
  type PromptSubmissionInput,
  type QueuedMessage,
  queuedSubmission,
  removeQueuedMessage,
} from "./message-queue";

interface QueueOptions {
  busy: boolean;
  onOpenSideChat:
    | ((input: PromptSubmissionInput) => Promise<boolean>)
    | undefined;
  onSteer: ((input: PromptSubmissionInput) => Promise<boolean>) | undefined;
  onSubmit: (input: PromptSubmissionInput) => Promise<boolean>;
  pending: boolean;
  pendingRunId: string | null;
  preventAutoQueueDispatch: boolean;
  projectId: string;
  scopeKey: string;
  stopping: boolean;
}

function delivery(options: QueueOptions, message: QueuedMessage) {
  if (message.delivery?.kind === "side-chat") {
    return options.onOpenSideChat;
  }
  if (message.delivery?.kind === "turn") {
    return options.onSubmit;
  }
  return message.attachments.length ? undefined : options.onSteer;
}

function matchesScope(message: QueuedMessage, options: QueueOptions) {
  return (
    message.projectId === options.projectId &&
    message.scopeKey === options.scopeKey
  );
}

function bindDelivery(
  message: QueuedMessage,
  options: QueueOptions,
  sideChat: boolean
) {
  if (
    options.pending &&
    !options.pendingRunId &&
    !message.delivery &&
    !sideChat
  ) {
    throw new Error("Wait for this run's identity before steering it.");
  }
  return bindQueuedDelivery(
    message,
    options.pending ? options.pendingRunId : null,
    sideChat
  );
}

/** Drafts stay in memory; a failed request never removes its queued row. */
export function useMessageQueue(options: QueueOptions) {
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const [queueing, setQueueing] = useState(true);
  const [paused, setPaused] = useState(false);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(
    null
  );
  const queueRef = useRef(queue);
  const sending = useRef<boolean>(false);
  const attempted = useRef<string | null>(null);
  const waitingForRun = useRef(false);
  const latest = useRef(options);
  latest.current = options;

  const replace = useCallback((messages: QueuedMessage[]) => {
    queueRef.current = messages;
    setQueue(messages);
  }, []);

  const enqueue = useCallback(
    (input: PromptSubmissionInput) => {
      const { current } = latest;
      const message: QueuedMessage = {
        attachments: input.attachments,
        id: crypto.randomUUID(),
        message: input.message.trim(),
        projectId: current.projectId,
        scopeKey: current.scopeKey,
      };
      replace(appendQueuedMessage(queueRef.current, message));
      return message.id;
    },
    [replace]
  );

  const remove = useCallback(
    (id: string) => {
      if (sending.current && sendingId === id) {
        return;
      }
      replace(removeQueuedMessage(queueRef.current, id));
      setError((current) => (current?.id === id ? null : current));
    },
    [replace, sendingId]
  );

  const edit = useCallback(
    (id: string, text: string) => {
      // Editing starts a new delivery identity; an acknowledged old request cannot
      // silently consume modified text on an idempotent retry.
      replace(
        queueRef.current.map((message) =>
          message.id === id
            ? {
                attachments: message.attachments,
                id: crypto.randomUUID(),
                message: text.trim(),
                projectId: message.projectId,
                scopeKey: message.scopeKey,
              }
            : message
        )
      );
      setError(null);
    },
    [replace]
  );

  const dispatch = useCallback(
    async (id: string, sideChat = false) => {
      const { current } = latest;
      const message = queueRef.current.find((item) => item.id === id);
      if (!message || sending.current || current.busy || current.stopping) {
        return;
      }
      if (!matchesScope(message, current)) {
        return;
      }
      sending.current = true;
      setSendingId(id);
      setError(null);
      try {
        const bound = bindDelivery(message, current, sideChat);
        const send = delivery(current, bound);
        if (!send) {
          throw new Error(
            "Attachments send as a follow-up when this run finishes. Text-only messages can steer the active run."
          );
        }
        replace(
          queueRef.current.map((item) => (item.id === id ? bound : item))
        );
        const accepted = await send(queuedSubmission(bound));
        if (!accepted) {
          throw new Error(
            "The message could not be delivered. It is still queued; try again."
          );
        }
        replace(removeQueuedMessage(queueRef.current, id));
        if (bound.delivery?.kind === "turn") {
          waitingForRun.current = true;
          setPaused(false);
        }
      } catch (cause) {
        setError({
          id,
          message:
            cause instanceof Error
              ? cause.message
              : "Could not send the queued message. Try again.",
        });
      } finally {
        sending.current = false;
        setSendingId(null);
      }
    },
    [replace]
  );

  const visible = queue.filter(
    (message) =>
      message.projectId === options.projectId &&
      message.scopeKey === options.scopeKey
  );
  const [first] = visible;
  useEffect(() => {
    if (options.pending) {
      waitingForRun.current = false;
    }
    if (
      !(first && mayAutomaticallyDeliver(first)) ||
      options.pending ||
      options.busy ||
      options.stopping ||
      options.preventAutoQueueDispatch ||
      !queueing ||
      paused ||
      sendingId ||
      waitingForRun.current ||
      attempted.current === first.id
    ) {
      return;
    }
    attempted.current = first.id;
    dispatch(first.id);
  }, [
    dispatch,
    first,
    options.busy,
    options.pending,
    options.preventAutoQueueDispatch,
    options.stopping,
    paused,
    queueing,
    sendingId,
  ]);

  return {
    dispatch,
    edit,
    enqueue,
    error,
    pause: useCallback(() => setPaused(true), []),
    paused: paused || options.preventAutoQueueDispatch || !queueing,
    queueing,
    remove,
    sendingId,
    toggleQueueing: useCallback(() => setQueueing((value) => !value), []),
    total: queue.length,
    visible,
  };
}
