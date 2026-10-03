"use client";

import type { ProjectSummary } from "@reasonateai/contracts/auth";
import type { PromptAttachment } from "@reasonateai/contracts/execution";
import { BorderBeam } from "border-beam";
import {
  ArrowUp,
  AudioLines,
  Check,
  ChevronDown,
  CornerDownLeft,
  Folder,
  FolderPlus,
  Mic,
  Plus,
  Search,
  Square,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
import styles from "./composer.module.css";

/**
 * What the line under the card says: an error, what the microphone is doing, or
 * what the keyboard does.
 */
function ComposerHint({
  error,
  pending,
  projectSelected,
  recording,
  transcribing,
}: {
  error: string;
  pending: boolean;
  projectSelected: boolean;
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
  if (!projectSelected) {
    return <span>Choose a project to start a conversation.</span>;
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
  fileStatus,
  menu,
  onMention,
  onRetryFiles,
}: {
  files: string[];
  fileStatus: "idle" | "loading" | "error";
  menu: "files" | "none" | "notes";
  onMention: (path: string) => void;
  onRetryFiles: () => void;
}) {
  if (menu === "files") {
    if (fileStatus !== "idle") {
      return (
        <div aria-live="polite" className="prompt-menu">
          <p className="prompt-menu-note">
            {fileStatus === "loading"
              ? "Loading project files…"
              : "Could not load project files. Try again."}
          </p>
          {fileStatus === "error" && (
            <button
              className="prompt-menu-item"
              onClick={onRetryFiles}
              type="button"
            >
              Retry
            </button>
          )}
        </div>
      );
    }
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
  hasConversation?: boolean;
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
  onCreateProject: (name: string) => Promise<boolean>;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onProjectSelect: (projectId: string) => void;
  /** Sends text guidance into the active run through the authorized API. */
  onSteer?: (input: {
    attachments: PromptAttachment[];
    message: string;
  }) => Promise<boolean>;
  /** Stops the active CTO run while its response is streaming. */
  onStop: () => void;
  onSubmit: (input: {
    attachments: PromptAttachment[];
    message: string;
  }) => Promise<boolean>;
  /** Turns recorded audio into text, or reports why it cannot. */
  onTranscribe: (audio: Blob) => Promise<string>;
  /** Opens the separate voice conversation surface. */
  onVoiceMode?: () => void;
  pending: boolean;
  placeholder: string;
  projectId: string;
  projectPickerDisabled: boolean;
  projects: ProjectSummary[];
  stopping: boolean;
}

function ProjectPicker({
  disabled,
  onCreateProject,
  onSelect,
  projectId,
  projects,
}: {
  disabled: boolean;
  onCreateProject: (name: string) => Promise<boolean>;
  onSelect: (projectId: string) => void;
  projectId: string;
  projects: ProjectSummary[];
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [position, setPosition] = useState({ bottom: 0, left: 0 });
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuRoot = useRef<HTMLDivElement>(null);
  const activeProject = projects.find((item) => item.projectId === projectId);
  const shown = projects.filter((item) =>
    item.name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    const rect = trigger.current?.getBoundingClientRect();
    if (rect) {
      setPosition({
        bottom: window.innerHeight - rect.top + 8,
        left: Math.max(12, Math.min(rect.left, window.innerWidth - 372)),
      });
    }
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !(root.current?.contains(target) || menuRoot.current?.contains(target))
      ) {
        setOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  const choose = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      onSelect(event.currentTarget.value);
      setOpen(false);
      setCreating(false);
      setFilter("");
    },
    [onSelect]
  );

  const create = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = name.trim();
      if (!trimmed || disabled) {
        return;
      }
      if (await onCreateProject(trimmed)) {
        setName("");
        setCreating(false);
        setOpen(false);
      }
    },
    [disabled, name, onCreateProject]
  );
  const toggleOpen = useCallback(() => setOpen((value) => !value), []);
  const changeFilter = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setFilter(event.currentTarget.value),
    []
  );
  const changeName = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setName(event.currentTarget.value),
    []
  );
  const beginCreate = useCallback(() => setCreating(true), []);
  const cancelCreate = useCallback(() => {
    setName("");
    setCreating(false);
  }, []);
  const closePicker = useCallback(() => {
    setOpen(false);
    setCreating(false);
    setName("");
  }, []);

  return (
    <div className="project-picker" ref={root}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        className="prompt-chip is-button project-picker-trigger"
        disabled={disabled}
        onClick={toggleOpen}
        ref={trigger}
        type="button"
      >
        <Folder aria-hidden="true" size={15} />
        <span>{activeProject?.name ?? "No project"}</span>
        <ChevronDown aria-hidden="true" size={13} />
      </button>
      {open &&
        createPortal(
          <div
            className="project-picker-menu"
            ref={menuRoot}
            style={{ bottom: position.bottom, left: position.left }}
          >
            <div className="project-picker-search-row">
              <label className="project-picker-search">
                <Search aria-hidden="true" size={15} />
                <input
                  aria-label="Search projects"
                  autoFocus
                  onChange={changeFilter}
                  placeholder="Search projects"
                  value={filter}
                />
              </label>
              <button
                aria-label="Close project picker"
                className="project-picker-close"
                onClick={closePicker}
                type="button"
              >
                <X aria-hidden="true" size={17} />
              </button>
            </div>
            {creating ? (
              <form className="project-picker-create" onSubmit={create}>
                <input
                  aria-label="New project name"
                  autoFocus
                  maxLength={120}
                  onChange={changeName}
                  placeholder="Project name"
                  value={name}
                />
                <button
                  aria-label="Create project"
                  disabled={!name.trim() || disabled}
                  type="submit"
                >
                  <Check aria-hidden="true" size={16} />
                </button>
                <button
                  aria-label="Cancel project creation"
                  onClick={cancelCreate}
                  type="button"
                >
                  <X aria-hidden="true" size={16} />
                </button>
              </form>
            ) : (
              <button
                className="project-picker-option"
                disabled={disabled}
                onClick={beginCreate}
                type="button"
              >
                <FolderPlus aria-hidden="true" size={16} />
                <span>New project</span>
              </button>
            )}
            <div
              aria-label="Projects"
              className="project-picker-list"
              role="listbox"
            >
              {shown.map((project) => (
                <button
                  aria-selected={project.projectId === projectId}
                  className="project-picker-option"
                  key={project.projectId}
                  onClick={choose}
                  role="option"
                  type="button"
                  value={project.projectId}
                >
                  <Folder aria-hidden="true" size={16} />
                  <span>{project.name}</span>
                  {project.projectId === projectId && (
                    <Check aria-hidden="true" size={16} />
                  )}
                </button>
              ))}
              {shown.length === 0 && (
                <p className="project-picker-empty">No matching projects</p>
              )}
            </div>
            <button
              className="project-picker-option project-picker-none"
              onClick={choose}
              type="button"
              value=""
            >
              <X aria-hidden="true" size={16} />
              <span>Don’t work in a project</span>
              {!projectId && <Check aria-hidden="true" size={16} />}
            </button>
          </div>,
          document.body
        )}
    </div>
  );
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
      className={`prompt-mic ${styles.attach}`}
      disabled={busy || pending}
      onClick={open}
    >
      <Plus aria-hidden="true" size={20} />
    </PromptInputButton>
  );
}

