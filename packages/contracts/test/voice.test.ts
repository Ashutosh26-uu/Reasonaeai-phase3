import { describe, expect, it } from "vitest";
import {
  MAX_AUDIO_BYTES,
  MAX_SPEECH_TEXT_LENGTH,
  SpeechAudioFormatSchema,
  SpeechRequestSchema,
  TranscriptionResponseSchema,
  VOICE_SPEECH_PATH,
  VOICE_TRANSCRIPTION_PATH,
  VOICE_UNCONFIGURED_CODE,
} from "../src/voice.js";

describe("Voice contracts", () => {
  it("defines standard path and error constants", () => {
    expect(VOICE_TRANSCRIPTION_PATH).toBe("/v1/voice/transcriptions");
    expect(VOICE_SPEECH_PATH).toBe("/v1/voice/speech");
    expect(VOICE_UNCONFIGURED_CODE).toBe("voice_unconfigured");
    expect(MAX_AUDIO_BYTES).toBe(25 * 1024 * 1024);
    expect(MAX_SPEECH_TEXT_LENGTH).toBe(4096);
  });

  it("validates SpeechRequestSchema with valid payloads", () => {
    const valid = SpeechRequestSchema.parse({
      format: "mp3",
      speed: 1.0,
      text: "Hello, this is ReasonateAI speaking.",
      voice: "af_heart",
    });
    expect(valid.text).toBe("Hello, this is ReasonateAI speaking.");
    expect(valid.voice).toBe("af_heart");
    expect(valid.format).toBe("mp3");
    expect(valid.speed).toBe(1.0);

    const minimal = SpeechRequestSchema.parse({
      text: "Only text required",
    });
    expect(minimal.text).toBe("Only text required");
    expect(minimal.voice).toBeUndefined();
    expect(minimal.format).toBeUndefined();
  });

  it("rejects invalid speech payloads", () => {
    expect(() => SpeechRequestSchema.parse({})).toThrow();
    expect(() => SpeechRequestSchema.parse({ text: "" })).toThrow();
    expect(() => SpeechRequestSchema.parse({ text: "   " })).toThrow();
    expect(() =>
      SpeechRequestSchema.parse({ text: "a".repeat(4097) })
    ).toThrow();
    expect(() =>
      SpeechRequestSchema.parse({
        format: "invalid-format" as "mp3",
        text: "hello",
      })
    ).toThrow();
    expect(() =>
      SpeechRequestSchema.parse({
        speed: 10,
        text: "hello",
      })
    ).toThrow();
  });

  it("validates audio format enum", () => {
    expect(SpeechAudioFormatSchema.parse("mp3")).toBe("mp3");
    expect(SpeechAudioFormatSchema.parse("opus")).toBe("opus");
    expect(SpeechAudioFormatSchema.parse("wav")).toBe("wav");
    expect(SpeechAudioFormatSchema.parse("flac")).toBe("flac");
    expect(SpeechAudioFormatSchema.parse("aac")).toBe("aac");
    expect(SpeechAudioFormatSchema.parse("pcm")).toBe("pcm");
  });

  it("validates TranscriptionResponseSchema", () => {
    const res = TranscriptionResponseSchema.parse({
      language: "en",
      provider: "openai-compatible",
      text: "Transcribed speech",
    });
    expect(res.text).toBe("Transcribed speech");
    expect(res.provider).toBe("openai-compatible");
    expect(res.language).toBe("en");
  });
});
