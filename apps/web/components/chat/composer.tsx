"use client";

import type { PromptAttachment } from "@reasonateai/contracts/execution";
import { BorderBeam } from "border-beam";
import { ArrowUp, ChevronDown, Mic, Paperclip, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMicrophone, VoiceBeam } from "voice-glow";
import { Attachments } from "@/components/ai-elements/attachments";
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";

/**
 * What the line under the card says: an error, what the microphone is doing, or
 * what the keyboard does.
 */
function ComposerHint({
  error,
  pending,
  recording,
  transcribing,
}: {
  error: string;
  pending: boolean;
  recording: boolean;
  transcribing: boolean;
}) {
  if (error.length > 0) {
    return <span>{error}</span>;
  }
  if (recording) {
    return (
      <span>
        Listening. Stop when you are done; the transcript lands here for review.
      </span>
    );
  }
  if (transcribing) {
    return <span>Transcribing…</span>;
  }
  if (pending) {
    return (
      <span>
        Your CTO is working. This message sends when the run finishes.
      </span>
    );
  }
  return <span>Enter to send, Shift + Enter for a new line.</span>;
}

/** The panel above the card: a file to mention, or what the model chip means. */
function PromptMenus({
  files,
  menu,
  onMention,
}: {
  files: string[];
  menu: "files" | "none" | "notes";
  onMention: (path: string) => void;
}) {
  if (menu === "files") {
    return <MentionMenu files={files} onMention={onMention} />;
  }
  if (menu === "notes") {
    return (
      <div className="prompt-menu">
        <p className="prompt-menu-note">
          Every run executes on an open-weight model behind the runtime's
          provider router. The identifier is pinned per deployment, not per
          conversation, so there is nothing to choose here yet.
        </p>
      </div>
    );
  }
  return null;
}

export interface ComposerProps {
  /** True while the CTO is working, when a turn cannot be accepted yet. */
  busy: boolean;
  /** Shown only when the draft is long enough for the limit to matter. */
  count: number;
  draft: string;
  /** The character limit, reported only as the draft approaches it. */
  limit: number;
  /**
   * The files this project's latest checkpoint holds, for a mention. Absent
   * when there is nothing to mention yet, and the `@` control is absent with it
   * — a control that opens an empty menu is worse than no control.
   */
  listFiles?: () => Promise<string[]>;
  /** The model this workspace runs on, shown so the choice is visible. */
  model: string;
  onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Stops the active CTO run while its response is streaming. */
  onStop: () => void;
  onSubmit: (input: {
    attachments: PromptAttachment[];
    message: string;
  }) => Promise<boolean>;
  /** Turns recorded audio into text, or reports why it cannot. */
  onTranscribe: (audio: Blob) => Promise<string>;
  pending: boolean;
  placeholder: string;
  stopping: boolean;
}

/** How long a recording may run before it stops itself. */
const MAX_RECORDING_MS = 120_000;
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const MAX_ATTACHMENTS = 5;
const ATTACHMENT_ACCEPT =
  "image/*,application/pdf,text/*,application/json,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation";

function dataUrlSize(data: string): number {
  const encoded = data.slice(data.indexOf(",") + 1);
  let padding = 0;
  if (encoded.endsWith("==")) {
    padding = 2;
  } else if (encoded.endsWith("=")) {
    padding = 1;
  }
  return Math.floor((encoded.length * 3) / 4) - padding;
}

function PromptAttachmentPreview() {
  const { files, remove } = usePromptInputAttachments();

  if (files.length === 0) {
    return null;
  }

  return (
    <PromptInputHeader className="prompt-attachment-header">
      <Attachments
        items={files.map((file) => ({
          filename: file.filename ?? "Attachment",
          id: file.id,
          mediaType: file.mediaType || "application/octet-stream",
          previewUrl: file.url,
        }))}
        onRemove={remove}
      />
    </PromptInputHeader>
  );
}

