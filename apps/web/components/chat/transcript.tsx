"use client";

import type { ConversationMessage } from "@reasonateai/contracts/execution";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@reasonateai/ui/components/collapsible";
import {
  Brain,
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
import { Shimmer } from "@/components/ai-elements/shimmer";
import { ActivityOutline, actionIcon } from "./activity";
import { AnswerActions, type AnswerFeedback } from "./answer-actions";
import { CheckpointCard } from "./checkpoint-card";
import { type CheckpointScope, turnCheckpoint } from "./checkpoint-state";
import { MessageMinimap } from "./message-minimap";
import { messageAnchor, messageNavigationItems } from "./message-navigation";
import { MessageTime } from "./message-time";
import { PlanCard } from "./plan-card";
import {
  projectTranscript,
  type Timeline,
  type TranscriptEntry,
} from "./timeline";
import { toolGroupSummary } from "./tool-group-summary";
import {
  type ActivityEntry,
  isActivityEntry,
  turnPresentation,
} from "./turn-presentation";

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
          <MessageTime createdAt={createdAt} />
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

function ThinkingEntry({
  entry,
}: {
  entry: Extract<TranscriptEntry, { kind: "text" | "reasoning" }>;
}) {
  return (
    <Reasoning
      className="activity-item transcript-thinking"
      defaultOpen={false}
      {...(entry.duration === undefined ? {} : { duration: entry.duration })}
      isStreaming={entry.streaming}
    >
      <ReasoningTrigger className="activity-trigger">
        <span className="activity-icon">
          <Brain aria-hidden="true" size={16} />
        </span>
        <span className="activity-main">
          {entry.streaming ? "Thinking" : "Thought"}
        </span>
        {entry.duration !== undefined && (
          <span className="activity-duration">
            {Math.max(0, Math.round(entry.duration))}s
          </span>
        )}
        <ChevronDown
          aria-hidden="true"
          className="activity-chevron"
          size={16}
        />
      </ReasoningTrigger>
      <ReasoningContent className="transcript-thinking-content">
        {entry.text}
      </ReasoningContent>
    </Reasoning>
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
    return <ThinkingEntry entry={entry} />;
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
  const current = entries.findLast(
    (item) =>
      ((item.kind === "text" || item.kind === "reasoning") && item.streaming) ||
      (item.kind === "tool" && item.tool.state === "input-available")
  );
  for (let index = 0; index < entries.length; ) {
    const entry = entries[index];
    if (!entry) {
      index += 1;
      continue;
    }
    if (!isActivityEntry(entry)) {
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
    while (index + group.length < entries.length) {
      const next = entries[index + group.length];
      if (next && isActivityEntry(next)) {
        group.push(next);
      } else {
        break;
      }
    }
    rendered.push(
      <ActivityGroup currentId={current?.id} entries={group} key={entry.id} />
    );
    index += group.length;
  }
  return rendered;
}

function ActivityGroup({
  currentId,
  entries,
}: {
  currentId: string | undefined;
  entries: ActivityEntry[];
}) {
  const tools = entries.flatMap((entry) =>
    entry.kind === "tool" ? [entry.tool] : []
  );
  const thinking = entries.filter((entry) => entry.kind === "reasoning").length;
  const current = entries.find((entry) => entry.id === currentId);
  const summary = toolGroupSummary(
    current?.kind === "tool" ? [current.tool] : tools
  );
  let label = tools.length > 0 ? summary.label : "Thought";
  if (current?.kind === "reasoning") {
    label = "Thinking";
  }
  const Icon =
    current?.kind === "reasoning" || tools.length === 0
      ? Brain
      : actionIcon(summary.iconTool);
  const requiresApproval = tools.some(
    (tool) => tool.state === "approval-requested"
  );
  const [open, setOpen] = useState(requiresApproval);
  useEffect(() => {
    if (requiresApproval) {
      setOpen(true);
    }
  }, [requiresApproval]);
  const toolCount = `${tools.length} tool ${tools.length === 1 ? "call" : "calls"}`;
  const thinkingCount = `${thinking} thinking ${thinking === 1 ? "block" : "blocks"}`;
  const count = `${toolCount}, ${thinkingCount}`;
  return (
    <Collapsible
      className="transcript-tool-group"
      onOpenChange={setOpen}
      open={open}
    >
      <CollapsibleTrigger
        className="transcript-tool-group-trigger"
        title={count}
      >
        <Icon aria-hidden="true" size={15} />
        {current ? <Shimmer as="span">{label}</Shimmer> : <span>{label}</span>}
        <span className="sr-only">({count})</span>
        <ChevronDown
          aria-hidden="true"
          className="transcript-tool-group-chevron"
          size={15}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="transcript-tool-group-content">
        {entries.map((entry) => (
          <Entry entry={entry} key={entry.id} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
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
          const events = Object.values(timeline.runs[turn.id]?.events ?? {});
          const presentation = turnPresentation(turn.entries, events);
          const interrupted =
            presentation.end?.type === "run.failed" ||
            presentation.end?.type === "run.cancelled";
          const checkpoint = turnCheckpoint(
            Object.values(timeline.runs[turn.id]?.events ?? {})
          );
          const answer = presentation.answer?.text ?? "";
          const completed = presentation.end?.type === "run.completed";
          const savedAnswers = messages.filter(
            (message) =>
              message.runId === turn.id && message.role === "assistant"
          );
          const lastAnswer = savedAnswers.at(-1);
          const terminal = presentation.end;
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
              {presentation.end && (
                <Collapsible
                  className="transcript-turn-work"
                  defaultOpen={false}
                >
                  <CollapsibleTrigger className="transcript-tool-group-trigger">
                    <span>{presentation.label}</span>
                    {interrupted && (
                      <span className="transcript-work-outcome">
                        {terminal?.type === "run.failed"
                          ? "Failed"
                          : "Cancelled"}
                      </span>
                    )}
                    <ChevronDown
                      aria-hidden="true"
                      className="transcript-tool-group-chevron"
                      size={15}
                    />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="transcript-turn-work-content">
                    {renderEntries(
                      presentation.history,
                      onApprovePlan,
                      onRejectPlan
                    )}
                  </CollapsibleContent>
                </Collapsible>
              )}
              {renderEntries(presentation.visible, onApprovePlan, onRejectPlan)}
              {answer && (
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
