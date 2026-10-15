"use client";

import type { ConversationAttachment } from "@reasonateai/contracts/execution";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@reasonateai/ui/components/dialog";
import { FileText } from "lucide-react";
import Image from "next/image";
import { useCallback, useState } from "react";

function SubmittedFile({ file }: { file: ConversationAttachment }) {
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const failure = useCallback(() => setFailed(true), []);
  const retry = useCallback(() => {
    setFailed(false);
    setRevision((value) => value + 1);
  }, []);
  const image = ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
    file.mediaType
  );
  if (!(file.url && image)) {
    return (
      <a className="submitted-file" href={file.url}>
        <FileText aria-hidden="true" size={18} />
        {file.filename}
        <span>{Math.ceil(file.sizeBytes / 1024)} KB</span>
      </a>
    );
  }
  const src = `${file.url}&preview=${revision}`;
  if (failed) {
    return (
      <div className="submitted-file" role="status">
        <span>{file.filename} — preview unavailable</span>
        <button onClick={retry} type="button">
          Retry preview
        </button>
        <a href={file.url} rel="noreferrer" target="_blank">
          Open file
        </a>
      </div>
    );
  }
  return (
    <Dialog>
      <DialogTrigger
        aria-label={`View ${file.filename}`}
        className="submitted-image"
        type="button"
      >
        <Image
          alt={file.filename}
          height={160}
          onError={failure}
          src={src}
          unoptimized
          width={160}
        />
      </DialogTrigger>
      <DialogContent className="attachment-viewer">
        <DialogTitle>{file.filename}</DialogTitle>
        <Image
          alt={file.filename}
          height={1200}
          onError={failure}
          src={src}
          unoptimized
          width={1600}
        />
        <a href={file.url} rel="noreferrer" target="_blank">
          Open original
        </a>
      </DialogContent>
    </Dialog>
  );
}

export function SubmittedAttachments({
  files,
}: {
  files: ConversationAttachment[];
}) {
  if (files.length === 0) {
    return null;
  }
  return (
    <ul aria-label="Attached files" className="submitted-attachments">
      {files.map((file, index) => (
        <li key={`${index}:${file.filename}`}>
          <SubmittedFile file={file} />
        </li>
      ))}
    </ul>
  );
}
