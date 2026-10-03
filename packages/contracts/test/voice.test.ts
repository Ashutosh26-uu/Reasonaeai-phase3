import { describe, expect, it } from "vitest";
import {
  MAX_SPEECH_TEXT_CHARS,
  MAX_VOICE_AUDIO_BYTES,
  MAX_VOICE_LANGUAGE_LENGTH,
  SpeechFormatSchema,
  speechFormatMediaTypes,
  speechFormats,
  VoiceSpeechRequestSchema,
  VoiceTranscriptionSchema,
  voiceAudioMediaTypes,
} from "../src/voice.js";

const AUDIO_MEDIA_TYPE_RE = /^audio\//;

describe("voice wire contracts", () => {
  it("defaults a synthesis request to playable audio and normalizes absent hints", () => {
    const parsed = VoiceSpeechRequestSchema.parse({
      text: "The build passed.",
    });
    expect(parsed).toEqual({ format: "mp3", text: "The build passed." });
    expect(parsed.language).toBeUndefined();
    expect(parsed.voice).toBeUndefined();
  });

  it("refuses a synthesis request carrying anything the contract does not name", () => {
    for (const input of [
      { speed: 2, text: "Hi" },
      { text: "" },
      { text: "x".repeat(MAX_SPEECH_TEXT_CHARS + 1) },
      { format: "mp4", text: "Hi" },
      { text: "Hi", voice: "x".repeat(65) },
      {
        language: "x".repeat(MAX_VOICE_LANGUAGE_LENGTH + 1),
        text: "Hi",
      },
    ]) {
      expect(VoiceSpeechRequestSchema.safeParse(input).success).toBe(false);
    }
  });

  it("accepts the null hints a JSON client sends and reads them as absent", () => {
    const parsed = VoiceSpeechRequestSchema.parse({
      language: null,
      text: "Hi",
      voice: null,
    });
    expect(parsed.language).toBeUndefined();
    expect(parsed.voice).toBeUndefined();
  });

  it("states a transcription exactly, with no room for smuggled provider fields", () => {
    expect(
      VoiceTranscriptionSchema.parse({
        language: null,
        provider: "openai-compatible",
        text: "",
      })
    ).toEqual({ language: null, provider: "openai-compatible", text: "" });
    expect(
      VoiceTranscriptionSchema.safeParse({
        confidence: 1,
        language: null,
        provider: "openai-compatible",
        text: "",
      }).success
    ).toBe(false);
  });

  it("names a media type for every synthesis format and keeps the recorded containers", () => {
    for (const format of speechFormats) {
      expect(speechFormatMediaTypes[format]).toMatch(AUDIO_MEDIA_TYPE_RE);
    }
    expect(SpeechFormatSchema.safeParse("mp3").success).toBe(true);
    expect(voiceAudioMediaTypes).toEqual([
      "audio/mp4",
      "audio/mpeg",
      "audio/ogg",
      "audio/wav",
      "audio/webm",
    ]);
    expect(MAX_VOICE_AUDIO_BYTES).toBe(25 * 1024 * 1024);
  });
});
