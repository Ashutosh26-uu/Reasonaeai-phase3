/**
 * @vitest-environment jsdom
 */

import { MockASRAdapter } from "@reasonateai/voice-gateway";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceCapture } from "../../components/surfaces/voice-capture";

// Mock navigator.mediaDevices
const mockGetUserMedia = vi.fn();
const mockStop = vi.fn();
Object.defineProperty(global.navigator, "mediaDevices", {
  configurable: true,
  value: {
    getUserMedia: mockGetUserMedia,
  },
  writable: true,
});

// Mock MediaRecorder
class MockMediaRecorder {
  state = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;

  stream: MediaStream;
  constructor(stream: MediaStream) {
    this.stream = stream;
  }

  start() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    if (this.ondataavailable) {
      this.ondataavailable({
        data: new Blob(["dummy"], { type: "audio/webm" }),
      });
    }
    if (this.onstop) {
      this.onstop();
    }
  }
}
(global as unknown as Record<string, unknown>).MediaRecorder =
  MockMediaRecorder;

describe("VoiceCapture UI — Phase 6", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockGetUserMedia.mockReset();
    mockStop.mockReset();
    // Restore mediaDevices for tests that need it
    Object.defineProperty(global.navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: mockGetUserMedia },
      writable: true,
    });
    // Restore MediaRecorder
    (global as unknown as Record<string, unknown>).MediaRecorder =
      MockMediaRecorder;
    mockGetUserMedia.mockResolvedValue({
      getTracks: () => [{ stop: mockStop }],
    });
  });

  afterEach(() => {
    cleanup();
  });

  // 1. Initial idle state
  it("1. renders idle state correctly", () => {
    const { container } = render(<VoiceCapture />);
    expect(
      container.querySelector("[data-slot='card-title']")?.textContent
    ).toBe("Voice Capture");
    expect(container.textContent).toContain("idle");
    expect(screen.getByLabelText("Start recording")).toBeDefined();
  });

  // 2. Start recording
  it("2. transitions to recording when Start is clicked", async () => {
    const { container } = render(<VoiceCapture />);

    fireEvent.click(screen.getByLabelText("Start recording"));

    await waitFor(() => {
      expect(container.textContent).toContain("recording");
      expect(screen.getByLabelText("Stop recording")).toBeDefined();
    });
  });

  // 3. Recording state shows duration
  it("3. recording state shows duration indicator", async () => {
    render(<VoiceCapture />);
    fireEvent.click(screen.getByLabelText("Start recording"));

    await waitFor(() => {
      const durationEl = screen.getByTestId("duration");
      expect(durationEl).toBeDefined();
      expect(durationEl.textContent).toBe("Recording duration: 0:00");
    });
  });

  // 4. Stop recording
  it("4. stop recording triggers processing", async () => {
    const mockAdapter = new MockASRAdapter();
    const spy = vi.spyOn(mockAdapter, "processAudio");

    render(<VoiceCapture asrAdapter={mockAdapter} />);

    fireEvent.click(screen.getByLabelText("Start recording"));
    await waitFor(() =>
      expect(screen.getByLabelText("Stop recording")).toBeDefined()
    );

    fireEvent.click(screen.getByLabelText("Stop recording"));

    await waitFor(() => {
      expect(spy).toHaveBeenCalled();
    });
  });

  // 5. Processing state
  it("5. shows processing state after stop", async () => {
    // Use a slow adapter to observe processing state
    const slowAdapter = {
      processAudio: () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                description: "Test",
                requirements: [],
                title: "Test",
              }),
            100
          );
        }),
    };

    const { container } = render(
      <VoiceCapture asrAdapter={slowAdapter as MockASRAdapter} />
    );

    fireEvent.click(screen.getByLabelText("Start recording"));
    await waitFor(() =>
      expect(screen.getByLabelText("Stop recording")).toBeDefined()
    );
    fireEvent.click(screen.getByLabelText("Stop recording"));

    // The processing icon should appear
    await waitFor(() => {
      expect(container.textContent).toContain("processing");
    });
  });

  // 6. Mock ASR produces EditableSpecification
  it("6. mock ASR adapter produces specification", async () => {
    const mockAdapter = new MockASRAdapter();
    const { container } = render(<VoiceCapture asrAdapter={mockAdapter} />);

    fireEvent.click(screen.getByLabelText("Start recording"));
    await waitFor(() =>
      expect(screen.getByLabelText("Stop recording")).toBeDefined()
    );
    fireEvent.click(screen.getByLabelText("Stop recording"));

    await waitFor(() => {
      expect(container.textContent).toContain("completed");
      expect(screen.getByDisplayValue("Sample Application")).toBeDefined();
    });
  });

  // 7. Specification editor receives result
  it("7. specification editor renders and is editable", async () => {
    const mockAdapter = new MockASRAdapter();
    render(<VoiceCapture asrAdapter={mockAdapter} />);

    fireEvent.click(screen.getByLabelText("Start recording"));
    await waitFor(() =>
      expect(screen.getByLabelText("Stop recording")).toBeDefined()
    );
    fireEvent.click(screen.getByLabelText("Stop recording"));

    await waitFor(() => {
      expect(screen.getByDisplayValue("Sample Application")).toBeDefined();
    });

    const titleInput = screen.getByDisplayValue("Sample Application");
    fireEvent.change(titleInput, { target: { value: "Edited Title" } });
    expect(screen.getByDisplayValue("Edited Title")).toBeDefined();
  });

  // 8. Accept & Continue callback
  it("8. accept & continue invokes onComplete with specification", async () => {
    const mockAdapter = new MockASRAdapter();
    const onComplete = vi.fn();

    render(<VoiceCapture asrAdapter={mockAdapter} onComplete={onComplete} />);

    fireEvent.click(screen.getByLabelText("Start recording"));
    await waitFor(() =>
      expect(screen.getByLabelText("Stop recording")).toBeDefined()
    );
    fireEvent.click(screen.getByLabelText("Stop recording"));

    await waitFor(() => {
      expect(screen.getByDisplayValue("Sample Application")).toBeDefined();
    });

    fireEvent.change(screen.getByDisplayValue("Sample Application"), {
      target: { value: "Updated App" },
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Continue with specification" })
    );

    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "Sample requirement generated from voice input (MOCK)",
        title: "Updated App",
      })
    );
  });

  // 9. Permission denied
  it("9. handles permission denied", async () => {
    const error = new DOMException("Permission denied", "NotAllowedError");
    mockGetUserMedia.mockRejectedValueOnce(error);

    const { container } = render(<VoiceCapture />);

    fireEvent.click(screen.getByLabelText("Start recording"));

    await waitFor(() => {
      expect(container.textContent).toContain("permission denied");
      expect(container.textContent).toContain("Microphone access was denied");
    });
  });

  // 10. MediaDevices unavailable
  it("10. handles MediaDevices unavailable", async () => {
    Object.defineProperty(global.navigator, "mediaDevices", {
      configurable: true,
      value: undefined,
      writable: true,
    });

    const { container } = render(<VoiceCapture />);

    fireEvent.click(screen.getByLabelText("Start recording"));

    await waitFor(() => {
      expect(container.textContent).toContain("unsupported");
      expect(container.textContent).toContain(
        "does not support audio recording"
      );
    });

    // Restore
    Object.defineProperty(global.navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: mockGetUserMedia },
      writable: true,
    });
  });

  // 11. MediaRecorder unavailable
  it("11. handles MediaRecorder unavailable", async () => {
    (global as unknown as Record<string, unknown>).MediaRecorder = undefined;

    const { container } = render(<VoiceCapture />);

    fireEvent.click(screen.getByLabelText("Start recording"));

    await waitFor(() => {
      expect(container.textContent).toContain("unsupported");
      expect(container.textContent).toContain(
        "does not support audio recording"
      );
    });

    // Restore
    (global as unknown as Record<string, unknown>).MediaRecorder =
      MockMediaRecorder;
  });

  // 12. ASR adapter failure
  it("12. handles ASR adapter processing failure", async () => {
    const failingAdapter = {
      processAudio: vi.fn().mockRejectedValue(new Error("ASR engine error")),
    };

    const { container } = render(
      <VoiceCapture asrAdapter={failingAdapter as unknown as MockASRAdapter} />
    );

    fireEvent.click(screen.getByLabelText("Start recording"));
    await waitFor(() =>
      expect(screen.getByLabelText("Stop recording")).toBeDefined()
    );
    fireEvent.click(screen.getByLabelText("Stop recording"));

    await waitFor(() => {
      expect(container.textContent).toContain("failed");
      expect(container.textContent).toContain(
        "Failed to process audio. Please try again."
      );
    });
  });

  // 13. Retry after failure
  it("13. retry after failure resets to idle", async () => {
    const error = new DOMException("Permission denied", "NotAllowedError");
    mockGetUserMedia.mockRejectedValueOnce(error);

    const { container } = render(<VoiceCapture />);

    fireEvent.click(screen.getByLabelText("Start recording"));

    await waitFor(() => {
      expect(container.textContent).toContain("permission denied");
    });

    const retryBtn = screen.getByLabelText("Retry recording");
    expect(retryBtn).toBeDefined();

    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(container.textContent).toContain("idle");
      // Error message should be cleared
      expect(screen.queryByText("Microphone access was denied")).toBeNull();
    });
  });

  // 14. Reset after completion
  it("14. reset after completion clears specification and returns to idle", async () => {
    const mockAdapter = new MockASRAdapter();
    const { container } = render(<VoiceCapture asrAdapter={mockAdapter} />);

    fireEvent.click(screen.getByLabelText("Start recording"));
    await waitFor(() =>
      expect(screen.getByLabelText("Stop recording")).toBeDefined()
    );
    fireEvent.click(screen.getByLabelText("Stop recording"));

    await waitFor(() => {
      expect(screen.getByDisplayValue("Sample Application")).toBeDefined();
    });

    const resetBtn = screen.getByLabelText("Record another");
    expect(resetBtn).toBeDefined();

    fireEvent.click(resetBtn);

    await waitFor(() => {
      expect(container.textContent).toContain("idle");
      expect(screen.queryByDisplayValue("Sample Application")).toBeNull();
      expect(screen.queryByText("Generated Specification")).toBeNull();
    });
  });

  // 15. Duplicate action protection - record button hidden during recording/processing
  it("15. duplicate action protection: no record button while recording", async () => {
    render(<VoiceCapture />);

    fireEvent.click(screen.getByLabelText("Start recording"));

    await waitFor(() => {
      expect(screen.getByLabelText("Stop recording")).toBeDefined();
      // Start recording button should be gone
      expect(screen.queryByLabelText("Start recording")).toBeNull();
    });
  });
});
