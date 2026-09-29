/**
 * @vitest-environment jsdom
 */

import { MockASRAdapter, MockVisionAdapter } from "@reasonateai/voice-gateway";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SensoryIntake } from "../../components/surfaces/sensory-intake";

const VOICE_BUTTON_REGEX = /Describe your idea/i;
const WIREFRAME_BUTTON_REGEX = /Upload a wireframe/i;

// Mock URLs
const mockCreateObjectURL = vi.fn(() => "blob:http://localhost/mock-uuid");
const mockRevokeObjectURL = vi.fn();
Object.defineProperty(global.URL, "createObjectURL", {
  value: mockCreateObjectURL,
  writable: true,
});
Object.defineProperty(global.URL, "revokeObjectURL", {
  value: mockRevokeObjectURL,
  writable: true,
});

Object.defineProperty(Blob.prototype, "size", {
  configurable: true,
  get() {
    return 1024;
  },
});

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

describe("SensoryIntake UI — Phase 7", () => {
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

  // 1. Unified intake renders
  it("1. renders unified intake surface", () => {
    render(<SensoryIntake />);
    expect(screen.getByText("Project Intake")).toBeDefined();
    expect(
      screen.getByText(
        "Choose how you would like to describe your project requirements."
      )
    ).toBeDefined();
  });

  // 2. Voice option is available
  it("2. voice input method is available and selected by default", () => {
    render(<SensoryIntake />);
    const voiceButton = screen.getByRole("button", {
      name: VOICE_BUTTON_REGEX,
    });
    expect(voiceButton).toBeDefined();
    expect(voiceButton.getAttribute("aria-pressed")).toBe("true");
  });

  // 3. Wireframe option is available
  it("3. wireframe input method is available", () => {
    render(<SensoryIntake />);
    const wireframeButton = screen.getByRole("button", {
      name: WIREFRAME_BUTTON_REGEX,
    });
    expect(wireframeButton).toBeDefined();
    expect(wireframeButton.getAttribute("aria-pressed")).toBe("false");
  });

  // 4. Voice surface appears when Voice is selected
  it("4. voice surface appears when Voice is selected", () => {
    render(<SensoryIntake />);
    expect(screen.getByText("Voice Capture")).toBeDefined();
    expect(screen.queryByText("Wireframe Upload")).toBeNull();
  });

  // 5. Wireframe surface appears when Wireframe is selected
  it("5. wireframe surface appears when Wireframe is selected", () => {
    render(<SensoryIntake />);
    const wireframeButton = screen.getByRole("button", {
      name: WIREFRAME_BUTTON_REGEX,
    });
    fireEvent.click(wireframeButton);
    expect(screen.getByText("Wireframe Upload")).toBeDefined();
    expect(screen.queryByText("Voice Capture")).toBeNull();
  });

  // 10. Switching methods works safely
  it("10. switching between methods works safely", () => {
    render(<SensoryIntake />);
    expect(screen.getByText("Voice Capture")).toBeDefined();

    const wireframeButton = screen.getByRole("button", {
      name: WIREFRAME_BUTTON_REGEX,
    });
    fireEvent.click(wireframeButton);
    expect(screen.getByText("Wireframe Upload")).toBeDefined();

    const voiceButton = screen.getByRole("button", {
      name: VOICE_BUTTON_REGEX,
    });
    fireEvent.click(voiceButton);
    expect(screen.getByText("Voice Capture")).toBeDefined();
  });

  // 6, 8, 14. Voice completion reaches parent callback with EditableSpecification
  it("6, 8, 14. voice completion calls onComplete with correct shape", async () => {
    const asrAdapter = new MockASRAdapter();
    const onComplete = vi.fn();

    render(<SensoryIntake asrAdapter={asrAdapter} onComplete={onComplete} />);

    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Stop recording" })
      ).toBeDefined()
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Continue with specification" })
      ).toBeDefined();
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Continue with specification" })
    );

    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        specification: expect.objectContaining({
          title: "Sample Application",
        }),
        type: "voice",
      })
    );
  });

  // 7, 9, 14. Wireframe completion reaches parent callback with StructuredIntent
  it("7, 9, 14. wireframe completion calls onComplete with correct shape", async () => {
    const visionAdapter = new MockVisionAdapter();
    const onComplete = vi.fn();

    render(
      <SensoryIntake onComplete={onComplete} visionAdapter={visionAdapter} />
    );

    // Switch to wireframe
    fireEvent.click(
      screen.getByRole("button", { name: WIREFRAME_BUTTON_REGEX })
    );

    const fileInput = screen.getByLabelText("File input");
    const pngFile = new File(["a".repeat(1024)], "test.png", {
      type: "image/png",
    });
    Object.defineProperty(pngFile, "size", { value: 1024 });

    fireEvent.change(fileInput, { target: { files: [pngFile] } });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Process wireframe" })
      ).toBeDefined()
    );
    fireEvent.click(screen.getByRole("button", { name: "Process wireframe" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Continue with intent" })
      ).toBeDefined()
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Continue with intent" })
    );

    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: expect.objectContaining({
          screens: ["Dashboard (Mock)"],
        }),
        type: "wireframe",
      })
    );
  });

  // 12. Voice failure does not crash the parent
  it("12. voice failure is isolated and does not crash the surface", async () => {
    const onComplete = vi.fn();
    mockGetUserMedia.mockRejectedValue(new Error("Simulated mic failure"));

    render(<SensoryIntake onComplete={onComplete} />);

    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeDefined();
    });

    // Check if we can still switch to Wireframe safely
    fireEvent.click(
      screen.getByRole("button", { name: WIREFRAME_BUTTON_REGEX })
    );
    expect(screen.getByText("Wireframe Upload")).toBeDefined();
  });

  // 13. Wireframe failure does not crash the parent
  it("13. wireframe failure is isolated and does not crash the surface", async () => {
    const errorAdapter = {
      processImage: async () => ({
        code: "TEST_ERROR",
        message: "Test failure",
        userMessage: "Vision failed safely.",
      }),
    };

    render(<SensoryIntake visionAdapter={errorAdapter} />);

    fireEvent.click(
      screen.getByRole("button", { name: WIREFRAME_BUTTON_REGEX })
    );
    const fileInput = screen.getByLabelText("File input");
    const pngFile = new File(["a"], "test.png", { type: "image/png" });
    Object.defineProperty(pngFile, "size", { value: 1024 });

    fireEvent.change(fileInput, { target: { files: [pngFile] } });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Process wireframe" })
      ).toBeDefined()
    );
    fireEvent.click(screen.getByRole("button", { name: "Process wireframe" }));

    await waitFor(() => {
      expect(screen.getByText("Vision failed safely.")).toBeDefined();
    });

    // Check if we can still switch to Voice safely
    fireEvent.click(screen.getByRole("button", { name: VOICE_BUTTON_REGEX }));
    expect(screen.getByText("Voice Capture")).toBeDefined();
  });
});
