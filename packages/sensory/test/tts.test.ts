import { describe, expect, it, vi } from "vitest";
import { createTTSAdapter, type TTSProvider } from "../src/tts/index.js";

describe("TTS adapter", () => {
  it("delegates synthesis to the configured provider", async () => {
    /**
     * Create a fake provider so this unit test does not require
     * Python, Piper, a model file, or GPU resources.
     */
    const provider: TTSProvider = {
      synthesize: vi.fn().mockResolvedValue({
        audio: new Uint8Array([1, 2, 3]),
        durationMs: 1000,
        mimeType: "audio/wav",
      }),
    };

    /**
     * Wrap the provider with the shared TTS adapter.
     */
    const adapter = createTTSAdapter(provider);

    /**
     * Send a normal TTS request through the adapter.
     */
    const result = await adapter.synthesize({
      language: "en",
      text: "Hello from ReasonateAI.",
      voice: null,
    });

    /**
     * Confirm that the provider received the request.
     */
    expect(provider.synthesize).toHaveBeenCalledWith({
      language: "en",
      text: "Hello from ReasonateAI.",
      voice: null,
    });

    /**
     * Confirm that the provider result is returned unchanged.
     */
    expect(result).toEqual({
      audio: new Uint8Array([1, 2, 3]),
      durationMs: 1000,
      mimeType: "audio/wav",
    });
  });

  it("supports replacing one TTS provider with another", async () => {
    /**
     * Provider A represents one TTS implementation.
     */
    const providerA: TTSProvider = {
      synthesize: vi.fn().mockResolvedValue({
        audio: new Uint8Array([1]),
        durationMs: 500,
        mimeType: "audio/wav",
      }),
    };

    /**
     * Provider B represents a completely different implementation.
     */
    const providerB: TTSProvider = {
      synthesize: vi.fn().mockResolvedValue({
        audio: new Uint8Array([2]),
        durationMs: 750,
        mimeType: "audio/wav",
      }),
    };

    /**
     * The application-facing adapter does not need to change.
     */
    const adapterA = createTTSAdapter(providerA);
    const adapterB = createTTSAdapter(providerB);

    const input = {
      language: "en",
      text: "Provider replacement test.",
      voice: null,
    };

    /**
     * Both providers satisfy exactly the same contract.
     */
    await expect(adapterA.synthesize(input)).resolves.toEqual({
      audio: new Uint8Array([1]),
      durationMs: 500,
      mimeType: "audio/wav",
    });

    await expect(adapterB.synthesize(input)).resolves.toEqual({
      audio: new Uint8Array([2]),
      durationMs: 750,
      mimeType: "audio/wav",
    });
  });

  it("propagates provider failures", async () => {
    /**
     * Simulate a provider failure such as a missing model,
     * unavailable inference service, or runtime error.
     */
    const provider: TTSProvider = {
      synthesize: vi
        .fn()
        .mockRejectedValue(new Error("TTS provider unavailable")),
    };

    const adapter = createTTSAdapter(provider);

    /**
     * The adapter must not hide or transform the provider failure.
     */
    await expect(
      adapter.synthesize({
        language: "en",
        text: "Failure test.",
        voice: null,
      })
    ).rejects.toThrow("TTS provider unavailable");
  });
});