function PromptSendButton({
  busy,
  draft,
  pending,
  onStop,
  stopping,
}: {
  busy: boolean;
  draft: string;
  onStop: () => void;
  pending: boolean;
  stopping: boolean;
}) {
  const { files } = usePromptInputAttachments();
  const submitProps: {
    onStop?: () => void;
    status?: "streaming" | "submitted";
  } = {};
  let label = "Send message";
  if (pending) {
    submitProps.onStop = onStop;
    submitProps.status = "streaming";
    label = stopping ? "Stopping run" : "Stop run";
  } else if (busy) {
    submitProps.status = "submitted";
  }
  return (
    <PromptInputSubmit
      aria-label={label}
      className="prompt-send"
      data-working={busy || pending || undefined}
      disabled={pending ? stopping : busy || !(draft.trim() || files.length)}
      {...submitProps}
    >
      {pending ? (
        <Square aria-hidden="true" size={14} />
      ) : (
        <ArrowUp aria-hidden="true" size={17} />
      )}
    </PromptInputSubmit>
  );
}

function PromptAttachButton({
  busy,
  pending,
  onErrorClear,
}: {
  busy: boolean;
  pending: boolean;
  onErrorClear: () => void;
}) {
  const { openFileDialog } = usePromptInputAttachments();
  const open = useCallback(() => {
    onErrorClear();
    openFileDialog();
  }, [onErrorClear, openFileDialog]);
  return (
    <PromptInputButton
      aria-label="Attach files"
      className="prompt-mic"
      disabled={busy || pending}
      onClick={open}
    >
      <Paperclip aria-hidden="true" size={15} />
    </PromptInputButton>
  );
}

/** A change event carrying one value, for a field this component owns. */
function valueEvent(value: string): React.ChangeEvent<HTMLTextAreaElement> {
  return {
    currentTarget: { value },
  } as React.ChangeEvent<HTMLTextAreaElement>;
}

/**
 * Recording and transcription, kept out of the composer's layout.
 *
 * The microphone is real browser capture, and the transcript is returned rather
 * than sent: a transcription is a guess about what someone said, and the person
 * is the one who decides it is what they meant.
 */
function useVoiceCapture(input: {
  draft: string;
  onTranscribe: (audio: Blob) => Promise<string>;
  setDraft: (value: string) => void;
}) {
  const mic = useMicrophone();
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const latest = useRef(input);
  latest.current = input;

  const stop = useCallback(() => {
    recorder.current?.stop();
    mic.stop();
    setRecording(false);
  }, [mic]);

  useEffect(() => {
    if (!recording) {
      return;
    }
    // A recording that nobody stops must not run forever.
    const timer = setTimeout(stop, MAX_RECORDING_MS);
    return () => clearTimeout(timer);
  }, [recording, stop]);

  const start = useCallback(async () => {
    setError("");
    const stream = await mic.start();
    if (stream === null) {
      setError(
        mic.error?.message ??
          "The microphone is unavailable. Check the browser's permission for this site."
      );
      return;
    }

    chunks.current = [];
    const mimeType = MediaRecorder.isTypeSupported("audio/webm")
      ? "audio/webm"
      : "";
    const created = new MediaRecorder(
      stream,
      mimeType.length > 0 ? { mimeType } : undefined
    );
    created.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.current.push(event.data);
      }
    };
    created.onstop = () => {
      const blob = new Blob(chunks.current, {
        type: mimeType.length > 0 ? mimeType : "audio/webm",
      });
      chunks.current = [];
      if (blob.size === 0) {
        return;
      }
      setTranscribing(true);
      const { draft, onTranscribe, setDraft } = latest.current;
      onTranscribe(blob)
        .then((text) => {
          if (text.length > 0) {
            setDraft(draft.length > 0 ? `${draft} ${text}` : text);
          }
        })
        .catch((cause: unknown) => {
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not transcribe that recording."
          );
        })
        .finally(() => setTranscribing(false));
    };
    recorder.current = created;
    created.start();
    setRecording(true);
  }, [mic]);

  return {
    error,
    recording,
    start,
    stop,
    supported: mic.supported,
    transcribing,
  };
}

