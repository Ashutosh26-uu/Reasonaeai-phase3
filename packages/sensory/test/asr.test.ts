import type { ASRInput, ASROutput } from "@reasonateai/contracts/sensory";
import { describe, expect, it } from "vitest";
import { createASRAdapter } from "../src/asr/index.js";

// Shared input representing audio received by the sensory layer.
const input: ASRInput = {
  audio: new Uint8Array([1, 2, 3]),
  language: "en",
  mimeType: "audio/wav",
};

// Fake provider used to test the adapter without requiring a real ASR model.
const firstProvider = async (_input: ASRInput): Promise<ASROutput> => ({
  confidence: 0.95,
  language: "en",
  text: "Build a login page",
});

// A second fake provider verifies that the underlying ASR implementation can
// be replaced while the application-facing adapter contract stays unchanged.
const secondProvider = async (_input: ASRInput): Promise<ASROutput> => ({
  confidence: 0.91,
  language: "en",
  text: "Create a dashboard",
});

describe("ASR adapter", () => {
  it("delegates transcription to the configured provider", async () => {
    const adapter = createASRAdapter({
      transcribe: firstProvider,
    });

    await expect(adapter.transcribe(input)).resolves.toEqual({
      confidence: 0.95,
      language: "en",
      text: "Build a login page",
    });
  });

  it("allows the provider to be replaced without changing the adapter contract", async () => {
    const firstAdapter = createASRAdapter({
      transcribe: firstProvider,
    });

    const secondAdapter = createASRAdapter({
      transcribe: secondProvider,
    });

    await expect(firstAdapter.transcribe(input)).resolves.toMatchObject({
      text: "Build a login page",
    });

    await expect(secondAdapter.transcribe(input)).resolves.toMatchObject({
      text: "Create a dashboard",
    });
  });

  it("propagates provider failures", async () => {
    const adapter = createASRAdapter({
      transcribe: () => Promise.reject(new Error("ASR provider unavailable")),
    });

    await expect(adapter.transcribe(input)).rejects.toThrow(
      "ASR provider unavailable"
    );
  });
});
