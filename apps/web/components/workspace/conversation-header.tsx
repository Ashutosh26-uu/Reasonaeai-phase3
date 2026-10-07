"use client";

import {
  ConversationListSchema,
  type ConversationMessage,
  type ConversationSummary,
  type UpdateConversationRequest,
} from "@reasonateai/contracts/execution";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@reasonateai/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@reasonateai/ui/components/dropdown-menu";
import {
  Archive,
  Copy,
  ExternalLink,
  FileText,
  FolderClosed,
  ListFilter,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  RotateCcw,
  SquarePen,
  X,
} from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { CheckpointCard } from "@/components/chat/checkpoint-card";
import type {
  CheckpointScope,
  TurnCheckpoint,
} from "@/components/chat/checkpoint-state";
import { describeError, request } from "@/lib/product-api";

interface HeaderProps {
  canManage: boolean;
  conversationId: string;
  heading: string;
  isPinned: boolean;
  messages: ConversationMessage[];
  onNewConversation: () => void;
  onOpenPanel: () => void;
  onPin: () => void;
  onRefresh: () => void;
  onUpdate: (id: string, update: UpdateConversationRequest) => Promise<void>;
  projectName: string;
  scope: CheckpointScope;
  selectedProject: boolean;
  status: string;
  turn?: TurnCheckpoint | undefined;
  working: boolean;
}

