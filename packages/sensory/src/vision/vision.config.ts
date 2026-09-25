export interface VisionRuntimeConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
}

export const getVisionRuntimeConfig = (): VisionRuntimeConfig => {
  const baseUrl = process.env.VISION_BASE_URL;
  const model = process.env.VISION_MODEL;

  if (!baseUrl) {
    throw new Error("VISION_BASE_URL is required");
  }

  if (!model) {
    throw new Error("VISION_MODEL is required");
  }

  const timeoutMs = process.env.VISION_TIMEOUT_MS
    ? Number(process.env.VISION_TIMEOUT_MS)
    : undefined;

  if (
    timeoutMs !== undefined &&
    (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
  ) {
    throw new Error("VISION_TIMEOUT_MS must be a positive finite number");
  }

  const config: VisionRuntimeConfig = {
    baseUrl,
    model,
  };

  // Only add optional values when they actually exist.
  // This is required because the repository enables
  // exactOptionalPropertyTypes in TypeScript.
  if (process.env.VISION_API_KEY) {
    config.apiKey = process.env.VISION_API_KEY;
  }

  if (timeoutMs !== undefined) {
    config.timeoutMs = timeoutMs;
  }

  return config;
};
