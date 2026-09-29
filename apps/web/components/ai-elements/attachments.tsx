"use client";

import { FileText, Image as ImageIcon, X } from "lucide-react";
import Image from "next/image";
import { useCallback } from "react";

export interface AttachmentItem {
  filename: string;
  id: string;
  mediaType: string;
  previewUrl?: string;
}

function AttachmentIcon({ item }: { item: AttachmentItem }) {
  if (item.previewUrl) {
    return (
      <Image
        alt=""
        className="prompt-attachment-preview"
        height={28}
        src={item.previewUrl}
        unoptimized
        width={28}
      />
    );
  }
  if (item.mediaType.startsWith("image/")) {
    return <ImageIcon aria-hidden="true" size={16} />;
  }
  return <FileText aria-hidden="true" size={16} />;
}

function AttachmentRemoveButton({
  filename,
  id,
  onRemove,
}: {
  filename: string;
  id: string;
  onRemove: (id: string) => void;
}) {
  const remove = useCallback(() => onRemove(id), [id, onRemove]);
  return (
    <button
      aria-label={`Remove ${filename}`}
      className="prompt-attachment-remove"
      onClick={remove}
      type="button"
    >
      <X aria-hidden="true" size={14} />
    </button>
  );
}

/** Compact attachment chips used by the prompt input and persisted messages. */
export function Attachments({
  items,
  onRemove,
}: {
  items: AttachmentItem[];
  onRemove?: (id: string) => void;
}) {
  if (items.length === 0) {
    return null;
  }

  return (
    <ul aria-label="Attached files" className="prompt-attachments">
      {items.map((item) => (
        <li className="prompt-attachment" key={item.id}>
          <AttachmentIcon item={item} />
          <span className="prompt-attachment-name" title={item.filename}>
            {item.filename}
          </span>
          {onRemove && (
            <AttachmentRemoveButton
              filename={item.filename}
              id={item.id}
              onRemove={onRemove}
            />
          )}
        </li>
      ))}
    </ul>
  );
}
