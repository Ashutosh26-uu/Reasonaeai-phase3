"use client";

import { Badge } from "@reasonateai/ui/components/badge";
import { Button } from "@reasonateai/ui/components/button";
import { cn } from "@reasonateai/ui/lib/utils";
import type { UIMessage } from "ai";
import {
  Bot,
  CheckCircle2,
  ExternalLink,
  FileCheck,
  Layers,
  Sparkles,
} from "lucide-react";
import { useCallback, useMemo } from "react";
import { useRunEvents } from "../../hooks/use-run-events";
import type { ConversationTimelineItem } from "../../lib/conversation-state";
import {
  Conversation,
  ConversationContent,
  ConversationDownload,
  ConversationEmptyState,
  ConversationScrollButton,
} from "../ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "../ai-elements/message";
import { ApprovalPrompt } from "./approval-prompt";
import { ChatInputBar } from "./chat-input-bar";
import { ConnectionStatusBadge } from "./connection-status-badge";
import { SubagentBadge } from "./subagent-badge";
import { TaskProgressTree } from "./task-progress-tree";
import { ToolExecutionCard } from "./tool-execution-card";

export interface CtoConversationProps {
  baseUrl?: string | undefined;
  buildSessionId: string;
  className?: string | undefined;
  onResolveApproval?:
    | ((toolCallId: string, resolution: unknown) => Promise<void> | void)
    | undefined;
  onSendMessage?: ((text: string) => Promise<void> | void) | undefined;
  organizationId: string;
  projectId: string;
}

interface TimelineItemProps {
  item: ConversationTimelineItem;
  onResolveApproval: (
    toolCallId: string,
    resolution: unknown
  ) => Promise<void> | void;
}

function resolveVerificationStyle(status: string): string {
  if (status === "passed") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
  }
  if (status === "failed") {
    return "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400";
  }
  return "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400";
}

function resolvePlaceholder(lifecycle: string): string {
  if (lifecycle === "awaiting_approval") {
    return "Action approval is pending above...";
  }
  if (lifecycle === "completed") {
    return "This run has completed.";
  }
  return "Reply to the CTO or give instructions...";
}

function TimelineItemView({ item, onResolveApproval }: TimelineItemProps) {
  switch (item.type) {
    case "chat_message":
      return (
        <Message from={item.role}>
          <MessageContent>
            <MessageResponse>{item.text}</MessageResponse>
          </MessageContent>
        </Message>
      );

    case "tool_execution":
      return <ToolExecutionCard tool={item} />;

    case "subagent_delegation":
      return <SubagentBadge subagent={item} />;

    case "approval_gate":
      return <ApprovalPrompt approval={item} onResolve={onResolveApproval} />;

    case "verification":
      return (
        <div
          className={cn(
            "my-2 flex items-center gap-2 rounded-lg border p-3 text-xs",
            resolveVerificationStyle(item.status)
          )}
        >
          <FileCheck className="size-4 shrink-0" />
          <div>
            <strong>Verification {item.status}:</strong>{" "}
            {item.summary ?? "Defect-repair regression scenario checked."}
          </div>
        </div>
      );

    case "preview_deployment":
      return (
        <div className="my-2 flex items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs">
          <div className="flex items-center gap-2">
            <Layers className="size-4 text-primary" />
            <div>
              <strong>
                {item.kind === "preview"
                  ? "Sandbox Preview"
                  : "Release Deployment"}{" "}
                {item.status}
              </strong>
              {item.url && (
                <div className="font-mono text-muted-foreground">
                  {item.url}
                </div>
              )}
            </div>
          </div>
          {item.url && (
            <Button
              asChild
              className="h-7 gap-1 text-xs"
              size="sm"
              variant="outline"
            >
              <a href={item.url} rel="noreferrer" target="_blank">
                Open <ExternalLink className="size-3" />
              </a>
            </Button>
          )}
        </div>
      );

    case "artifact_recorded":
      return (
        <div className="my-1 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground opacity-80">
          <CheckCircle2 className="size-3 text-emerald-500" />
          <span>
            Artifact recorded: {item.artifactId ?? item.kind ?? "evidence file"}
          </span>
        </div>
      );

    case "lifecycle_notice":
      return (
        <div
          className={cn(
            "my-2 rounded-lg border p-2.5 text-center font-mono text-xs",
            item.status === "completed" &&
              "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
            item.status === "failed" &&
              "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400",
            item.status === "cancelled" &&
              "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
            (item.status === "queued" ||
              item.status === "claimed" ||
              item.status === "sandbox_allocated") &&
              "border-muted bg-muted/40 text-muted-foreground"
          )}
        >
          {item.message}
        </div>
      );

    default:
      return null;
  }
}