/**
 * The mention menu: the files of this project's latest checkpoint.
 *
 * A mention is the path of a real file, so the agent reads the file the person
 * pointed at rather than a name they guessed at.
 */
function MentionMenu({
  files,
  onMention,
}: {
  files: string[];
  onMention: (path: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const change = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setFilter(event.currentTarget.value),
    []
  );
  const choose = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) =>
      onMention(event.currentTarget.value),
    [onMention]
  );
  const shown = filter.length
    ? files.filter((path) => path.includes(filter))
    : files;

  return (
    <div className="prompt-menu">
      <input
        aria-label="Filter files"
        autoFocus
        className="prompt-menu-filter"
        onChange={change}
        placeholder="Mention a file from this project…"
        value={filter}
      />
      {shown.length === 0 ? (
        <p className="prompt-menu-note">
          This project has no checkpoint yet, so there is nothing to mention.
        </p>
      ) : (
        <div className="prompt-menu-list">
          {shown.slice(0, 40).map((path) => (
            <button
              className="prompt-menu-item"
              key={path}
              onClick={choose}
              type="button"
              value={path}
            >
              {path}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The one place a message is written.
 *
 * A card rather than a field: the mention, the agent, the model, the voice, and
 * the send action are all parts of writing one message, and the beam on its
 * border is what makes it read as the live surface of the product.
 */
export function Composer({
  busy,
  count,
  draft,
  limit,
  listFiles,
  model,
  onChange,
  onKeyDown,
  onSubmit,
  onStop,
  onTranscribe,
  pending,
  stopping,
  placeholder,
}: ComposerProps) {
  const [menu, setMenu] = useState<"files" | "none" | "notes">("none");
  const [files, setFiles] = useState<string[]>([]);
  const [attachmentError, setAttachmentError] = useState("");

  const setDraft = useCallback(
    (value: string) => onChange(valueEvent(value)),
    [onChange]
  );

  const voice = useVoiceCapture({ draft, onTranscribe, setDraft });

  const openFiles = useCallback(async () => {
    if (menu === "files") {
      setMenu("none");
      return;
    }
    setMenu("files");
    try {
      setFiles((await listFiles?.()) ?? []);
    } catch {
      setFiles([]);
    }
  }, [listFiles, menu]);

  const mention = useCallback(
    (path: string) => {
      const spacer = draft.length > 0 && !draft.endsWith(" ") ? " " : "";
      setDraft(`${draft}${spacer}@${path} `);
      setMenu("none");
      document.getElementById("prompt")?.focus();
    },
    [draft, setDraft]
  );

  const toggleNotes = useCallback(
    () => setMenu((current) => (current === "notes" ? "none" : "notes")),
    []
  );

  const listening = voice.recording;

  const handleSubmit = useCallback(
    async (input: PromptInputMessage) => {
      const promptAttachments = input.files.map((file) => {
        if (!file.url.startsWith("data:")) {
          throw new Error(
            `Could not read ${file.filename ?? "an attachment"}.`
          );
        }
        if (file.filename && file.filename.length > 255) {
          setAttachmentError("A file name is too long to attach.");
          throw new Error("A file name is too long to attach.");
        }
        if (dataUrlSize(file.url) > MAX_ATTACHMENT_BYTES) {
          setAttachmentError(
            `${file.filename ?? "A file"} is larger than 4 MB.`
          );
          throw new Error(`${file.filename ?? "A file"} is larger than 4 MB.`);
        }
        return {
          data: file.url,
          filename: file.filename ?? "attachment",
          mediaType: file.mediaType || "application/octet-stream",
        };
      });
      const totalBytes = promptAttachments.reduce(
        (total, attachment) => total + dataUrlSize(attachment.data),
        0
      );
      if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
        setAttachmentError("Attachments must total 12 MB or less.");
        throw new Error("Attachments must total 12 MB or less.");
      }
      if (promptAttachments.length > MAX_ATTACHMENTS) {
        setAttachmentError(`Attach up to ${MAX_ATTACHMENTS} files.`);
        throw new Error(`Attach up to ${MAX_ATTACHMENTS} files.`);
      }
      if (!(input.text.trim() || promptAttachments.length) || busy || pending) {
        return;
      }
      setAttachmentError("");
      const sent = await onSubmit({
        attachments: promptAttachments,
        message: input.text.trim(),
      });
      if (!sent) {
        throw new Error("The message was not sent. Please try again.");
      }
    },
    [busy, onSubmit, pending]
  );

  const handleAttachmentError = useCallback(
    (error: {
      code: "max_files" | "max_file_size" | "accept";
      message: string;
    }) => setAttachmentError(error.message),
    []
  );
  const clearAttachmentError = useCallback(() => setAttachmentError(""), []);

  return (
    <PromptInput
      accept={ATTACHMENT_ACCEPT}
      className="composer"
      globalDrop
      maxFileSize={MAX_ATTACHMENT_BYTES}
      maxFiles={MAX_ATTACHMENTS}
      multiple
      onError={handleAttachmentError}
      onSubmit={handleSubmit}
    >
      <VoiceBeam
        active={listening}
        processing={voice.transcribing}
        strength={0.9}
        type="default"
      >
        <BorderBeam
          brightness={2}
          colorVariant="colorful"
          saturation={1.5}
          size="md"
          strength={1}
        >
          <div className="prompt">
            <PromptMenus files={files} menu={menu} onMention={mention} />

            <PromptAttachmentPreview />

            <PromptInputBody>
              <div className="prompt-top">
                {listFiles !== undefined && (
                  <button
                    aria-label="Mention a file from this project"
                    className="prompt-mention"
                    data-open={menu === "files" || undefined}
                    onClick={openFiles}
                    type="button"
                  >
                    @
                  </button>
                )}
                <label className="sr-only" htmlFor="prompt">
                  Message your CTO
                </label>
                <PromptInputTextarea
                  className="prompt-input"
                  id="prompt"
                  maxLength={limit}
                  onChange={onChange}
                  onKeyDown={onKeyDown}
                  placeholder={placeholder}
                  rows={1}
                  value={draft}
                />
              </div>
            </PromptInputBody>

            <PromptInputFooter className="prompt-bottom">
              <PromptInputTools className="prompt-chips">
                <span className="prompt-chip">Agent</span>
                <button
                  className="prompt-chip is-button"
                  onClick={toggleNotes}
                  type="button"
                >
                  {model}
                  <ChevronDown aria-hidden="true" size={13} />
                </button>
              </PromptInputTools>
              <PromptInputTools className="prompt-actions">
                <PromptAttachButton
                  busy={busy}
                  onErrorClear={clearAttachmentError}
                  pending={pending}
                />
                {voice.supported && (
                  <PromptInputButton
                    aria-label={
                      voice.recording ? "Stop recording" : "Speak your message"
                    }
                    className="prompt-mic"
                    data-recording={voice.recording || undefined}
                    disabled={voice.transcribing || pending}
                    onClick={voice.recording ? voice.stop : voice.start}
                    type="button"
                  >
                    {voice.recording ? <Square size={13} /> : <Mic size={15} />}
                  </PromptInputButton>
                )}
                <PromptSendButton
                  busy={busy}
                  draft={draft}
                  onStop={onStop}
                  pending={pending}
                  stopping={stopping}
                />
              </PromptInputTools>
            </PromptInputFooter>
          </div>
        </BorderBeam>
      </VoiceBeam>
      <div className="composer-foot">
        <ComposerHint
          error={attachmentError || voice.error}
          pending={pending}
          recording={voice.recording}
          transcribing={voice.transcribing}
        />
        {count > limit * 0.75 && (
          <span className="composer-count">
            {count.toLocaleString()} / {limit.toLocaleString()}
          </span>
        )}
      </div>
    </PromptInput>
  );
}
