import { z } from "zod";

/**
 * Voice wire contracts.
 *
 * Speech crosses the product boundary in both directions: a recording leaves
 * the browser as audio bytes and comes back as text, and a response leaves the
 * product as text and comes back as audio. Both crossings are stated here,
 * once, so the API routes, the browser client, and any future voice gateway
 * share one vocabulary. This module exists because three incompatible ASR
 * interfaces appeared across parallel branches of this repository; the shapes
 * below are the reconciliation, and the transport and result of an ASR call are
 * exactly these: audio bytes in, a transcript out.
 */

/** Largest audio payload a voice route accepts, in bytes. */
export const MAX_VOICE_AUDIO_BYTES = 25 * 1024 * 1024;

/**
 * The containers a recorded message may arrive in. A browser records WebM or
 * MP4/Opus, but a client may legitimately upload an existing recording, so
 * every container the OpenAI-compatible adapters can forward is named here.
 */
export const voiceAudioMediaTypes = [
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
] as const;

export const VoiceAudioMediaTypeSchema = z.enum(voiceAudioMediaTypes);
export type VoiceAudioMediaType = z.infer<typeof VoiceAudioMediaTypeSchema>;

/** The largest language tag a voice request may carry. */
export const MAX_VOICE_LANGUAGE_LENGTH = 64;

/**
 * What a caller gets back from a transcription: the transcript itself, the
 * language it was transcribed in when the caller named one, and which adapter
 * produced it, so a client can say where the text came from. `language` is
 * nullable because a caller that named none gets `null`, never a guess.
 */
export const VoiceTranscriptionSchema = z.strictObject({
  language: z.string().min(1).max(MAX_VOICE_LANGUAGE_LENGTH).nullable(),
  provider: z.string().min(1).max(64),
  text: z.string(),
});
export type VoiceTranscription = z.infer<typeof VoiceTranscriptionSchema>;

/**
 * The audio containers a synthesis may return. These are the tokens
 * OpenAI-compatible `/audio/speech` endpoints accept as `response_format`, and
 * `mp3` is the default because every browser can play it without help.
 */
export const speechFormats = [
  "mp3",
  "opus",
  "aac",
  "flac",
  "wav",
  "pcm",
] as const;

export const SpeechFormatSchema = z.enum(speechFormats);
export type SpeechFormat = z.infer<typeof SpeechFormatSchema>;

/** The media type each synthesis format is returned as. */
export const speechFormatMediaTypes: Readonly<Record<SpeechFormat, string>> = {
  aac: "audio/aac",
  flac: "audio/flac",
  mp3: "audio/mpeg",
  opus: "audio/ogg",
  pcm: "audio/pcm",
  wav: "audio/wav",
};

/**
 * The longest text one synthesis request may carry. A spoken response is a
 * bounded milestone report or one conversation turn, not a document; the cap
 * keeps one request from holding a synthesis worker for minutes and bounds the
 * audio it can return.
 */
export const MAX_SPEECH_TEXT_CHARS = 4000;

/**
 * One synthesis request. `voice` and `language` are hints the provider may
 * honor; `format` names the audio container the caller wants to play.
 */
export const VoiceSpeechRequestSchema = z.strictObject({
  format: SpeechFormatSchema.default("mp3"),
  language: z
    .string()
    .min(1)
    .max(MAX_VOICE_LANGUAGE_LENGTH)
    .nullish()
    .transform((value) => value ?? undefined),
  text: z.string().min(1).max(MAX_SPEECH_TEXT_CHARS),
  voice: z
    .string()
    .min(1)
    .max(64)
    .nullish()
    .transform((value) => value ?? undefined),
});
export type VoiceSpeechRequest = z.infer<typeof VoiceSpeechRequestSchema>;
