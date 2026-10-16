import type {
  ASRAdapter,
  ASROutput,
  TTSAdapter,
  TTSOutput,
  VisionAdapter,
  VisionOutput,
} from "@reasonateai/contracts/sensory";
import { describe, expect, it, vi } from "vitest";
import {
  createSensoryGateway,
  SensoryGatewayError,
} from "../src/gateway/index.js";

// Shared typed fixtures keep the gateway tests focused on routing,
// error handling, timeout behavior, and provider lifecycle instead
// of repeatedly constructing sensory payloads.
const asrOutput: ASROutput = {
  confidence: 0.98,
  language: "en",
  text: "hello from asr",
};

const ttsOutput: TTSOutput = {
  audio: new Uint8Array([1, 2, 3]),
  durationMs: 1200,
  mimeType: "audio/wav",
};

const visionOutput: VisionOutput = {
  elements: [
    {
      description: "A button",
      text: "Submit",
      type: "button",
    },
  ],
  summary: "A simple form with a submit button.",
};

const asrInput = {
  audio: new Uint8Array([1, 2, 3]),
  language: "en",
  mimeType: "audio/wav",
};

const ttsInput = {
  language: "en",
  text: "hello",
  voice: "test-voice",
};

const visionInput = {
  image: new Uint8Array([1, 2, 3]),
  mimeType: "image/png",
  prompt: "Extract the editable UI structure.",
};

