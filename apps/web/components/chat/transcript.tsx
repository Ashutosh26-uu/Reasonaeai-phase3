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
import { useCallback, useMemo, useState } from "react";
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
  onEdit: (text: string) => void;
  onRejectPlan?: ((toolCallId: string, feedback: string) => void) | undefined;
  onRestore?: (() => void) | undefined;
  onRetry: (text: string, sourceRunId?: string) => void;
  pending: boolean;
  timeline: Timeline;
}
function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setError("");
    } catch {
      setError("Could not copy. Select the text and copy it manually.");
    }
  }, [text]);
  return (
    <>
      <MessageAction
        label={copied ? "Copied" : "Copy"}
        onClick={copy}
        tooltip={copied ? "Copied" : "Copy"}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </MessageAction>
      {error && <span role="alert">{error}</span>}
    </>
  );
}
function RetryAction({
  onRetry,
  text,
  sourceRunId,
}: {
  onRetry: (text: string, sourceRunId?: string) => void;
  text: string;
  sourceRunId?: string | undefined;
}) {
  const retry = useCallback(
    () => onRetry(text, sourceRunId),
    [sourceRunId, onRetry, text]
  );
  return (
    <MessageAction
      label="Retry request"
      onClick={retry}
      tooltip="Retry request"
    >
      <RotateCcw size={14} />
    </MessageAction>
  );
}

function UserMessageActions({
  createdAt,
  onEdit,
  text,
}: {
  createdAt: string;
  onEdit: (text: string) => void;
  text: string;
}) {
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
  const reuseDraft = useCallback(() => onEdit(text), [onEdit, text]);
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
          label="Reuse message as a draft"
          onClick={reuseDraft}
          tooltip="Reuse message as a draft"
        >
          <Pencil size={16} />
        </MessageAction>
        <span className="msg-user-time">
          <Clock3 aria-hidden="true" size={14} />
          <time dateTime={createdAt}>{timestamp}</time>
        </span>
      </MessageActions>
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
        {entry.legacy && (
          <p className="text-muted-foreground text-xs">
            This older response was saved without text/tool boundaries.
          </p>
        )}
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
                    text={turn.user.text}
                  />
                </Message>
              )}
              {renderEntries(turn.entries, onApprovePlan, onRejectPlan)}
              {(answer || interrupted) && (
                <MessageActions>
                  {answer && <CopyAction text={answer} />}
                  {!pending && interrupted && turn.user && (
                    <RetryAction
                      onRetry={onRetry}
                      sourceRunId={turn.user.runId}
                      text={turn.user.text}
                    />
                  )}
                </MessageActions>
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
