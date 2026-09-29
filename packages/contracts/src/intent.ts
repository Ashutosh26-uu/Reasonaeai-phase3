import { z } from "zod";

// Shared Typed Error Structure
export const SurfaceErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  userMessage: z.string(),
});
export type SurfaceError = z.infer<typeof SurfaceErrorSchema>;

// Voice Capture
export const VoiceCaptureStatusSchema = z.enum([
  "idle",
  "recording",
  "processing",
  "completed",
  "permission-required",
  "permission-denied",
  "unsupported",
  "failed",
]);
export type VoiceCaptureStatus = z.infer<typeof VoiceCaptureStatusSchema>;

export const EditableSpecificationSchema = z.object({
  description: z.string(),
  requirements: z.array(z.string()),
  title: z.string(),
});
export type EditableSpecification = z.infer<typeof EditableSpecificationSchema>;

export const VoiceCaptureResultSchema = z.object({
  error: SurfaceErrorSchema.optional(),
  specification: EditableSpecificationSchema.optional(),
});
export type VoiceCaptureResult = z.infer<typeof VoiceCaptureResultSchema>;

// Wireframe Upload
export const WireframeUploadStatusSchema = z.enum([
  "empty",
  "selected",
  "uploading",
  "processing",
  "completed",
  "unsupported",
  "failed",
]);
export type WireframeUploadStatus = z.infer<typeof WireframeUploadStatusSchema>;

export const StructuredIntentSchema = z.object({
  components: z.array(z.string()),
  inferredFeatures: z.array(z.string()),
  screens: z.array(z.string()),
  workflow: z.string(),
});
export type StructuredIntent = z.infer<typeof StructuredIntentSchema>;

export const WireframeUploadResultSchema = z.object({
  error: SurfaceErrorSchema.optional(),
  intent: StructuredIntentSchema.optional(),
});
export type WireframeUploadResult = z.infer<typeof WireframeUploadResultSchema>;
