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
  Layers3,
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
import { ActivityOutline } from "./activity";
import {
  projectTranscript,
  type Timeline,
  type TranscriptEntry,
} from "./timeline";

export interface TranscriptProps {
  live: boolean;
  messages: ConversationMessage[];
  onEdit: (text: string) => void;
  onRetry: (text: string) => void;
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
}: {
  onRetry: (text: string) => void;
  text: string;
}) {
  const retry = useCallback(() => onRetry(text), [onRetry, text]);
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

function Entry({ entry }: { entry: TranscriptEntry }) {
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

function renderEntries(entries: TranscriptEntry[]): ReactNode[] {
  const rendered: ReactNode[] = [];
  for (let index = 0; index < entries.length; ) {
    const entry = entries[index];
    if (!entry) {
      index += 1;
      continue;
    }
    if (entry.kind !== "tool") {
      rendered.push(<Entry entry={entry} key={entry.id} />);
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
      rendered.push(<Entry entry={entry} key={entry.id} />);
    } else {
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
          <CollapsibleTrigger className="transcript-tool-group-trigger">
            <Layers3 aria-hidden="true" size={15} />
            <span>{group.length} tool calls</span>
            <ChevronDown
              aria-hidden="true"
              className="transcript-tool-group-chevron"
              size={15}
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="transcript-tool-group-content">
            {group.map((toolEntry) => (
              <Entry entry={toolEntry} key={toolEntry.id} />
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
  messages,
  onEdit,
  onRetry,
  pending,
  timeline,
}: TranscriptProps) {
  const turns = useMemo(
    () => projectTranscript(timeline, messages),
    [timeline, messages]
  );
  return (
    <Conversation className="transcript">
      <ConversationContent className="transcript-inner">
        {turns.map((turn) => {
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
                <Message className="msg" from="user">
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
              {renderEntries(turn.entries)}
              {answer && (
                <MessageActions>
                  <CopyAction text={answer} />
                  {!pending && turn.user && (
                    <RetryAction onRetry={onRetry} text={turn.user.text} />
                  )}
                </MessageActions>
              )}
            </section>
          );
        })}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}
