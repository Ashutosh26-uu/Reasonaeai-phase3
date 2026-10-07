import { z } from "zod";

/**
 * Shared voice intake and speech synthesis contracts.
 *
 * Voice operations bridge audio and text at the product boundary:
 * - A person speaks, and speech-to-text turns their recording into a draft.
 * - An assistant answers, and text-to-speech speaks the response back.
 *
 * Neither operation alters durable project state directly; each turns bytes into
 * text or text into bytes behind an authorized project scope.
 */

export const VOICE_TRANSCRIPTION_PATH = "/v1/voice/transcriptions";
export const VOICE_SPEECH_PATH = "/v1/voice/speech";

/** Largest audio payload the transcription route accepts, in bytes (25 MiB). */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/** Largest text payload the speech synthesis route accepts, in characters (4,096 chars matching OpenAI /audio/speech standard). */
export const MAX_SPEECH_TEXT_LENGTH = 4096;

/** Refusal codes specific to voice endpoints. */
export const VOICE_UNCONFIGURED_CODE = "voice_unconfigured";
export const VOICE_UPLOAD_TOO_LARGE_CODE = "voice_upload_too_large";
export const VOICE_UNSUPPORTED_MEDIA_TYPE_CODE = "voice_unsupported_media_type";

/** Audio container formats supported by speech synthesis endpoints. */
export const speechAudioFormats = [
  "mp3",
  "opus",
  "aac",
  "flac",
  "wav",
  "pcm",
] as const;

export const SpeechAudioFormatSchema = z.enum(speechAudioFormats);
export type SpeechAudioFormat = z.infer<typeof SpeechAudioFormatSchema>;

/**
 * What a client sends to synthesize spoken audio from text.
 */
export const SpeechRequestSchema = z.strictObject({
  format: SpeechAudioFormatSchema.optional(),
  speed: z.number().min(0.25).max(4.0).optional(),
  text: z
    .string()
    .trim()
    .min(1, "Text to synthesize cannot be empty.")
    .max(MAX_SPEECH_TEXT_LENGTH),
  voice: z.string().trim().min(1).max(64).optional(),
});
export type SpeechRequest = z.infer<typeof SpeechRequestSchema>;

/**
 * What a client receives from a transcription operation.
 */
export const TranscriptionResponseSchema = z.strictObject({
  language: z.string().min(1).max(64).nullable(),
  provider: z.string().min(1).max(64),
  text: z.string(),
});
export type TranscriptionResponse = z.infer<typeof TranscriptionResponseSchema>;
