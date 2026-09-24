import { z } from "zod";

// -----------------------------------------------------------------------------
// Common
// -----------------------------------------------------------------------------

export const SensoryProviderStatusSchema = z.enum([
  "ready",
  "degraded",
  "unavailable",
]);

export type SensoryProviderStatus = z.infer<typeof SensoryProviderStatusSchema>;

// -----------------------------------------------------------------------------
// ASR (Automatic Speech Recognition)
// -----------------------------------------------------------------------------

export const ASRInputSchema = z.strictObject({
  audio: z.instanceof(Uint8Array),
  language: z.string().min(1).nullable(),
  mimeType: z.string().min(1),
});

export type ASRInput = z.infer<typeof ASRInputSchema>;

export const ASROutputSchema = z.strictObject({
  confidence: z.number().min(0).max(1).nullable(),
  language: z.string().min(1).nullable(),
  text: z.string(),
});

export type ASROutput = z.infer<typeof ASROutputSchema>;

export interface ASRAdapter {
  transcribe: (input: ASRInput) => Promise<ASROutput>;
}

// -----------------------------------------------------------------------------
// TTS (Text-to-Speech)
// -----------------------------------------------------------------------------

export const TTSInputSchema = z.strictObject({
  language: z.string().min(1).nullable(),
  text: z.string().min(1),
  voice: z.string().min(1).nullable(),
});

export type TTSInput = z.infer<typeof TTSInputSchema>;

export const TTSOutputSchema = z.strictObject({
  audio: z.instanceof(Uint8Array),
  durationMs: z.number().nonnegative().nullable(),
  mimeType: z.string().min(1),
});

export type TTSOutput = z.infer<typeof TTSOutputSchema>;

export interface TTSAdapter {
  synthesize: (input: TTSInput) => Promise<TTSOutput>;
}

// -----------------------------------------------------------------------------
// Vision
// -----------------------------------------------------------------------------

export const VisionInputSchema = z.strictObject({
  image: z.instanceof(Uint8Array),
  mimeType: z.string().min(1),
});

export type VisionInput = z.infer<typeof VisionInputSchema>;

export const VisionElementSchema = z.strictObject({
  description: z.string().min(1),
  text: z.string().nullable(),
  type: z.string().min(1),
});

export type VisionElement = z.infer<typeof VisionElementSchema>;

export const VisionOutputSchema = z.strictObject({
  elements: z.array(VisionElementSchema),
  summary: z.string(),
});

export type VisionOutput = z.infer<typeof VisionOutputSchema>;

export interface VisionAdapter {
  extract: (input: VisionInput) => Promise<VisionOutput>;
}
