import { describe, expect, it } from "vitest";
import {
  ASRInputSchema,
  ASROutputSchema,
  TTSInputSchema,
  TTSOutputSchema,
  VisionInputSchema,
  VisionOutputSchema,
} from "../src/sensory.js";

describe("sensory contracts", () => {
  it("accepts valid ASR input and output", () => {
    const input = ASRInputSchema.parse({
      audio: new Uint8Array([1, 2, 3]),
      language: "en",
      mimeType: "audio/wav",
    });

    const output = ASROutputSchema.parse({
      confidence: 0.95,
      language: "en",
      text: "Build a login page",
    });

    expect(input.audio).toBeInstanceOf(Uint8Array);
    expect(output.text).toBe("Build a login page");
  });

  it("accepts valid TTS input and output", () => {
    const input = TTSInputSchema.parse({
      language: "en",
      text: "Your application is ready.",
      voice: "default",
    });

    const output = TTSOutputSchema.parse({
      audio: new Uint8Array([1, 2, 3]),
      durationMs: 1200,
      mimeType: "audio/wav",
    });

    expect(input.text).toBe("Your application is ready.");
    expect(output.audio).toBeInstanceOf(Uint8Array);
  });

  it("accepts valid vision input and output", () => {
    const input = VisionInputSchema.parse({
      image: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
    });

    const output = VisionOutputSchema.parse({
      elements: [
        {
          description: "Login button",
          text: "Login",
          type: "button",
        },
      ],
      summary: "Login page wireframe",
    });

    expect(input.image).toBeInstanceOf(Uint8Array);
    expect(output.elements).toHaveLength(1);
  });

  it("rejects invalid ASR output", () => {
    expect(() =>
      ASROutputSchema.parse({
        confidence: 2,
        language: "en",
        text: "hello",
      })
    ).toThrow();
  });

  it("rejects invalid TTS input", () => {
    expect(() =>
      TTSInputSchema.parse({
        language: "en",
        text: "",
        voice: "default",
      })
    ).toThrow();
  });

  it("rejects invalid vision output", () => {
    expect(() =>
      VisionOutputSchema.parse({
        elements: [
          {
            description: "",
            text: null,
            type: "button",
          },
        ],
        summary: "wireframe",
      })
    ).toThrow();
  });
});
