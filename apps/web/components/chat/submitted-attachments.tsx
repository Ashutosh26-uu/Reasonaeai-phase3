"use client";

import type { ConversationAttachment } from "@reasonateai/contracts/execution";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@reasonateai/ui/components/dialog";
import {
  File,
  FileArchive,
  FileCode,
  FileSpreadsheet,
  FileText,
} from "lucide-react";
import Image from "next/image";
import { useCallback, useState } from "react";
import { PastedText } from "@/components/ai-elements/pasted-text";
import { isLegacyPaste } from "@/lib/pasted-attachment";

const FILE_EXTENSION = /^[a-z0-9]{1,8}$/;

function filePresentation(file: ConversationAttachment) {
  const extension = file.filename.split(".").at(-1)?.toLowerCase();
  const label =
    extension &&
    extension !== file.filename.toLowerCase() &&
    FILE_EXTENSION.test(extension)
      ? extension.toUpperCase()
      : "FILE";
  if (["csv", "xls", "xlsx", "ods"].includes(extension ?? "")) {
    return { Icon: FileSpreadsheet, label };
  }
  if (["zip", "gz", "tar", "7z", "rar"].includes(extension ?? "")) {
    return { Icon: FileArchive, label };
  }
  if (
    ["json", "js", "ts", "tsx", "py", "html", "css", "xml"].includes(
      extension ?? ""
    )
  ) {
    return { Icon: FileCode, label };
  }
  return {
    Icon:
      file.mediaType.startsWith("text/") ||
      ["pdf", "doc", "docx", "md"].includes(extension ?? "")
        ? FileText
        : File,
    label,
  };
}

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
  if (file.paste || isLegacyPaste(file)) {
    return <PastedText file={file} />;
  }
  if (!(file.url && image)) {
    const { Icon, label } = filePresentation(file);
    return (
      <a className="submitted-file" href={file.url} title={file.filename}>
        <Icon aria-hidden="true" size={28} />
        <span className="submitted-file-name">{file.filename}</span>
        <span className="submitted-file-details">
          {label} · {Math.ceil(file.sizeBytes / 1024)} KB
        </span>
      </a>
    );
  }
  const src = `${file.url}&preview=${revision}`;
  if (failed) {
    return (
      <div className="submitted-file submitted-file-error" role="status">
        <span className="submitted-file-name" title={file.filename}>
          {file.filename}
        </span>
        <span className="submitted-file-details">Preview unavailable</span>
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
          height={240}
          onError={failure}
          src={src}
          unoptimized
          width={320}
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
  const columns = Math.min(files.length, 3);
  return (
    <ul
      aria-label="Attached files"
      className="submitted-attachments"
      style={{
        width: `min(100%, ${columns * 240 + (columns - 1) * 8}px)`,
      }}
    >
      {files.map((file, index) => (
        <li key={`${index}:${file.filename}`}>
          <SubmittedFile file={file} />
        </li>
      ))}
    </ul>
  );
}