function RenameDialog({
  heading,
  onClose,
  onSave,
}: {
  heading: string;
  onClose: () => void;
  onSave: (title: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(heading);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputId = useId();
  const save = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setBusy(true);
      setError("");
      try {
        await onSave(title.trim());
        onClose();
      } catch (cause) {
        setError(describeError(cause, "Could not rename this conversation."));
      } finally {
        setBusy(false);
      }
    },
    [onClose, onSave, title]
  );
  const changeTitle = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setTitle(event.currentTarget.value),
    []
  );
  const changeOpen = useCallback(
    (open: boolean) => {
      if (!(open || busy)) {
        onClose();
      }
    },
    [busy, onClose]
  );
  return (
    <Dialog onOpenChange={changeOpen} open>
      <DialogContent className="conversation-dialog" showCloseButton={!busy}>
        <DialogTitle>Rename conversation</DialogTitle>
        <DialogDescription>
          Choose a title you can recognize later.
        </DialogDescription>
        <form onSubmit={save}>
          <label htmlFor={inputId}>Conversation title</label>
          <input
            disabled={busy}
            id={inputId}
            maxLength={500}
            onChange={changeTitle}
            required
            value={title}
          />
          {error && <p role="alert">{error}</p>}
          <div className="conversation-dialog-actions">
            <button disabled={busy} onClick={onClose} type="button">
              Cancel
            </button>
            <button disabled={busy || !title.trim()} type="submit">
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ArchivedDialog({
  canManage,
  onClose,
  onUpdate,
  scope,
}: Pick<HeaderProps, "canManage" | "onUpdate" | "scope"> & {
  onClose: () => void;
}) {
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    request(
      `/v1/projects/${scope.projectId}/conversations?organizationId=${encodeURIComponent(scope.organizationId)}&archived=true`,
      ConversationListSchema.parse,
      { signal: abort.signal }
    )
      .then((result) => {
        if (!abort.signal.aborted) {
          setItems(result.conversations);
        }
      })
      .catch((cause: unknown) => {
        if (!abort.signal.aborted) {
          setError(
            describeError(cause, "Could not load archived conversations.")
          );
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) {
          setLoading(false);
        }
      });
    return () => abort.abort();
  }, [attempt, scope.organizationId, scope.projectId]);
  const restore = useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>) => {
      const id = event.currentTarget.value;
      setBusy(id);
      setError("");
      try {
        await onUpdate(id, { archived: false });
        setItems((current) =>
          current.filter((item) => item.buildSessionId !== id)
        );
      } catch (cause) {
        setError(describeError(cause, "Could not restore this conversation."));
      } finally {
        setBusy("");
      }
    },
    [onUpdate]
  );
  const changeOpen = useCallback(
    (open: boolean) => {
      if (!(open || busy)) {
        onClose();
      }
    },
    [busy, onClose]
  );
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return (
    <Dialog onOpenChange={changeOpen} open>
      <DialogContent className="conversation-dialog" showCloseButton={!busy}>
        <DialogTitle>Archived conversations</DialogTitle>
        <DialogDescription>
          Archived chats retain their messages and checkpoints. Restore one to
          continue it.
        </DialogDescription>
        {loading && <p role="status">Loading archived conversations…</p>}
        {error && (
          <div role="alert">
            <p>{error}</p>
            <button disabled={Boolean(busy)} onClick={retry} type="button">
              Retry
            </button>
          </div>
        )}
        {!(loading || error) && items.length === 0 && (
          <p>No archived conversations in this project.</p>
        )}
        <ul className="conversation-archive-list">
          {items.map((item) => (
            <li key={item.buildSessionId}>
              <span title={item.title ?? "Untitled conversation"}>
                {item.title ?? "Untitled conversation"}
              </span>
              {canManage && (
                <button
                  aria-label={`Restore ${item.title ?? "conversation"}`}
                  disabled={Boolean(busy)}
                  onClick={restore}
                  type="button"
                  value={item.buildSessionId}
                >
                  <RotateCcw aria-hidden="true" size={16} />
                  {busy === item.buildSessionId ? "Restoring…" : "Restore"}
                </button>
              )}
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

function ConversationSummaryCard({
  heading,
  messages,
  onClose,
  onOpenPanel,
  projectName,
  scope,
  status,
  turn,
}: Pick<
  HeaderProps,
  | "heading"
  | "messages"
  | "onOpenPanel"
  | "projectName"
  | "scope"
  | "status"
  | "turn"
> & { onClose: () => void }) {
  const sources = messages.flatMap((message) =>
    (message.attachments ?? []).map((source, index) => ({
      ...source,
      key: `${message.id}:${index}`,
    }))
  );
  return (
    <>
      <div className="conversation-summary-head">
        <strong title={heading}>{heading}</strong>
        <button
          aria-label="Close summary"
          className="pane-button pane-icon-button"
          onClick={onClose}
          type="button"
        >
          <X aria-hidden="true" size={16} />
        </button>
      </div>
      <p className="conversation-summary-status">
        {projectName} · {status}
      </p>
      <section>
        <h2>Changes</h2>
        {turn ? (
          <CheckpointCard scope={scope} turn={turn} />
        ) : (
          <p>No saved changes yet.</p>
        )}
      </section>
      <section>
        <h2>Outputs</h2>
        <button
          className="conversation-summary-link"
          onClick={onOpenPanel}
          type="button"
        >
          <ExternalLink aria-hidden="true" size={17} />
          Open workspace tabs
        </button>
        <p>Inspect the app preview, saved files, changes, and run activity.</p>
      </section>
      <section>
        <h2>Sources</h2>
        {sources.length > 0 ? (
          <ul>
            {sources.map((source) => (
              <li key={source.key} title={source.filename}>
                <FileText aria-hidden="true" size={17} />
                <span>{source.filename}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>No uploaded sources in this conversation.</p>
        )}
      </section>
    </>
  );
}

function ConversationMenu({
  busy,
  canManage,
  conversationId,
  isPinned,
  onArchive,
  onArchived,
  onCopy,
  onNewConversation,
  onPin,
  onRefresh,
  onRename,
}: Pick<
  HeaderProps,
  | "canManage"
  | "conversationId"
  | "isPinned"
  | "onNewConversation"
  | "onPin"
  | "onRefresh"
> & {
  busy: boolean;
  onArchive: () => void;
  onArchived: () => void;
  onCopy: () => void;
  onRename: () => void;
}) {
  const hasConversation = Boolean(conversationId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label="Conversation options"
          className="pane-button pane-icon-button"
          title="Conversation options"
          type="button"
        >
          <MoreHorizontal aria-hidden="true" size={20} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="conversation-menu"
        sideOffset={8}
      >
        <DropdownMenuItem
          disabled={!(hasConversation && canManage) || busy}
          onSelect={onRename}
        >
          <Pencil aria-hidden="true" />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!hasConversation} onSelect={onPin}>
          <Pin aria-hidden="true" />
          {isPinned ? "Unpin" : "Pin"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onNewConversation}>
          <SquarePen aria-hidden="true" />
          New conversation
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onRefresh}>
          <RefreshCw aria-hidden="true" />
          Refresh conversation
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!hasConversation} onSelect={onCopy}>
          <Copy aria-hidden="true" />
          Copy conversation link
        </DropdownMenuItem>
        <DropdownMenuItem asChild disabled={!hasConversation}>
          <a
            href={
              hasConversation && typeof window !== "undefined"
                ? window.location.href
                : undefined
            }
            rel="noopener noreferrer"
            target="_blank"
          >
            <ExternalLink aria-hidden="true" />
            Open in new window
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onArchived}>
          <Archive aria-hidden="true" />
          Archived conversations
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!(hasConversation && canManage) || busy}
          onSelect={onArchive}
        >
          <Archive aria-hidden="true" />
          {busy ? "Archiving…" : "Archive"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ConversationHeader(props: HeaderProps) {
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [dialog, setDialog] = useState<"rename" | "archived" | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{
    error: boolean;
    message: string;
  } | null>(null);
  const summaryId = useId();
  useEffect(() => {
    if (!summaryOpen) {
      return;
    }
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSummaryOpen(false);
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [summaryOpen]);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setFeedback({
        error: false,
        message:
          "Conversation link copied. Access still requires project membership.",
      });
    } catch {
      setFeedback({
        error: true,
        message: "Could not copy the link. Copy the address from your browser.",
      });
    }
  }, []);
  const archive = useCallback(async () => {
    setBusy(true);
    setFeedback(null);
    try {
      await props.onUpdate(props.conversationId, { archived: true });
    } catch (cause) {
      setFeedback({
        error: true,
        message: describeError(cause, "Could not archive this conversation."),
      });
    } finally {
      setBusy(false);
    }
  }, [props.conversationId, props.onUpdate]);
  const openPanel = useCallback(() => {
    setSummaryOpen(false);
    props.onOpenPanel();
  }, [props.onOpenPanel]);
  const showArchived = useCallback(() => setDialog("archived"), []);
  const showRename = useCallback(() => setDialog("rename"), []);
  const closeDialog = useCallback(() => setDialog(null), []);
  const closeSummary = useCallback(() => setSummaryOpen(false), []);
  const toggleSummary = useCallback(() => setSummaryOpen((open) => !open), []);
  const dismissFeedback = useCallback(() => setFeedback(null), []);
  const saveTitle = useCallback(
    (title: string) => props.onUpdate(props.conversationId, { title }),
    [props.conversationId, props.onUpdate]
  );
  return (
    <>
      <header className="pane-head">
        <FolderClosed aria-hidden="true" className="pane-folder" size={20} />
        <h1 className="pane-title" title={props.heading}>
          {props.heading}
        </h1>
        <div className="pane-tools">
          {props.selectedProject && (
            <ConversationMenu
              busy={busy || props.working}
              canManage={props.canManage}
              conversationId={props.conversationId}
              isPinned={props.isPinned}
              onArchive={archive}
              onArchived={showArchived}
              onCopy={copy}
              onNewConversation={props.onNewConversation}
              onPin={props.onPin}
              onRefresh={props.onRefresh}
              onRename={showRename}
            />
          )}
          {props.conversationId && (
            <>
              <button
                aria-controls={summaryId}
                aria-expanded={summaryOpen}
                aria-label="Toggle summary"
                aria-pressed={summaryOpen}
                className="pane-button pane-icon-button"
                onClick={toggleSummary}
                title="Toggle summary"
                type="button"
              >
                <ListFilter aria-hidden="true" size={20} />
              </button>
              <span aria-hidden="true" className="pane-tool-divider" />
              <button
                aria-label="New workspace tab"
                className="pane-button pane-icon-button"
                onClick={props.onOpenPanel}
                title="New workspace tab"
                type="button"
              >
                <Plus aria-hidden="true" size={20} />
              </button>
            </>
          )}
        </div>
      </header>
      {summaryOpen && (
        <section
          aria-label="Conversation summary"
          className="conversation-summary"
          id={summaryId}
        >
          <ConversationSummaryCard
            heading={props.heading}
            messages={props.messages}
            onClose={closeSummary}
            onOpenPanel={openPanel}
            projectName={props.projectName}
            scope={props.scope}
            status={props.status}
            turn={props.turn}
          />
        </section>
      )}
      {feedback && (
        <div
          className={feedback.error ? "banner is-error" : "banner"}
          role={feedback.error ? "alert" : "status"}
        >
          <span>{feedback.message}</span>
          <button onClick={dismissFeedback} type="button">
            Dismiss
          </button>
        </div>
      )}
      {dialog === "rename" && (
        <RenameDialog
          heading={props.heading}
          onClose={closeDialog}
          onSave={saveTitle}
        />
      )}
      {dialog === "archived" && (
        <ArchivedDialog
          canManage={props.canManage}
          onClose={closeDialog}
          onUpdate={props.onUpdate}
          scope={props.scope}
        />
      )}
    </>
  );
}
