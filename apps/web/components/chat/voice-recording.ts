/** Browser capture is bounded and discarded when its owner leaves voice mode. */
export const MAX_VOICE_RECORDING_MS = 120_000;
const MAX_VOICE_RECORDING_BYTES = 8 * 1024 * 1024;
const AUDIO_TYPES = [
  "audio/webm;codecs=opus",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

export interface VoiceRecorder {
  mimeType: string;
  ondataavailable: ((event: BlobEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onstop: ((event: Event) => void) | null;
  start: (timeslice: number) => void;
  state: string;
  stop: () => void;
}

export interface VoiceRecordingBrowser {
  open: (
    mimeType: string
  ) => Promise<{ recorder: VoiceRecorder; release: () => void }>;
  supportsType: (type: string) => boolean;
}

function browserCapture(): VoiceRecordingBrowser {
  if (!(navigator.mediaDevices && typeof MediaRecorder !== "undefined")) {
    throw new Error(
      "Voice recording is unavailable in this browser. Use text chat instead."
    );
  }
  return {
    open: async (mimeType) => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const release = () => {
        for (const track of stream.getTracks()) {
          track.stop();
        }
      };
      try {
        return { recorder: new MediaRecorder(stream, { mimeType }), release };
      } catch (cause) {
        release();
        throw cause;
      }
    },
    supportsType: (type) => MediaRecorder.isTypeSupported(type),
  };
}

/**
 * Finishing returns the real recording; cancellation never returns audio.
 * Permission requests cannot be aborted by browsers, so a late stream is closed.
 */
export function recordVoice(input: {
  browser?: VoiceRecordingBrowser;
  onReady: (finish: () => void) => void;
  signal: AbortSignal;
}): Promise<Blob | null> {
  return new Promise((resolve, reject) => {
    let releaseStream: (() => void) | null = null;
    let recorder: VoiceRecorder | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let bytes = 0;
    const chunks: Blob[] = [];

    const release = () => {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", cancel);
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onerror = null;
        recorder.onstop = null;
        if (recorder.state !== "inactive") {
          recorder.stop();
        }
      }
      releaseStream?.();
      chunks.length = 0;
    };
    const finishWith = (result: Blob | Error | null) => {
      if (settled) {
        return;
      }
      settled = true;
      release();
      if (result instanceof Error) {
        reject(result);
      } else {
        resolve(result);
      }
    };
    function cancel() {
      finishWith(null);
    }
    const finish = () => {
      if (recorder?.state === "recording") {
        recorder.stop();
        releaseStream?.();
      }
    };
    input.signal.addEventListener("abort", cancel, { once: true });
    if (input.signal.aborted) {
      cancel();
      return;
    }
    let browser: VoiceRecordingBrowser;
    try {
      browser = input.browser ?? browserCapture();
    } catch (cause) {
      finishWith(
        cause instanceof Error
          ? cause
          : new Error("Could not access the microphone.")
      );
      return;
    }
    const mimeType = AUDIO_TYPES.find(browser.supportsType);
    if (!mimeType) {
      finishWith(
        new Error(
          "This browser cannot record a supported audio format. Use text chat instead."
        )
      );
      return;
    }
    browser
      .open(mimeType)
      .then((received) => {
        releaseStream = received.release;
        if (settled || input.signal.aborted) {
          received.release();
          return;
        }
        try {
          const created = received.recorder;
          recorder = created;
          created.ondataavailable = ({ data }) => {
            if (data.size === 0) {
              return;
            }
            bytes += data.size;
            if (bytes > MAX_VOICE_RECORDING_BYTES) {
              finishWith(
                new Error("That recording is too large. Try a shorter message.")
              );
              return;
            }
            chunks.push(data);
          };
          created.onerror = () =>
            finishWith(
              new Error(
                "The microphone recording failed. Try again or use text chat."
              )
            );
          created.onstop = () => {
            const audio = new Blob(chunks, {
              type: created.mimeType || mimeType,
            });
            finishWith(
              audio.size > 0
                ? audio
                : new Error("No audio was recorded. Try speaking again.")
            );
          };
          created.start(1000);
          timer = setTimeout(finish, MAX_VOICE_RECORDING_MS);
          input.onReady(finish);
        } catch (cause) {
          finishWith(
            cause instanceof Error
              ? cause
              : new Error("Could not start recording.")
          );
        }
      })
      .catch((cause: unknown) => {
        const message =
          cause instanceof Error && cause.name === "NotAllowedError"
            ? "Microphone access was denied. Allow it in your browser settings, then try again."
            : "The microphone is unavailable. Check that it is connected and allowed for this site.";
        finishWith(new Error(message));
      });
  });
}
