import {
  type VisionInput,
  type VisionOutput,
  VisionOutputSchema,
} from "@reasonateai/contracts/sensory";
import type { VisionProvider } from "./vision.adapter.js";
import { getVisionRuntimeConfig } from "./vision.config.js";

export interface OpenAICompatibleVisionProviderOptions {
  apiKey?: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const FENCED_JSON_REGEX = /```(?:json)?\s*([\s\S]*?)\s*```/i;
const TRAILING_SLASH_REGEX = /\/$/;

type ChatMessageContent =
  | string
  | Array<{
      type?: string;
      text?: string;
    }>;

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: ChatMessageContent;
    };
  }>;
}

/**
 * Normalizes the text returned by OpenAI-compatible multimodal servers.
 *
 * Most servers return message.content as a string, but some inference
 * servers may return content as an array of typed parts. We only consume
 * text parts here because the sensory contract expects structured JSON
 * produced by the vision model.
 */
const parseContent = (content: ChatMessageContent | undefined): string => {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const text = content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");

    if (text) {
      return text;
    }
  }

  throw new Error("Vision provider returned no text content");
};

/**
 * Extracts JSON from common LLM response formats.
 *
 * The model is instructed to return JSON, but production inference
 * servers can still return Markdown fences or a small amount of
 * surrounding text. We normalize those cases before Zod validation.
 */
const extractJson = (content: string): string => {
  const trimmed = content.trim();

  // Fast path: model returned a JSON object directly.
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  // Handle responses such as ```json ... ```.
  const fenced = trimmed.match(FENCED_JSON_REGEX);

  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  // Last-resort extraction when the model added text around the object.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");

  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  throw new Error("Vision provider returned invalid JSON");
};

/**
 * Converts arbitrary model output into our stable VisionOutput contract.
 *
 * This is an important provider boundary: downstream agents should never
 * have to know whether the result came from Qwen, another open model, or
 * a future proprietary vision provider.
 */
const parseVisionOutput = (content: string): VisionOutput => {
  const json = extractJson(content);

  let parsed: unknown;

  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error("Vision provider returned invalid JSON", {
      cause: error,
    });
  }

  const result = VisionOutputSchema.safeParse(parsed);

  if (!result.success) {
    throw new Error("Vision provider returned an invalid VisionOutput");
  }

  return result.data;
};

/**
 * Creates a Vision provider for any server exposing an
 * OpenAI-compatible /chat/completions endpoint with multimodal input.
 *
 * Current deployment target:
 *   Qwen3-VL-30B-A3B-Instruct + NVFP4
 *
 * The provider deliberately does not import Qwen-specific SDKs. The model
 * name and endpoint are runtime configuration so the same adapter can be
 * reused if the team later switches inference servers or proprietary
 * models.
 */
export const createOpenAICompatibleVisionProvider = (
  options: OpenAICompatibleVisionProviderOptions
): VisionProvider => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive finite number");
  }

  return {
    async extract(input: VisionInput): Promise<VisionOutput> {
      const controller = new AbortController();

      // Vision inference can be considerably slower than a normal API
      // request, especially when the GPU is busy. AbortController ensures
      // the HTTP request does not remain open indefinitely.
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        // The OpenAI-compatible multimodal protocol expects the image as
        // a data URL. The sensory contract keeps the image provider-neutral
        // as Uint8Array until this boundary.
        const base64 = Buffer.from(input.image).toString("base64");

        const response = await fetch(
          `${options.baseUrl.replace(TRAILING_SLASH_REGEX, "")}/chat/completions`,
          {
            body: JSON.stringify({
              messages: [
                {
                  content: [
                    {
                      text:
                        input.prompt ??
                        [
                          "Analyze this UI/wireframe image.",
                          "Extract the visible UI requirements.",
                          "Return ONLY valid JSON.",
                          'Use exactly this shape: {"summary":"string","elements":[{"type":"string","description":"string","text":"string|null"}]}',
                        ].join(" "),
                      type: "text",
                    },
                    {
                      image_url: {
                        url: `data:${input.mimeType};base64,${base64}`,
                      },
                      type: "image_url",
                    },
                  ],
                  role: "user",
                },
              ],
              model: options.model,
            }),
            headers: {
              "Content-Type": "application/json",
              ...(options.apiKey
                ? {
                    Authorization: `Bearer ${options.apiKey}`,
                  }
                : {}),
            },
            method: "POST",
            signal: controller.signal,
          }
        );

        if (!response.ok) {
          const body = await response.text();

          throw new Error(
            `Vision provider request failed with HTTP ${response.status}: ${body}`
          );
        }

        const payload = (await response.json()) as ChatCompletionResponse;

        const content = payload.choices?.[0]?.message?.content;

        return parseVisionOutput(parseContent(content));
      } finally {
        clearTimeout(timeout);
      }
    },
  };
};

/**
 * Builds the production provider from environment configuration.
 *
 * Keeping configuration outside the provider allows the same implementation
 * to run against local development, a team GPU server, or another
 * OpenAI-compatible inference backend without source-code changes.
 */
export const createConfiguredVisionProvider = (): VisionProvider =>
  createOpenAICompatibleVisionProvider(getVisionRuntimeConfig());
