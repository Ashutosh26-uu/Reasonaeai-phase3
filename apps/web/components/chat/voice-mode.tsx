"use client";

import {
  ArrowLeft,
  ArrowUp,
  Mic,
  Square,
  Volume2,
  VolumeX,
  Waves,
  X,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import styles from "./voice-mode.module.css";
import { recordVoice } from "./voice-recording";

export interface VoiceModeProps {
  busy: boolean;
  disabled?: boolean;
  onClose: () => void;
  onStop: () => void;
  onSubmit: (message: string) => Promise<boolean>;
  onSynthesize?: ((text: string) => Promise<Blob>) | undefined;
  onTranscribe: (audio: Blob) => Promise<string>;
  projectName: string;
  question?: ReactNode;
  response: { id: string; text: string } | null;
}

type CapturePhase =
  | "idle"
  | "permission"
  | "recording"
  | "transcribing"
  | "sending";

function voiceStatus(
  phase: CapturePhase,
  busy: boolean,
  speaking: boolean,
  blocked: boolean
) {
  if (blocked) {
    return "Your CTO needs your answer";
  }
  if (phase === "permission") {
    return "Allow microphone access to begin";
  }
  if (phase === "recording") {
    return "Listening to you";
  }
  if (phase === "transcribing") {
    return "Turning your voice into words";
  }
  if (phase === "sending" || busy) {
    return "Your CTO is working";
  }
  return speaking ? "Your CTO is speaking" : "Let’s talk through it";
}

/** A separate, turn-based voice surface using the same persisted conversation. */
export function VoiceMode({
  busy,
  disabled = false,
  onClose,
  onStop,
  onSubmit,
  onSynthesize,
  onTranscribe,
  projectName,
  question,
  response,
}: VoiceModeProps) {
  const [phase, setPhase] = useState<CapturePhase>("idle");
  const [draft, setDraft] = useState("");
  const [sentText, setSentText] = useState("");
  const [error, setError] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [readAloud, setReadAloud] = useState(true);
  const [localVoice, setLocalVoice] = useState<SpeechSynthesisVoice | null>(
    null
  );
  const [audioNotice, setAudioNotice] = useState("");
  const mounted = useRef<boolean>(false);
  const generation = useRef(0);
  const speechGeneration = useRef(0);
  const activeAudio = useRef<HTMLAudioElement | null>(null);
  const activeAudioUrl = useRef<string | null>(null);
  const capture = useRef<AbortController | null>(null);
  const finishCapture = useRef<(() => void) | null>(null);
  const speechTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const awaitingResponse = useRef(false);
  const turnSubmitting = useRef<boolean>(false);
  const lastResponseId = useRef(response?.id ?? null);
  const backButton = useRef<HTMLButtonElement>(null);
  const blocked = disabled || Boolean(question);
  const latest = useRef({
    blocked,
    busy,
    onSubmit,
    onSynthesize,
    onTranscribe,
  });
  latest.current = { blocked, busy, onSubmit, onSynthesize, onTranscribe };

  const isCurrent = useCallback(
    (operation: number) => mounted.current && operation === generation.current,
    []
  );

  const cancelSpeech = useCallback(() => {
    speechGeneration.current += 1;
    clearTimeout(speechTimer.current);
    if (activeAudio.current) {
      activeAudio.current.pause();
      activeAudio.current.src = "";
      activeAudio.current = null;
    }
    if (activeAudioUrl.current) {
      URL.revokeObjectURL(activeAudioUrl.current);
      activeAudioUrl.current = null;
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    if (mounted.current) {
      setSpeaking(false);
    }
  }, []);

  const cancelCapture = useCallback(() => {
    generation.current += 1;
    capture.current?.abort();
    capture.current = null;
    finishCapture.current = null;
    if (mounted.current) {
      setPhase("idle");
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    backButton.current?.focus();
    if ("speechSynthesis" in window) {
      const updateVoices = () => {
        const voices = window.speechSynthesis
          .getVoices()
          .filter((voice) => voice.localService);
        const [language] = navigator.language.split("-");
        setLocalVoice(
          voices.find((voice) => voice.lang.startsWith(language ?? "en")) ??
            voices[0] ??
            null
        );
      };
      updateVoices();
      window.speechSynthesis.addEventListener("voiceschanged", updateVoices);
      return () => {
        mounted.current = false;
        cancelCapture();
        cancelSpeech();
        window.speechSynthesis.removeEventListener(
          "voiceschanged",
          updateVoices
        );
      };
    }
    return () => {
      mounted.current = false;
      cancelCapture();
      cancelSpeech();
    };
  }, [cancelCapture, cancelSpeech]);

  const speakWithDeviceVoice = useCallback(
    (text: string) => {
      if (!localVoice) {
        return;
      }
      cancelSpeech();
      setAudioNotice("");
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.voice = localVoice;
      utterance.lang = localVoice.lang;
      utterance.onstart = () => {
        if (mounted.current) {
          setSpeaking(true);
        }
      };
      utterance.onend = () => {
        clearTimeout(speechTimer.current);
        if (mounted.current) {
          setSpeaking(false);
        }
      };
      utterance.onerror = (event) => {
        clearTimeout(speechTimer.current);
        if (
          mounted.current &&
          event.error !== "canceled" &&
          event.error !== "interrupted"
        ) {
          setSpeaking(false);
          setAudioNotice(
            "Your browser could not read this response aloud. You can read it below."
          );
        }
      };
      window.speechSynthesis.speak(utterance);
      speechTimer.current = setTimeout(() => {
        cancelSpeech();
        if (mounted.current) {
          setAudioNotice(
            "Reading paused after two minutes. The full response is below."
          );
        }
      }, 120_000);
    },
    [cancelSpeech, localVoice]
  );

  const playSynthesizedAudio = useCallback(
    async (audioBlob: Blob, text: string) => {
      const audioUrl = URL.createObjectURL(audioBlob);
      activeAudioUrl.current = audioUrl;

      const audio = new Audio(audioUrl);
      activeAudio.current = audio;

      const cleanup = () => {
        clearTimeout(speechTimer.current);
        if (activeAudioUrl.current) {
          URL.revokeObjectURL(activeAudioUrl.current);
          activeAudioUrl.current = null;
        }
        activeAudio.current = null;
      };

      audio.onended = () => {
        cleanup();
        if (mounted.current) {
          setSpeaking(false);
        }
      };

      audio.onerror = () => {
        cleanup();
        if (!mounted.current) {
          return;
        }
        setSpeaking(false);
        if (localVoice) {
          speakWithDeviceVoice(text);
        } else {
          setAudioNotice(
            "Could not play the spoken response. You can read it below."
          );
        }
      };

      speechTimer.current = setTimeout(() => {
        cancelSpeech();
        if (mounted.current) {
          setAudioNotice(
            "Reading paused after two minutes. The full response is below."
          );
        }
      }, 120_000);

      await audio.play();
    },
    [cancelSpeech, localVoice, speakWithDeviceVoice]
  );

  const synthesizeAndPlay = useCallback(
    async (text: string, currentOp: number): Promise<boolean> => {
      const synthesizeFn = latest.current.onSynthesize;
      if (!synthesizeFn) {
        return false;
      }
      try {
        if (mounted.current) {
          setSpeaking(true);
        }
        const audioBlob = await synthesizeFn(text);
        if (!mounted.current || speechGeneration.current !== currentOp) {
          return true;
        }
        await playSynthesizedAudio(audioBlob, text);
        return true;
      } catch {
        return false;
      }
    },
    [playSynthesizedAudio]
  );

  const speak = useCallback(
    async (text: string) => {
      if (!readAloud) {
        return;
      }
      cancelSpeech();
      setAudioNotice("");
      const currentOp = speechGeneration.current;

      const played = await synthesizeAndPlay(text, currentOp);
      if (
        played ||
        !mounted.current ||
        speechGeneration.current !== currentOp
      ) {
        return;
      }

      if (localVoice) {
        speakWithDeviceVoice(text);
        return;
      }

      setSpeaking(false);
      setAudioNotice(
        "Spoken responses are currently unavailable. You can read the response below."
      );
    },
    [
      cancelSpeech,
      localVoice,
      readAloud,
      speakWithDeviceVoice,
      synthesizeAndPlay,
    ]
  );

  useEffect(() => {
    if (
      busy ||
      !response ||
      response.id === lastResponseId.current ||
      !awaitingResponse.current
    ) {
      return;
    }
    awaitingResponse.current = false;
    lastResponseId.current = response.id;
    if (readAloud && response.text.trim()) {
      speak(response.text);
    }
  }, [busy, readAloud, response, speak]);

  const start = useCallback(async () => {
    if (
      capture.current ||
      phase !== "idle" ||
      latest.current.busy ||
      latest.current.blocked
    ) {
      return;
    }
    cancelSpeech();
    setError("");
    setAudioNotice("");
    setDraft("");
    setPhase("permission");
    generation.current += 1;
    const operation = generation.current;
    const controller = new AbortController();
    capture.current = controller;
    try {
      const audio = await recordVoice({
        onReady: (finishRecording) => {
          if (isCurrent(operation)) {
            finishCapture.current = finishRecording;
            setPhase("recording");
          }
        },
        signal: controller.signal,
      });
      if (!(audio && isCurrent(operation))) {
        return;
      }
      finishCapture.current = null;
      setPhase("transcribing");
      const text = (await latest.current.onTranscribe(audio)).trim();
      if (!isCurrent(operation)) {
        return;
      }
      if (!text) {
        throw new Error(
          "No words were detected. Try again or return to text chat."
        );
      }
      setDraft(text);
    } catch (cause) {
      if (isCurrent(operation)) {
        setError(
          describeVoiceError(cause, "Could not transcribe that recording.")
        );
      }
    } finally {
      if (isCurrent(operation)) {
        capture.current = null;
        finishCapture.current = null;
        setPhase("idle");
      }
    }
  }, [cancelSpeech, isCurrent, phase]);

  const finish = useCallback(() => {
    finishCapture.current?.();
    finishCapture.current = null;
    setPhase("transcribing");
  }, []);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (
      !text ||
      phase !== "idle" ||
      latest.current.busy ||
      latest.current.blocked ||
      turnSubmitting.current
    ) {
      return;
    }
    if (text.length > 20_000) {
      setError(
        "Your message is too long. Shorten it to 20,000 characters before sending."
      );
      return;
    }
    turnSubmitting.current = true;
    setError("");
    setPhase("sending");
    cancelSpeech();
    generation.current += 1;
    const operation = generation.current;
    lastResponseId.current = response?.id ?? null;
    awaitingResponse.current = true;
    try {
      const accepted = await latest.current.onSubmit(text);
      if (!isCurrent(operation)) {
        return;
      }
      if (!accepted) {
        awaitingResponse.current = false;
        throw new Error("Your message was not sent. Review it and try again.");
      }
      setSentText(text);
      setDraft("");
    } catch (cause) {
      awaitingResponse.current = false;
      if (isCurrent(operation)) {
        setError(describeVoiceError(cause, "Could not send your message."));
      }
    } finally {
      turnSubmitting.current = false;
      if (isCurrent(operation)) {
        setPhase("idle");
      }
    }
  }, [cancelSpeech, draft, isCurrent, phase, response?.id]);

  const close = useCallback(() => {
    cancelCapture();
    cancelSpeech();
    onClose();
  }, [cancelCapture, cancelSpeech, onClose]);
  const toggleAudio = useCallback(() => {
    cancelSpeech();
    setReadAloud((enabled) => !enabled);
  }, [cancelSpeech]);
  const stopRun = useCallback(() => {
    awaitingResponse.current = false;
    cancelSpeech();
    onStop();
  }, [cancelSpeech, onStop]);
  const replay = useCallback(() => {
    if (response) {
      speak(response.text);
    }
  }, [response, speak]);
  const changeDraft = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) =>
      setDraft(event.currentTarget.value),
    []
  );
  const discardDraft = useCallback(() => setDraft(""), []);
  const status = voiceStatus(phase, busy, speaking, blocked);
  const activeCapture =
    phase === "recording" || phase === "permission" || phase === "transcribing";

  return (
    <section
      aria-label="Voice chat"
      className={styles.surface}
      data-state={getVisualState(phase, busy, speaking)}
    >
      <header className={styles.header}>
        <button
          className={styles.back}
          onClick={close}
          ref={backButton}
          type="button"
        >
          <ArrowLeft aria-hidden="true" size={17} />
          <span>Back to chat</span>
        </button>
        <span className={styles.project}>{projectName}</span>
        <button
          aria-label={
            readAloud ? "Mute spoken responses" : "Enable spoken responses"
          }
          aria-pressed={readAloud}
          className={styles.audioToggle}
          disabled={!(localVoice || onSynthesize)}
          onClick={toggleAudio}
          type="button"
        >
          {readAloud && (localVoice || onSynthesize) ? (
            <Volume2 aria-hidden="true" size={18} />
          ) : (
            <VolumeX aria-hidden="true" size={18} />
          )}
        </button>
      </header>
      <div className={styles.body}>
        <div className={styles.identity}>
          <Waves aria-hidden="true" size={15} /> Voice chat with your CTO
        </div>
        <div aria-hidden="true" className={styles.orb}>
          <div className={styles.orbCore} />
          <div className={styles.orbRing} />
        </div>
        <h1 aria-live="polite" className={styles.title}>
          {status}
        </h1>
        <p className={styles.description} role="status">
          {captureDescription(phase, draft)}
        </p>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {audioNotice && (
          <p className={styles.notice} role="status">
            {audioNotice}
          </p>
        )}
        {question && <div className={styles.question}>{question}</div>}
        {draft && (
          <div className={styles.review}>
            <label htmlFor="voice-draft">You said</label>
            <textarea
              disabled={phase === "sending"}
              id="voice-draft"
              maxLength={20_000}
              onChange={changeDraft}
              rows={3}
              value={draft}
            />
            <button
              className={styles.send}
              disabled={busy || blocked || phase !== "idle" || !draft.trim()}
              onClick={send}
              type="button"
            >
              <ArrowUp aria-hidden="true" size={16} /> Send message
            </button>
          </div>
        )}
        <VoiceResponse
          activeCapture={activeCapture}
          cancelSpeech={cancelSpeech}
          hasVoiceCapability={Boolean(localVoice || onSynthesize)}
          replay={replay}
          response={response}
          sentText={sentText}
          speaking={speaking}
        />
      </div>
      <VoiceControls
        activeCapture={activeCapture}
        busy={busy}
        cancelCapture={cancelCapture}
        canRecord={phase === "idle" && !busy && !blocked && !draft}
        discardDraft={discardDraft}
        draft={draft}
        finish={finish}
        hasLocalVoice={Boolean(localVoice)}
        hasSynthesizer={Boolean(onSynthesize)}
        onStop={stopRun}
        phase={phase}
        start={start}
      />
    </section>
  );
}