function PromptQueueButton({ disabled }: { disabled: boolean }) {
  const queue = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.currentTarget.form?.requestSubmit();
  }, []);
  return (
    <PromptInputButton
      className={styles.queueButton}
      disabled={disabled}
      onClick={queue}
      type="button"
    >
      <CornerDownLeft aria-hidden="true" size={14} />
      Queue
    </PromptInputButton>
  );
}

function PromptPrimaryAction({
  hasConversation,
  draft,
  busy,
  pending,
  stopping,
  voiceBusy,
  onStop,
  onVoiceMode,
}: {
  hasConversation: boolean;
  draft: string;
  busy: boolean;
  pending: boolean;
  stopping: boolean;
  voiceBusy: boolean;
  onStop: () => void;
  onVoiceMode: (() => void) | undefined;
}) {
  const { files } = usePromptInputAttachments();
  if (
    !(hasConversation || draft.trim() || files.length || pending || busy) &&
    onVoiceMode
  ) {
    return (
      <PromptInputButton
        aria-label="Open voice mode"
        className={`prompt-send ${styles.voiceMode}`}
        disabled={voiceBusy}
        onClick={onVoiceMode}
        title="Voice mode"
        type="button"
      >
        <AudioLines aria-hidden="true" size={20} />
      </PromptInputButton>
    );
  }
  return (
    <PromptSendButton
      busy={busy}
      draft={draft}
      onStop={onStop}
      pending={pending}
      stopping={stopping}
    />
  );
}