export function CtoConversation({
  buildSessionId,
  organizationId,
  projectId,
  baseUrl,
  className,
  onSendMessage,
  onResolveApproval,
}: CtoConversationProps) {
  const {
    conversation,
    connectionState,
    connectionDetail,
    reconnect,
    addUserMessage,
    resolveApprovalLocally,
  } = useRunEvents({
    baseUrl,
    buildSessionId,
    organizationId,
    projectId,
  });

  const { items, messages, tasks, lifecycle, lastSequence } = conversation;

  const handleSend = useCallback(
    async (text: string) => {
      addUserMessage(text);
      if (onSendMessage) {
        await onSendMessage(text);
      }
    },
    [addUserMessage, onSendMessage]
  );

  const handleResolveApproval = useCallback(
    async (toolCallId: string, resolution: unknown) => {
      resolveApprovalLocally(toolCallId, resolution);
      if (onResolveApproval) {
        await onResolveApproval(toolCallId, resolution);
      }
    },
    [resolveApprovalLocally, onResolveApproval]
  );

  // Convert ChatMessageItem to UIMessage format for ConversationDownload transcript export
  const uiMessagesForDownload: UIMessage[] = useMemo(
    () =>
      messages.map((m) => ({
        content: m.text,
        id: m.id,
        parts: [{ text: m.text, type: "text" }],
        role: m.role,
      })),
    [messages]
  );

  return (
    <div
      className={cn(
        "relative flex h-full flex-col overflow-hidden bg-background",
        className
      )}
    >
      {/* Conversation Top Header */}
      <div className="flex shrink-0 items-center justify-between border-b bg-card/70 px-4 py-3 backdrop-blur-xs">
        <div className="flex items-center gap-3">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-xs">
            <Sparkles className="size-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-semibold text-foreground text-sm leading-tight">
                ReasonateAI Virtual CTO
              </h2>
              <Badge className="py-0 font-mono text-[10px]" variant="outline">
                seq #{lastSequence}
              </Badge>
            </div>
            <p className="font-mono text-[11px] text-muted-foreground">
              Session: {buildSessionId.slice(0, 8)}... | Org:{" "}
              {organizationId.slice(0, 8)}...
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <ConnectionStatusBadge
            detail={connectionDetail}
            onReconnect={reconnect}
            state={connectionState}
          />
        </div>
      </div>

      {/* Task Progress Bar if tasks exist */}
      {tasks.length > 0 && (
        <div className="px-4 pt-2">
          <TaskProgressTree tasks={tasks} />
        </div>
      )}

      {/* Main Conversation Stream */}
      <Conversation className="flex-1 px-4">
        <ConversationContent className="mx-auto max-w-4xl gap-4 py-4">
          {items.length === 0 ? (
            <ConversationEmptyState
              description="The AI CTO Orchestrator is listening. Submit a prompt or inspect live execution events."
              icon={<Bot className="mb-2 size-10 text-muted-foreground/60" />}
              title="Virtual CTO Ready"
            />
          ) : (
            items.map((item: ConversationTimelineItem) => (
              <TimelineItemView
                item={item}
                key={item.id}
                onResolveApproval={handleResolveApproval}
              />
            ))
          )}
        </ConversationContent>

        <ConversationScrollButton />
        {uiMessagesForDownload.length > 0 && (
          <ConversationDownload
            filename={`cto-conversation-${buildSessionId.slice(0, 8)}.md`}
            messages={uiMessagesForDownload}
          />
        )}
      </Conversation>

      {/* Input Bar */}
      <div className="mx-auto w-full max-w-4xl shrink-0 border-t bg-card/50 p-4 backdrop-blur-xs">
        <ChatInputBar
          disabled={lifecycle === "completed" || lifecycle === "cancelled"}
          onSendMessage={handleSend}
          placeholder={resolvePlaceholder(lifecycle)}
        />
      </div>
    </div>
  );
}
