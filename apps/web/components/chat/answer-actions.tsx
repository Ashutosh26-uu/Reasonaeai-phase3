"use client";
import { Check, Copy, GitBranch, ThumbsDown, ThumbsUp } from "lucide-react";
import { useCallback, useState } from "react";
import {
  MessageAction,
  MessageActions,
} from "@/components/ai-elements/message";

export type AnswerFeedback = "positive" | "negative" | null;
export function AnswerActions({
  text,
  createdAt,
  feedback,
  disabled,
  onBranch,
  onFeedback,
}: {
  text: string;
  createdAt?: string | undefined;
  disabled: boolean;
  feedback: AnswerFeedback;
  onBranch?: (() => Promise<void>) | undefined;
  onFeedback?: ((value: AnswerFeedback) => Promise<void>) | undefined;
}) {
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setError("");
    } catch {
      setError("Could not copy. Select the answer and copy it manually.");
    }
  }, [text]);
  const act = useCallback(
    async (operation: (() => Promise<void>) | undefined) => {
      if (!operation) {
        return;
      }
      setSaving(true);
      setError("");
      try {
        await operation();
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not save this action. Try again."
        );
      } finally {
        setSaving(false);
      }
    },
    []
  );
  const positive = useCallback(
    () =>
      act(
        onFeedback
          ? () => onFeedback(feedback === "positive" ? null : "positive")
          : undefined
      ),
    [act, feedback, onFeedback]
  );
  const negative = useCallback(
    () =>
      act(
        onFeedback
          ? () => onFeedback(feedback === "negative" ? null : "negative")
          : undefined
      ),
    [act, feedback, onFeedback]
  );
  const branch = useCallback(() => act(onBranch), [act, onBranch]);
  return (
    <>
      <MessageActions
        aria-label="Answer actions"
        className="message-actions answer-actions"
      >
        <MessageAction
          className="message-action"
          label={copied ? "Copied" : "Copy answer"}
          onClick={copy}
          tooltip={copied ? "Copied" : "Copy answer"}
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </MessageAction>
        <MessageAction
          aria-pressed={feedback === "positive"}
          className="message-action"
          disabled={disabled || saving || !onFeedback}
          label="Good response"
          onClick={positive}
          tooltip="Good response"
        >
          <ThumbsUp size={16} />
        </MessageAction>
        <MessageAction
          aria-pressed={feedback === "negative"}
          className="message-action"
          disabled={disabled || saving || !onFeedback}
          label="Poor response"
          onClick={negative}
          tooltip="Poor response"
        >
          <ThumbsDown size={16} />
        </MessageAction>
        <MessageAction
          className="message-action"
          disabled={disabled || saving || !onBranch}
          label="Branch in new conversation"
          onClick={branch}
          tooltip="Branch in new conversation"
        >
          <GitBranch size={16} />
        </MessageAction>
        {createdAt && (
          <time
            className="answer-time"
            dateTime={createdAt}
            title={new Date(createdAt).toLocaleString()}
          >
            {new Intl.DateTimeFormat(undefined, {
              hour: "numeric",
              minute: "2-digit",
            }).format(new Date(createdAt))}
          </time>
        )}
        {saving && (
          <span className="sr-only" role="status">
            Saving…
          </span>
        )}
      </MessageActions>
      {error && (
        <p className="message-action-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