interface QueuedMessage {
  message: string;
  projectId: string;
}

function queueValidationError(
  input: PromptInputMessage,
  projectId: string,
  queued: QueuedMessage | null
) {
  if (!projectId) {
    return "Choose a project before queuing a message.";
  }
  if (input.files.length > 0) {
    return "Attachments can be sent after the run finishes. Remove them to queue text guidance.";
  }
  if (queued) {
    return "A message is already queued. Edit, steer, or remove it first.";
  }
  return input.text.trim() ? "" : "Write a message to queue.";
}

function QueuedMessageRow({
  queued,
  pending,
  sending,
  error,
  steerDisabled,
  onSend,
  onEdit,
  onRemove,
}: {
  queued: QueuedMessage;
  pending: boolean;
  sending: boolean;
  error: string;
  steerDisabled: boolean;
  onSend: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  let label = pending ? "Queued for after this turn" : "Ready to send";
  if (sending) {
    label = "Sending…";
  }
  return (
    <fieldset aria-label="Queued message" className={styles.queued}>
      <div className={styles.queuedText}>
        <span>{label}</span>
        <p title={queued.message}>{queued.message}</p>
        {error && <p role="alert">{error}</p>}
      </div>
      <div className={styles.queuedActions}>
        <button disabled={steerDisabled} onClick={onSend} type="button">
          {pending ? "Steer" : "Send now"}
        </button>
        <button disabled={sending} onClick={onEdit} type="button">
          Edit
        </button>
        <button
          aria-label="Remove queued message"
          disabled={sending}
          onClick={onRemove}
          type="button"
        >
          <X aria-hidden="true" size={14} />
        </button>
      </div>
    </fieldset>
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
  const { start: startMicrophone, stop: stopMicrophone } = mic;
  const [recording, setRecording] = useState(false);
  const [starting, setStarting] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const latest = useRef(input);
  const mounted = useRef<boolean>(false);
  const requesting = useRef<boolean>(false);
  latest.current = input;

  const stop = useCallback(() => {
    if (recorder.current?.state !== "inactive") {
      recorder.current?.stop();
    }
    stopMicrophone();
    setRecording(false);
  }, [stopMicrophone]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const active = recorder.current;
      if (active) {
        active.ondataavailable = null;
        active.onstop = null;
        active.onerror = null;
        if (active.state !== "inactive") {
          active.stop();
        }
        for (const track of active.stream.getTracks()) {
          track.stop();
        }
      }
      recorder.current = null;
      chunks.current = [];
      stopMicrophone();
    };
  }, [stopMicrophone]);

  useEffect(() => {
    if (!recording) {
      return;
    }
    // A recording that nobody stops must not run forever.
    const timer = setTimeout(stop, MAX_RECORDING_MS);
    return () => clearTimeout(timer);
  }, [recording, stop]);

  const start = useCallback(async () => {
    if (requesting.current || recorder.current?.state === "recording") {
      return;
    }
    setError("");
    if (typeof MediaRecorder === "undefined") {
      setError("This browser does not support audio recording.");
      return;
    }
    requesting.current = true;
    setStarting(true);
    const stream = await startMicrophone();
    requesting.current = false;
    if (!mounted.current) {
      for (const track of stream?.getTracks() ?? []) {
        track.stop();
      }
      return;
    }
    setStarting(false);
    if (stream === null) {
      setError(
        "The microphone is unavailable. Check the browser's permission for this site."
      );
      return;
    }

    try {
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
      created.onerror = () => {
        chunks.current = [];
        created.onstop = null;
        stop();
        setError(
          "Could not record audio. Check your microphone and try again."
        );
      };
      created.onstop = () => {
        recorder.current = null;
        stopMicrophone();
        setRecording(false);
        const blob = new Blob(chunks.current, {
          type: created.mimeType || "audio/webm",
        });
        chunks.current = [];
        if (blob.size === 0) {
          setError("No audio was recorded. Please try again.");
          return;
        }
        setTranscribing(true);
        latest.current
          .onTranscribe(blob)
          .then((text) => {
            if (mounted.current && text.length > 0) {
              const { draft, setDraft } = latest.current;
              setDraft(draft.length > 0 ? `${draft} ${text}` : text);
            }
          })
          .catch((cause: unknown) => {
            if (mounted.current) {
              setError(
                cause instanceof Error
                  ? cause.message
                  : "Could not transcribe that recording."
              );
            }
          })
          .finally(() => {
            if (mounted.current) {
              setTranscribing(false);
            }
          });
      };
      recorder.current = created;
      created.start();
      setRecording(true);
    } catch {
      recorder.current = null;
      stopMicrophone();
      setError("Could not start audio recording. Please try another browser.");
    }
  }, [startMicrophone, stop, stopMicrophone]);

  return {
    error,
    recording,
    start,
    starting,
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
          {files.length === 0
            ? "This project has no checkpoint files to mention yet."
            : "No files match your search."}
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
  hasConversation = false,
  busy,
  count,
  draft,
  limit,
  listFiles,
  model,
  onCreateProject,
  onProjectSelect,
  projectId,
  projectPickerDisabled,
  projects,
  onChange,
  onKeyDown,
  onSubmit,
  onSteer,
  onStop,
  onTranscribe,
  onVoiceMode,
  pending,
  stopping,
  placeholder,
}: ComposerProps) {
  const [menu, setMenu] = useState<"files" | "none" | "notes">("none");
  const [files, setFiles] = useState<string[]>([]);
  const [fileStatus, setFileStatus] = useState<"idle" | "loading" | "error">(
    "idle"
  );
  const [attachmentError, setAttachmentError] = useState("");
  const [queued, setQueued] = useState<QueuedMessage | null>(null);
  const [queueError, setQueueError] = useState("");
  const [dispatching, setDispatching] = useState(false);
  const queuedRef = useRef<QueuedMessage | null>(null);
  const autoAttempted = useRef<QueuedMessage | null>(null);
  const dispatchingRef = useRef<boolean>(false);
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const root = useRef<HTMLDivElement>(null);

  const setDraft = useCallback(
    (value: string) => onChange(valueEvent(value)),
    [onChange]
  );

  const voice = useVoiceCapture({ draft, onTranscribe, setDraft });

  const updateQueue = useCallback((message: QueuedMessage | null) => {
    autoAttempted.current = null;
    queuedRef.current = message;
    setQueued(message);
  }, []);

  const dispatchQueue = useCallback(async () => {
    const message = queuedRef.current;
    if (!message || dispatchingRef.current || busy) {
      return;
    }
    if (message.projectId !== projectId) {
      setQueueError("Return to the queued message’s project to send it.");
      return;
    }
    const send = pending ? onSteer : onSubmit;
    if (!send) {
      setQueueError(
        "Steering is unavailable. This message will send when the run finishes."
      );
      return;
    }
    dispatchingRef.current = true;
    setDispatching(true);
    setQueueError("");
    try {
      const sent = await send({ attachments: [], message: message.message });
      if (!sent) {
        throw new Error("The queued message was not sent. Try again.");
      }
      updateQueue(null);
      // The parent may clear its draft after sending; keep newer writing intact.
      setDraft(latestDraft.current);
    } catch (cause) {
      setQueueError(
        cause instanceof Error
          ? cause.message
          : "Could not send the queued message. Try again."
      );
    } finally {
      dispatchingRef.current = false;
      setDispatching(false);
    }
  }, [busy, onSteer, onSubmit, pending, projectId, setDraft, updateQueue]);

  useEffect(() => {
    if (
      queued &&
      !pending &&
      !busy &&
      !dispatching &&
      autoAttempted.current !== queued
    ) {
      autoAttempted.current = queued;
      dispatchQueue();
    }
  }, [busy, dispatching, dispatchQueue, pending, queued]);

  const removeQueued = useCallback(() => {
    updateQueue(null);
    setQueueError("");
  }, [updateQueue]);

  const editQueued = useCallback(() => {
    if (!queued) {
      return;
    }
    const restored = [queued.message, draft].filter(Boolean).join("\n\n");
    if (restored.length > limit) {
      setQueueError(
        "Finish your current draft before editing this queued message."
      );
      return;
    }
    setDraft(restored);
    removeQueued();
    document.getElementById("prompt")?.focus();
  }, [draft, limit, queued, removeQueued, setDraft]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing) {
        return;
      }
      if (pending && event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        event.currentTarget.form?.requestSubmit();
        return;
      }
      onKeyDown(event);
    },
    [onKeyDown, pending]
  );

  useEffect(() => {
    if (menu === "none") {
      return;
    }
    const dismiss = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !root.current?.contains(event.target)
      ) {
        setMenu("none");
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenu("none");
        document.getElementById("prompt")?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [menu]);

  const loadFiles = useCallback(async () => {
    setFileStatus("loading");
    try {
      setFiles((await listFiles?.()) ?? []);
      setFileStatus("idle");
    } catch {
      setFileStatus("error");
    }
  }, [listFiles]);

  const openFiles = useCallback(() => {
    if (menu === "files") {
      setMenu("none");
      return;
    }
    setMenu("files");
    loadFiles();
  }, [loadFiles, menu]);

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
      if (busy || dispatchingRef.current) {
        throw new Error("Wait for the current request to finish.");
      }
      if (pending) {
        const error = queueValidationError(input, projectId, queuedRef.current);
        if (error) {
          setAttachmentError(error);
          throw new Error(error);
        }
        updateQueue({ message: input.text.trim(), projectId });
        setQueueError("");
        setAttachmentError("");
        setDraft("");
        return;
      }
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
      if (!(input.text.trim() || promptAttachments.length)) {
        throw new Error("Write a message or attach a file.");
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
    [busy, onSubmit, pending, projectId, setDraft, updateQueue]
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
    <div className={styles.shell} ref={root}>
      <PromptInput
        accept={ATTACHMENT_ACCEPT}
        className={`composer ${styles.compact}`}
        globalDrop
        maxFileSize={MAX_ATTACHMENT_BYTES}
        maxFiles={MAX_ATTACHMENTS}
        multiple
        onError={handleAttachmentError}
        onSubmit={handleSubmit}
      >
        <PromptMenus
          fileStatus={fileStatus}
          files={files}
          menu={menu}
          onMention={mention}
          onRetryFiles={loadFiles}
        />
        {queued && (
          <QueuedMessageRow
            error={queueError}
            onEdit={editQueued}
            onRemove={removeQueued}
            onSend={dispatchQueue}
            pending={pending}
            queued={queued}
            sending={dispatching}
            steerDisabled={
              busy || dispatching || stopping || (pending && !onSteer)
            }
          />
        )}
        <VoiceBeam
          active={listening}
          processing={voice.transcribing}
          strength={0.9}
          type="default"
        >
          <BorderBeam
            brightness={2}
            className={styles.beam ?? ""}
            colorVariant="colorful"
            saturation={1.5}
            size="md"
            strength={1}
          >
            <div className={`prompt ${styles.surface}`}>
              <PromptAttachmentPreview />

              <PromptInputBody>
                <div className={`prompt-top ${styles.textRow}`}>
                  <label className="sr-only" htmlFor="prompt">
                    Message your CTO
                  </label>
                  <PromptInputTextarea
                    aria-describedby="composer-hint"
                    className={`prompt-input ${styles.input}`}
                    id="prompt"
                    maxLength={limit}
                    onChange={onChange}
                    onKeyDown={handleKeyDown}
                    placeholder={placeholder}
                    rows={1}
                    value={draft}
                  />
                </div>
              </PromptInputBody>

              <PromptInputFooter className={`prompt-bottom ${styles.toolbar}`}>
                <PromptInputTools>
                  <PromptAttachButton
                    busy={busy}
                    onErrorClear={clearAttachmentError}
                    pending={pending}
                  />
                  {pending && projectId && draft.trim() && (
                    <PromptQueueButton
                      disabled={busy || dispatching || queued !== null}
                    />
                  )}
                </PromptInputTools>
                <PromptInputTools
                  className={`prompt-actions ${styles.actions}`}
                >
                  <button
                    aria-expanded={menu === "notes"}
                    aria-label={`Model information: ${model}`}
                    className={`prompt-chip is-button ${styles.model}`}
                    onClick={toggleNotes}
                    title={model}
                    type="button"
                  >
                    <span>{model}</span>
                    <ChevronDown aria-hidden="true" size={13} />
                  </button>
                  <PromptInputButton
                    aria-label={
                      voice.recording ? "Stop recording" : "Speak your message"
                    }
                    aria-pressed={voice.recording}
                    className={`prompt-mic ${styles.microphone}`}
                    data-recording={voice.recording || undefined}
                    disabled={
                      !voice.supported ||
                      voice.starting ||
                      voice.transcribing ||
                      (!voice.recording && (busy || pending))
                    }
                    onClick={voice.recording ? voice.stop : voice.start}
                    title={
                      voice.supported
                        ? "Dictate a message"
                        : "Microphone unavailable in this browser"
                    }
                    type="button"
                  >
                    {voice.recording ? (
                      <Square aria-hidden="true" size={13} />
                    ) : (
                      <Mic aria-hidden="true" size={18} />
                    )}
                  </PromptInputButton>
                  <PromptPrimaryAction
                    busy={busy}
                    draft={draft}
                    hasConversation={hasConversation}
                    onStop={onStop}
                    onVoiceMode={onVoiceMode}
                    pending={pending}
                    stopping={stopping}
                    voiceBusy={
                      voice.recording || voice.starting || voice.transcribing
                    }
                  />
                </PromptInputTools>
              </PromptInputFooter>
            </div>
          </BorderBeam>
        </VoiceBeam>
        <div className={styles.context}>
          <ProjectPicker
            disabled={projectPickerDisabled || queued !== null || dispatching}
            onCreateProject={onCreateProject}
            onSelect={onProjectSelect}
            projectId={projectId}
            projects={projects}
          />
          {listFiles !== undefined && (
            <button
              aria-expanded={menu === "files"}
              aria-label="Mention a file from this project"
              className={`prompt-chip is-button ${styles.files}`}
              data-open={menu === "files" || undefined}
              onClick={openFiles}
              type="button"
            >
              <span aria-hidden="true">@</span>
              Files
            </button>
          )}
        </div>
        <div
          aria-live="polite"
          className={`composer-foot ${styles.hint}`}
          id="composer-hint"
        >
          <ComposerHint
            error={attachmentError || voice.error}
            pending={pending}
            projectSelected={projectId.length > 0}
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
    </div>
  );
}
