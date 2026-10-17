"use client";

import type { PastePresentation } from "@reasonateai/contracts/execution";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@reasonateai/ui/components/dialog";
import { ClipboardPaste } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { pastePresentation } from "@/lib/pasted-attachment";
import { readPastedText } from "@/lib/read-pasted-text";

type PasteRead =
  | { status: "idle" | "loading" }
  | { status: "ready"; text: string }
  | { status: "error"; message: string };

function pasteCount(paste: PastePresentation) {
  return paste.lineCount > 1
    ? `${paste.lineCount.toLocaleString()} lines`
    : `${paste.charCount.toLocaleString()} characters`;
}

export function PastedText({
  file,
  className = "",
}: {
  file: { paste?: PastePresentation | undefined; url?: string | undefined };
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [read, setRead] = useState<PasteRead>({ status: "idle" });
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!(open && file.url)) {
      return;
    }
    const abort = new AbortController();
    setRead({ status: "loading" });
    readPastedText(file.url, abort.signal).then(
      (text) => {
        if (!abort.signal.aborted) {
          setRead({ status: "ready", text });
        }
      },
      () => {
        if (!abort.signal.aborted) {
          setRead({
            message: "Could not load pasted text. Try again.",
            status: "error",
          });
        }
      }
    );
    return () => abort.abort();
  }, [open, file.url, revision]);
  const presentation =
    file.paste ??
    (read.status === "ready" && read.text
      ? pastePresentation(read.text)
      : undefined);
  const count = presentation ? pasteCount(presentation) : "Open to read";
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        aria-label={`Read pasted text${presentation ? `, ${count}` : ""}`}
        className={`submitted-paste ${className}`}
        disabled={!file.url}
        type="button"
      >
        <span className="pasted-text-heading">
          <ClipboardPaste aria-hidden="true" size={16} />
          Pasted text
        </span>
        <span aria-hidden="true" className="pasted-text-excerpt">
          {presentation?.preview || "Open to preview pasted content"}
        </span>
        <span className="pasted-text-caption">
          {file.url ? count : "Original unavailable"}
        </span>
      </DialogTrigger>
      <DialogContent className="pasted-text-viewer">
        <DialogTitle>Pasted text</DialogTitle>
        <DialogDescription>
          {presentation ? count : "Original pasted content"}
        </DialogDescription>
        {read.status === "loading" && <p role="status">Loading pasted text…</p>}
        {read.status === "error" && (
          <div role="alert">
            <p>{read.message}</p>
            <button onClick={retry} type="button">
              Retry
            </button>
          </div>
        )}
        {read.status === "ready" && (
          <pre className="pasted-text-original">{read.text}</pre>
        )}
        {file.url && (
          <a href={file.url} rel="noreferrer" target="_blank">
            Download original
          </a>
        )}
      </DialogContent>
    </Dialog>
  );
}