function VoiceResponse({
  activeCapture,
  cancelSpeech,
  hasVoiceCapability,
  replay,
  response,
  sentText,
  speaking,
}: {
  activeCapture: boolean;
  cancelSpeech: () => void;
  hasVoiceCapability: boolean;
  replay: () => void;
  response: VoiceModeProps["response"];
  sentText: string;
  speaking: boolean;
}) {
  return (
    <>
      {sentText && (
        <div className={styles.sent}>
          <span>You</span>
          <p>{sentText}</p>
        </div>
      )}
      {response?.text && (
        <div className={styles.response}>
          <div className={styles.responseHeader}>
            <span>Your CTO</span>
            {hasVoiceCapability && (
              <button
                aria-label={
                  speaking ? "Stop spoken response" : "Read response aloud"
                }
                disabled={activeCapture}
                onClick={speaking ? cancelSpeech : replay}
                type="button"
              >
                {speaking ? (
                  <Square aria-hidden="true" size={13} />
                ) : (
                  <Volume2 aria-hidden="true" size={15} />
                )}
              </button>
            )}
          </div>
          <p>{response.text}</p>
        </div>
      )}
    </>
  );
}

function VoiceControls({
  activeCapture,
  busy,
  canRecord,
  cancelCapture,
  discardDraft,
  draft,
  finish,
  hasLocalVoice,
  hasSynthesizer,
  onStop,
  phase,
  start,
}: {
  activeCapture: boolean;
  busy: boolean;
  canRecord: boolean;
  cancelCapture: () => void;
  discardDraft: () => void;
  draft: string;
  finish: () => void;
  hasLocalVoice: boolean;
  hasSynthesizer?: boolean;
  onStop: () => void;
  phase: CapturePhase;
  start: () => void;
}) {
  return (
    <footer className={styles.footer}>
      <div className={styles.controls}>
        {phase === "recording" ? (
          <button className={styles.primary} onClick={finish} type="button">
            <Square aria-hidden="true" size={16} /> Finish speaking
          </button>
        ) : (
          <button
            className={styles.primary}
            disabled={!canRecord}
            onClick={start}
            type="button"
          >
            <Mic aria-hidden="true" size={19} /> Start speaking
          </button>
        )}
        {activeCapture && (
          <button
            className={styles.secondary}
            onClick={cancelCapture}
            type="button"
          >
            <X aria-hidden="true" size={16} /> Cancel
          </button>
        )}
        {busy && (
          <button className={styles.secondary} onClick={onStop} type="button">
            <Square aria-hidden="true" size={13} /> Stop run
          </button>
        )}
        {draft && phase !== "sending" && (
          <button
            className={styles.secondary}
            onClick={discardDraft}
            type="button"
          >
            Record again
          </button>
        )}
      </div>
      <p className={styles.audioNote}>
        {getAudioNote(hasSynthesizer, hasLocalVoice)}
      </p>
    </footer>
  );
}

function getAudioNote(
  hasSynthesizer: boolean | undefined,
  hasLocalVoice: boolean | undefined
): string {
  if (hasSynthesizer) {
    return "Responses are spoken aloud.";
  }
  if (hasLocalVoice) {
    return "Responses use a voice on your device.";
  }
  return "A device voice is unavailable. Responses appear here as text.";
}

function getVisualState(phase: CapturePhase, busy: boolean, speaking: boolean) {
  if (phase === "recording") {
    return "listening";
  }
  if (speaking) {
    return "speaking";
  }
  return busy || phase === "transcribing" || phase === "sending"
    ? "working"
    : "idle";
}
function captureDescription(phase: CapturePhase, draft: string) {
  if (phase === "recording") {
    return "Finish when you’re done. Recordings stop after two minutes.";
  }
  return draft
    ? "Review your words, then send them to your CTO."
    : "Speak at your own pace. Your conversation stays in this chat.";
}

function describeVoiceError(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}
