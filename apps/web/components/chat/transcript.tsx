"use client";

import type { ConversationMessage } from "@reasonateai/contracts/execution";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@reasonateai/ui/components/collapsible";
import {
  Check,
  ChevronDown,
  Clock3,
  Copy,
  Link2,
  Pencil,
  RotateCcw,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Attachments } from "@/components/ai-elements/attachments";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { ActivityOutline, actionIcon } from "./activity";
import { AnswerActions, type AnswerFeedback } from "./answer-actions";
import { CheckpointCard } from "./checkpoint-card";
import { type CheckpointScope, turnCheckpoint } from "./checkpoint-state";
import { MessageMinimap } from "./message-minimap";
import { messageAnchor, messageNavigationItems } from "./message-navigation";
import { PlanCard } from "./plan-card";
import {
  projectTranscript,
  type Timeline,
  type TranscriptEntry,
} from "./timeline";
import { toolGroupSummary } from "./tool-group-summary";

export interface TranscriptProps {
  checkpointScope?: CheckpointScope | undefined;
  live: boolean;
  messages: ConversationMessage[];
  onApprovePlan?: ((toolCallId: string) => void) | undefined;
  onBranch?: ((runId: string) => Promise<void>) | undefined;
  onEdit: (text: string) => void;
  onFeedback?:
    | ((runId: string, value: AnswerFeedback) => Promise<void>)
    | undefined;
  onRejectPlan?: ((toolCallId: string, feedback: string) => void) | undefined;
  onRestore?: (() => void) | undefined;
  onRetry: (
    text: string,
    sourceRunId?: string,
    replace?: boolean
  ) => undefined | Promise<boolean>;
  pending: boolean;
  timeline: Timeline;
}
function UserMessageActions({
  createdAt,
  onEdit,
  text,
  sourceRunId,
  pending,
  onRetry,
}: {
  createdAt: string;
  onEdit: (text: string) => void;
  text: string;
  sourceRunId?: string | undefined;
  pending: boolean;
  onRetry: TranscriptProps["onRetry"];
}) {
  const [editing, setEditing] = useState(false);
  const [replacement, setReplacement] = useState(text);
  const editor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing) {
      editor.current?.focus();
    }
  }, [editing]);
  const updateReplacement = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) =>
      setReplacement(event.currentTarget.value),
    []
  );
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const copy = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setError("");
    } catch {
      setError("Could not copy. Select the text and copy it manually.");
    }
  }, []);
  const copyMessage = useCallback(async () => copy(text), [copy, text]);
  const copyLink = useCallback(async () => copy(window.location.href), [copy]);
  const reuseDraft = useCallback(() => {
    if (sourceRunId) {
      setReplacement(text);
      setEditing(true);
    } else {
      onEdit(text);
    }
  }, [onEdit, sourceRunId, text]);
  const retry = useCallback(
    () => onRetry(text, sourceRunId),
    [onRetry, sourceRunId, text]
  );
  const cancel = useCallback(() => setEditing(false), []);
  const save = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (replacement.trim()) {
        const accepted = await onRetry(replacement, sourceRunId, true);
        if (accepted !== false) {
          setEditing(false);
        }
      }
    },
    [onRetry, replacement, sourceRunId]
  );
  const timestamp = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(createdAt));

  return (
    <>
      <MessageActions className="message-actions msg-user-actions self-end">
        <MessageAction
          className="message-action"
          label={copied ? "Copied" : "Copy message"}
          onClick={copyMessage}
          tooltip={copied ? "Copied" : "Copy message"}
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </MessageAction>
        <MessageAction
          className="message-action"
          label="Copy conversation link"
          onClick={copyLink}
          tooltip="Copy conversation link"
        >
          <Link2 size={16} />
        </MessageAction>
        <MessageAction
          className="message-action"
          disabled={pending}
          label="Edit and resend"
          onClick={reuseDraft}
          tooltip="Edit and resend"
        >
          <Pencil size={16} />
        </MessageAction>
        {sourceRunId && (
          <MessageAction
            className="message-action"
            disabled={pending}
            label="Retry request"
            onClick={retry}
            tooltip="Retry request"
          >
            <RotateCcw size={16} />
          </MessageAction>
        )}
        <span className="msg-user-time">
          <Clock3 aria-hidden="true" size={14} />
          <time dateTime={createdAt}>{timestamp}</time>
        </span>
      </MessageActions>
      {editing && (
        <form className="message-edit" onSubmit={save}>
          <label className="sr-only" htmlFor={`edit-${sourceRunId}`}>
            Edit request
          </label>
          <textarea
            id={`edit-${sourceRunId}`}
            onChange={updateReplacement}
            ref={editor}
            rows={3}
            value={replacement}
          />
          <p>
            Resending replaces this turn and later history, and restores the
            files from before this turn.
          </p>
          <div className="message-edit-actions">
            <button onClick={cancel} type="button">
              Cancel
            </button>
            <button disabled={pending || !replacement.trim()} type="submit">
              Save and resend
            </button>
          </div>
        </form>
      )}
      {error && (
        <span className="sr-only" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

function Entry({
  entry,
  onApprovePlan,
  onRejectPlan,
}: {
  entry: TranscriptEntry;
  onApprovePlan?: ((toolCallId: string) => void) | undefined;
  onRejectPlan?: ((toolCallId: string, feedback: string) => void) | undefined;
}) {
  if (entry.kind === "plan") {
    return (
      <PlanCard
        onApprove={
          onApprovePlan ? () => onApprovePlan(entry.toolCallId) : undefined
        }
        onReject={
          onRejectPlan
            ? (feedback) => onRejectPlan(entry.toolCallId, feedback)
            : undefined
        }
        plan={entry.plan}
        resolved={entry.resolved}
      />
    );
  }
  if (entry.kind === "steering") {
    const status =
      entry.status === "delivered"
        ? "Delivered to the active CTO"
        : "Waiting for the CTO’s next step";
    return (
      <Message
        className="msg"
        from="user"
        id={messageAnchor(entry.id)}
        tabIndex={-1}
      >
        <MessageContent className="msg-user-bubble">
          {(entry.active || entry.status !== "delivered") && (
            <p className="steering-label">
              Steering ·{" "}
              {entry.status === "failed" ? "Delivery unconfirmed" : status}
            </p>
          )}
          <p className="msg-user-text">{entry.text}</p>
          {entry.reason && (
            <p className="steering-label" role="status">
              {entry.reason}
            </p>
          )}
        </MessageContent>
      </Message>
    );
  }
  if (entry.kind === "tool") {
    return <ActivityOutline tool={entry.tool} />;
  }
  if (entry.kind === "reasoning") {
    return (
      <Reasoning
        {...(entry.duration === undefined ? {} : { duration: entry.duration })}
        isStreaming={entry.streaming}
      >
        <ReasoningTrigger />
        <ReasoningContent>{entry.text}</ReasoningContent>
      </Reasoning>
    );
  }
  return (
    <Message from="assistant">
      <MessageContent>
        <div className="msg-prose">
          <MessageResponse isAnimating={entry.streaming}>
            {entry.text}
          </MessageResponse>
          {entry.streaming && (
            <span aria-label="Writing" className="stream-caret" role="status" />
          )}
        </div>
      </MessageContent>
    </Message>
  );
}

function renderEntries(
  entries: TranscriptEntry[],
  onApprovePlan?: ((toolCallId: string) => void) | undefined,
  onRejectPlan?: ((toolCallId: string, feedback: string) => void) | undefined
): ReactNode[] {
  const rendered: ReactNode[] = [];
  for (let index = 0; index < entries.length; ) {
    const entry = entries[index];
    if (!entry) {
      index += 1;
      continue;
    }
    if (entry.kind !== "tool") {
      rendered.push(
        <Entry
          entry={entry}
          key={entry.id}
          onApprovePlan={onApprovePlan}
          onRejectPlan={onRejectPlan}
        />
      );
      index += 1;
      continue;
    }

    const group = [entry];
    while (entries[index + group.length]?.kind === "tool") {
      const next = entries[index + group.length];
      if (next?.kind === "tool") {
        group.push(next);
      }
    }
    if (group.length === 1) {
      rendered.push(
        <Entry
          entry={entry}
          key={entry.id}
          onApprovePlan={onApprovePlan}
          onRejectPlan={onRejectPlan}
        />
      );
    } else {
      const summary = toolGroupSummary(
        group.map((toolEntry) => toolEntry.tool)
      );
      const GroupIcon = actionIcon(summary.iconTool);
      const expanded = group.some(
        (toolEntry) =>
          toolEntry.tool.state === "input-available" ||
          toolEntry.tool.state === "approval-requested"
      );
      rendered.push(
        <Collapsible
          className="transcript-tool-group"
          defaultOpen={expanded}
          key={entry.id}
        >
          <CollapsibleTrigger
            className="transcript-tool-group-trigger"
            title={`${summary.count} tool calls`}
          >
            <GroupIcon aria-hidden="true" size={15} />
            <span>{summary.label}</span>
            <span className="sr-only">({summary.count} tool calls)</span>
            <ChevronDown
              aria-hidden="true"
              className="transcript-tool-group-chevron"
              size={15}
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="transcript-tool-group-content">
            {group.map((toolEntry) => (
              <Entry
                entry={toolEntry}
                key={toolEntry.id}
                onApprovePlan={onApprovePlan}
                onRejectPlan={onRejectPlan}
              />
            ))}
          </CollapsibleContent>
        </Collapsible>
      );
    }
    index += group.length;
  }
  return rendered;
}

export function Transcript({
  checkpointScope,
  messages,
  onApprovePlan,
  onEdit,
  onRejectPlan,
  onRestore,
  onRetry,
  onBranch,
  onFeedback,
  pending,
  timeline,
}: TranscriptProps) {
  const turns = useMemo(
    () => projectTranscript(timeline, messages),
    [timeline, messages]
  );
  const navigationItems = useMemo(() => messageNavigationItems(turns), [turns]);
  return (
    <Conversation className="transcript">
      <ConversationContent className="transcript-inner">
        {turns.map((turn) => {
          const interrupted = Object.values(
            timeline.runs[turn.id]?.events ?? {}
          ).some(
            (event) =>
              (event.type === "run.failed" || event.type === "run.cancelled") &&
              typeof event.payload.outcome === "string"
          );
          const checkpoint = turnCheckpoint(
            Object.values(timeline.runs[turn.id]?.events ?? {})
          );
          const answer = turn.entries
            .flatMap((entry) => (entry.kind === "text" ? [entry.text] : []))
            .join("\n\n");
          const completed = Object.values(
            timeline.runs[turn.id]?.events ?? {}
          ).some((event) => event.type === "run.completed");
          const savedAnswers = messages.filter(
            (message) =>
              message.runId === turn.id && message.role === "assistant"
          );
          const lastAnswer = savedAnswers.at(-1);
          const terminal = Object.values(
            timeline.runs[turn.id]?.events ?? {}
          ).find((event) => event.type === "run.completed");
          return (
            <section
              aria-label="Conversation turn"
              className="transcript-turn"
              key={turn.id}
            >
              {turn.user && (
                <Message
                  className="msg"
                  from="user"
                  id={messageAnchor(turn.user.id)}
                  tabIndex={-1}
                >
                  <MessageContent className="msg-user-bubble">
                    {turn.user.attachments && (
                      <Attachments
                        items={turn.user.attachments.map(
                          (attachment, index) => ({
                            ...attachment,
                            id: `${index}:${attachment.filename}`,
                          })
                        )}
                      />
                    )}
                    {turn.user.text && (
                      <p className="msg-user-text">{turn.user.text}</p>
                    )}
                  </MessageContent>
                  <UserMessageActions
                    createdAt={turn.user.createdAt}
                    onEdit={onEdit}
                    onRetry={onRetry}
                    pending={pending}
                    sourceRunId={turn.user.runId}
                    text={turn.user.text}
                  />
                </Message>
              )}
              {renderEntries(turn.entries, onApprovePlan, onRejectPlan)}
              {(answer || interrupted) && (
                <TurnAnswerActions
                  createdAt={lastAnswer?.createdAt ?? terminal?.occurredAt}
                  disabled={pending || !completed}
                  feedback={lastAnswer?.feedback ?? null}
                  onBranch={onBranch}
                  onFeedback={onFeedback}
                  runId={turn.id}
                  text={answer}
                />
              )}
              {checkpoint && (
                <CheckpointCard
                  {...(checkpointScope === undefined
                    ? {}
                    : { scope: checkpointScope })}
                  key={`${turn.id}:${checkpoint.sequence}`}
                  onRestore={onRestore}
                  turn={checkpoint}
                />
              )}
            </section>
          );
        })}
      </ConversationContent>
      <MessageMinimap items={navigationItems} />
      <ConversationScrollButton />
    </Conversation>
  );
}

function TurnAnswerActions({
  runId,
  onBranch,
  onFeedback,
  ...props
}: {
  runId: string;
  onBranch: TranscriptProps["onBranch"];
  onFeedback: TranscriptProps["onFeedback"];
  createdAt: string | undefined;
  disabled: boolean;
  feedback: AnswerFeedback;
  text: string;
}) {
  const branch = useCallback(async () => {
    await onBranch?.(runId);
  }, [onBranch, runId]);
  const feedback = useCallback(
    async (value: AnswerFeedback) => {
      await onFeedback?.(runId, value);
    },
    [onFeedback, runId]
  );
  return (
    <AnswerActions
      {...props}
      onBranch={onBranch ? branch : undefined}
      onFeedback={onFeedback ? feedback : undefined}
    />
  );
}
