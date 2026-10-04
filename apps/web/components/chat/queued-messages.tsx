"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@reasonateai/ui/components/dropdown-menu";
import {
  CornerDownRight,
  FileText,
  ListEnd,
  MessageCirclePlus,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import Image from "next/image";
import { useCallback, useState } from "react";
import styles from "./composer.module.css";
import type { QueuedMessage } from "./message-queue";

export interface QueuedMessageRowProps {
  error: string | undefined;
  limit: number;
  onEdit: (id: string, text: string) => void;
  onOpenSideChat: ((id: string) => void) | undefined;
  onRemove: (id: string) => void;
  onSend: (id: string) => void;
  onToggleQueueing: () => void;
  pending: boolean;
  queued: QueuedMessage;
  queueing: boolean;
  sending: boolean;
  steerDisabled: boolean;
}

function deliveryLabel(queued: QueuedMessage, pending: boolean) {
  switch (queued.delivery?.kind) {
    case "steer":
      return "Retry steering";
    case "side-chat":
      return "Retry side chat";
    case "turn":
      return "Retry send";
    default:
      return pending ? "Steer" : "Send now";
  }
}

export function QueuedMessageRow({
  error,
  limit,
  onEdit,
  onOpenSideChat,
  onRemove,
  onSend,
  onToggleQueueing,
  pending,
  queued,
  queueing,
  sending,
  steerDisabled,
}: QueuedMessageRowProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(queued.message);
  const [attachment] = queued.attachments;
  const beginEdit = useCallback(() => {
    setText(queued.message);
    setEditing(true);
  }, [queued.message]);
  const saveEdit = useCallback(() => {
    onEdit(queued.id, text);
    setEditing(false);
  }, [onEdit, queued.id, text]);
  const send = useCallback(() => onSend(queued.id), [onSend, queued.id]);
  const remove = useCallback(() => onRemove(queued.id), [onRemove, queued.id]);
  const openSideChat = useCallback(
    () => onOpenSideChat?.(queued.id),
    [onOpenSideChat, queued.id]
  );
  const cancelEdit = useCallback(() => setEditing(false), []);
  const changeText = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) =>
      setText(event.currentTarget.value),
    []
  );
  let label = deliveryLabel(queued, pending);
  if (sending) {
    label = "Sending…";
  }
  return (
    <li className={styles.queuedRow}>
      <div className={styles.queuedMain}>
        <ListEnd aria-hidden="true" className={styles.queueIcon} size={16} />
        {attachment && (
          <span
            className={styles.queuedThumbnail}
            title={queued.attachments.map((file) => file.filename).join(", ")}
          >
            {attachment.mediaType.startsWith("image/") &&
            attachment.mediaType !== "image/svg+xml" ? (
              <Image
                alt={attachment.filename}
                height={28}
                src={attachment.data}
                unoptimized
                width={28}
              />
            ) : (
              <FileText aria-hidden="true" size={18} />
            )}
            {queued.attachments.length > 1 && (
              <small>+{queued.attachments.length - 1}</small>
            )}
          </span>
        )}
        <p className={styles.queuedText} title={queued.message}>
          {queued.message || attachment?.filename}
        </p>
        <div className={styles.queuedActions}>
          <button
            disabled={steerDisabled || editing}
            onClick={send}
            title={
              pending && queued.attachments.length
                ? "Attachments will send as a follow-up after this run."
                : undefined
            }
            type="button"
          >
            <CornerDownRight aria-hidden="true" size={15} />
            {label}
          </button>
          <button
            aria-label="Delete queued message"
            disabled={sending}
            onClick={remove}
            type="button"
          >
            <Trash2 aria-hidden="true" size={16} />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                aria-label="Queued message actions"
                disabled={sending}
                type="button"
              >
                <MoreHorizontal aria-hidden="true" size={17} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className={styles.queueMenu}
              side="bottom"
            >
              <DropdownMenuItem onSelect={beginEdit}>
                <Pencil aria-hidden="true" />
                Edit message
              </DropdownMenuItem>
              {onOpenSideChat &&
                (!queued.delivery || queued.delivery.kind === "side-chat") && (
                  <DropdownMenuItem onSelect={openSideChat}>
                    <MessageCirclePlus aria-hidden="true" />
                    Open in side chat
                  </DropdownMenuItem>
                )}
              <DropdownMenuItem onSelect={onToggleQueueing}>
                <ListEnd aria-hidden="true" />
                {queueing ? "Turn off queuing" : "Turn on queuing"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {editing && (
        <div className={styles.queueEditor}>
          <textarea
            aria-label="Edit queued message"
            autoFocus
            maxLength={limit}
            onChange={changeText}
            value={text}
          />
          <button
            disabled={!(text.trim() || queued.attachments.length)}
            onClick={saveEdit}
            type="button"
          >
            Save
          </button>
          <button onClick={cancelEdit} type="button">
            Cancel
          </button>
        </div>
      )}
      {error && (
        <p className={styles.queueError} role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
