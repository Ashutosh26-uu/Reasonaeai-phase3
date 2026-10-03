import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_VOICE_RECORDING_MS,
  recordVoice,
  type VoiceRecorder,
  type VoiceRecordingBrowser,
} from "./voice-recording";

function captureBrowser() {
  const release = vi.fn();
  const recorder: VoiceRecorder = {
    mimeType: "audio/webm;codecs=opus",
    ondataavailable: null,
    onerror: null,
    onstop: null,
    start() {
      this.state = "recording";
    },
    state: "inactive",
    stop() {
      this.state = "inactive";
      this.ondataavailable?.(
        Object.assign(new Event("dataavailable"), {
          data: new Blob(["recorded speech"]),
          timecode: 0,
        })
      );
      this.onstop?.(new Event("stop"));
    },
  };
  const browser: VoiceRecordingBrowser = {
    open: vi.fn().mockResolvedValue({ recorder, release }),
    supportsType: (type) => type.startsWith("audio/webm"),
  };
  return { browser, recorder, release };
}

afterEach(() => vi.useRealTimers());

describe("voice capture ownership", () => {
  it("returns recorded audio with its actual MIME type and closes the microphone on finish", async () => {
    const { browser, release } = captureBrowser();
    const audio = await recordVoice({
      browser,
      onReady: (finish) => finish(),
      signal: new AbortController().signal,
    });
    expect(await audio?.text()).toBe("recorded speech");
    expect(audio?.type).toBe("audio/webm;codecs=opus");
    expect(release).toHaveBeenCalled();
  });

  it("discards a canceled recording and releases microphone ownership", async () => {
    const { browser, recorder, release } = captureBrowser();
    const controller = new AbortController();
    const result = recordVoice({
      browser,
      onReady: () => controller.abort(),
      signal: controller.signal,
    });
    expect(await result).toBeNull();
    expect(release).toHaveBeenCalled();
    expect(recorder.state).toBe("inactive");
  });

  it("closes permission streams that arrive after cancellation without starting a recording", async () => {
    const { recorder, release } = captureBrowser();
    const permissionGrant: {
      resolve?: (value: {
        recorder: VoiceRecorder;
        release: () => void;
      }) => void;
    } = {};
    const permission = new Promise<{
      recorder: VoiceRecorder;
      release: () => void;
    }>((resolve) => {
      permissionGrant.resolve = resolve;
    });
    const browser: VoiceRecordingBrowser = {
      open: () => permission,
      supportsType: () => true,
    };
    const controller = new AbortController();
    const ready = vi.fn();
    const result = recordVoice({
      browser,
      onReady: ready,
      signal: controller.signal,
    });
    controller.abort();
    expect(await result).toBeNull();
    permissionGrant.resolve?.({ recorder, release });
    await permission;
    expect(release).toHaveBeenCalledOnce();
    expect(recorder.state).toBe("inactive");
    expect(ready).not.toHaveBeenCalled();
  });

  it("automatically finishes at the duration cap", async () => {
    vi.useFakeTimers();
    const { browser, release } = captureBrowser();
    const result = recordVoice({
      browser,
      onReady: () => undefined,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(MAX_VOICE_RECORDING_MS);
    expect((await result)?.size).toBeGreaterThan(0);
    expect(release).toHaveBeenCalled();
  });

  it("rejects oversized recordings and closes capture without returning partial audio", async () => {
    const { browser, recorder, release } = captureBrowser();
    const result = recordVoice({
      browser,
      onReady: () => {
        recorder.ondataavailable?.(
          Object.assign(new Event("dataavailable"), {
            data: new Blob([new Uint8Array(8 * 1024 * 1024 + 1)]),
            timecode: 0,
          })
        );
      },
      signal: new AbortController().signal,
    });
    await expect(result).rejects.toThrow("too large");
    expect(release).toHaveBeenCalled();
    expect(recorder.state).toBe("inactive");
  });

  it("reports permission denial without inventing a transcript", async () => {
    const { browser } = captureBrowser();
    browser.open = () =>
      Promise.reject(new DOMException("denied", "NotAllowedError"));
    const result = recordVoice({
      browser,
      onReady: vi.fn(),
      signal: new AbortController().signal,
    });
    await expect(result).rejects.toThrow("Microphone access was denied");
  });
});
