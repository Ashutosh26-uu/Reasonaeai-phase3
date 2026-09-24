import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createWhisperProvider } from "../src/asr/whisper.js";

describe("Whisper provider integration", () => {
  it("transcribes audio using OpenAI Whisper", async () => {
    const audio = await readFile("/kaggle/working/test_audio.mp3");

    const provider = createWhisperProvider({
      model: "base",
    });

    const result = await provider.transcribe({
      audio: new Uint8Array(audio),
      language: "en",
      mimeType: "audio/mpeg",
    });

    expect(result.text.toLowerCase()).toContain("login page");
    expect(result.language).toBe("en");
  }, 30_000);
});