describe("SensoryGateway", () => {
  it("delegates transcription to the ASR adapter", async () => {
    // Keep the mock typed against the production adapter contract so
    // changes to ASRInput/ASROutput are caught at compile time.
    const transcribe = vi.fn<ASRAdapter["transcribe"]>(async () => asrOutput);

    const gateway = createSensoryGateway({
      asr: { transcribe },
      tts: {
        synthesize: vi.fn<TTSAdapter["synthesize"]>(async () => ttsOutput),
      },
      vision: {
        extract: vi.fn<VisionAdapter["extract"]>(async () => visionOutput),
      },
    });

    await expect(gateway.transcribe(asrInput)).resolves.toEqual(asrOutput);

    // Verify the gateway forwards the caller's ASR input
    // to the configured replaceable provider.
    expect(transcribe).toHaveBeenCalledWith(asrInput);
  });

  it("delegates synthesis to the TTS adapter", async () => {
    const synthesize = vi.fn<TTSAdapter["synthesize"]>(async () => ttsOutput);

    const gateway = createSensoryGateway({
      asr: {
        transcribe: vi.fn<ASRAdapter["transcribe"]>(async () => asrOutput),
      },
      tts: { synthesize },
      vision: {
        extract: vi.fn<VisionAdapter["extract"]>(async () => visionOutput),
      },
    });

    await expect(gateway.synthesize(ttsInput)).resolves.toEqual(ttsOutput);

    // The gateway should delegate the TTS request unchanged.
    expect(synthesize).toHaveBeenCalledWith(ttsInput);
  });

  it("delegates image extraction to the Vision adapter", async () => {
    const extract = vi.fn<VisionAdapter["extract"]>(async () => visionOutput);

    const gateway = createSensoryGateway({
      asr: {
        transcribe: vi.fn<ASRAdapter["transcribe"]>(async () => asrOutput),
      },
      tts: {
        synthesize: vi.fn<TTSAdapter["synthesize"]>(async () => ttsOutput),
      },
      vision: { extract },
    });

    await expect(gateway.extract(visionInput)).resolves.toEqual(visionOutput);

    // Verify that both image data and the extraction prompt
    // reach the configured Vision provider.
    expect(extract).toHaveBeenCalledWith(visionInput);
  });

  it("wraps ASR failures in SensoryGatewayError", async () => {
    // Preserve the original provider error so callers can inspect
    // the underlying failure through the gateway error's cause.
    const cause = new Error("ASR provider failed");

    const gateway = createSensoryGateway({
      asr: {
        transcribe: vi.fn<ASRAdapter["transcribe"]>(() => {
          throw cause;
        }),
      },
      tts: {
        synthesize: vi.fn<TTSAdapter["synthesize"]>(async () => ttsOutput),
      },
      vision: {
        extract: vi.fn<VisionAdapter["extract"]>(async () => visionOutput),
      },
    });

    try {
      await gateway.transcribe(asrInput);
      throw new Error("Expected gateway.transcribe to reject");
    } catch (error) {
      // Caught errors are unknown in strict TypeScript.
      // Narrow before accessing SensoryGatewayError properties.
      expect(error).toBeInstanceOf(SensoryGatewayError);

      if (!(error instanceof SensoryGatewayError)) {
        throw error;
      }

      expect(error.operation).toBe("asr");
      expect(error.message).toBe("ASR transcription failed");
      expect(error.cause).toBe(cause);
    }
  });

  it("wraps TTS failures in SensoryGatewayError", async () => {
    // The gateway exposes a stable TTS error while retaining
    // the original provider exception as the cause.
    const cause = new Error("TTS provider failed");

    const gateway = createSensoryGateway({
      asr: {
        transcribe: vi.fn<ASRAdapter["transcribe"]>(async () => asrOutput),
      },
      tts: {
        synthesize: vi.fn<TTSAdapter["synthesize"]>(() => {
          throw cause;
        }),
      },
      vision: {
        extract: vi.fn<VisionAdapter["extract"]>(async () => visionOutput),
      },
    });

    try {
      await gateway.synthesize(ttsInput);
      throw new Error("Expected gateway.synthesize to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(SensoryGatewayError);

      if (!(error instanceof SensoryGatewayError)) {
        throw error;
      }

      expect(error.operation).toBe("tts");
      expect(error.message).toBe("TTS synthesis failed");
      expect(error.cause).toBe(cause);
    }
  });

  it("wraps Vision failures in SensoryGatewayError", async () => {
    // Vision uses the same gateway error boundary as ASR and TTS,
    // giving callers one predictable error shape.
    const cause = new Error("Vision provider failed");

    const gateway = createSensoryGateway({
      asr: {
        transcribe: vi.fn<ASRAdapter["transcribe"]>(async () => asrOutput),
      },
      tts: {
        synthesize: vi.fn<TTSAdapter["synthesize"]>(async () => ttsOutput),
      },
      vision: {
        extract: vi.fn<VisionAdapter["extract"]>(() => {
          throw cause;
        }),
      },
    });

    try {
      await gateway.extract(visionInput);
      throw new Error("Expected gateway.extract to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(SensoryGatewayError);

      if (!(error instanceof SensoryGatewayError)) {
        throw error;
      }

      expect(error.operation).toBe("vision");
      expect(error.message).toBe("Vision extraction failed");
      expect(error.cause).toBe(cause);
    }
  });

  it("times out a slow provider", async () => {
    // This provider intentionally never resolves so the test verifies
    // that the gateway enforces its configured operation timeout.
    const gateway = createSensoryGateway({
      asr: {
        // Explicitly typing the mock prevents Vitest from inferring
        // Promise<unknown> and losing the ASR contract.
        transcribe: vi.fn<ASRAdapter["transcribe"]>(
          () =>
            new Promise<ASROutput>(() => {
              // Intentionally never resolves.
            })
        ),
      },
      timeoutMs: 10,
      tts: {
        synthesize: vi.fn<TTSAdapter["synthesize"]>(async () => ttsOutput),
      },
      vision: {
        extract: vi.fn<VisionAdapter["extract"]>(async () => visionOutput),
      },
    });

    try {
      await gateway.transcribe(asrInput);
      throw new Error("Expected gateway.transcribe to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(SensoryGatewayError);

      if (!(error instanceof SensoryGatewayError)) {
        throw error;
      }

      expect(error.operation).toBe("asr");
      expect(error.cause).toBeInstanceOf(Error);

      if (!(error.cause instanceof Error)) {
        throw new Error("Expected timeout cause to be an Error", {
          cause: error,
        });
      }

      expect(error.cause.message).toContain(
        "ASR transcription timed out after 10ms"
      );
    }
  });

  it("rejects an invalid timeout", () => {
    const asr: ASRAdapter & { close: () => void } = {
      close: vi.fn(),
      transcribe: vi.fn<ASRAdapter["transcribe"]>(async () => asrOutput),
    };

    const tts: TTSAdapter & { close: () => void } = {
      close: vi.fn(),
      synthesize: vi.fn<TTSAdapter["synthesize"]>(async () => ttsOutput),
    };

    const vision: VisionAdapter & { close: () => void } = {
      close: vi.fn(),
      extract: vi.fn<VisionAdapter["extract"]>(async () => visionOutput),
    };

    expect(() =>
      createSensoryGateway({
        asr,
        timeoutMs: 0,
        tts,
        vision,
      })
    ).toThrow("Sensory gateway timeout must be a positive finite number");
  });

  it("closes all closable providers", () => {
    const asrClose = vi.fn();
    const ttsClose = vi.fn();
    const visionClose = vi.fn();

    // close() is intentionally not part of the core sensory contracts.
    // The gateway detects optional lifecycle support structurally, so the
    // tests model providers that expose close() without changing those contracts.
    const asr: ASRAdapter & { close: () => void } = {
      close: asrClose,
      transcribe: vi.fn<ASRAdapter["transcribe"]>(async () => asrOutput),
    };

    const tts: TTSAdapter & { close: () => void } = {
      close: ttsClose,
      synthesize: vi.fn<TTSAdapter["synthesize"]>(async () => ttsOutput),
    };

    const vision: VisionAdapter & { close: () => void } = {
      close: visionClose,
      extract: vi.fn<VisionAdapter["extract"]>(async () => visionOutput),
    };

    const gateway = createSensoryGateway({
      asr,
      tts,
      vision,
    });

    gateway.close();

    expect(asrClose).toHaveBeenCalledOnce();
    expect(ttsClose).toHaveBeenCalledOnce();
    expect(visionClose).toHaveBeenCalledOnce();
  });
});
