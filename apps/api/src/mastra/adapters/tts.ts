/**
 * Text-to-speech boundary.
 *
 * Speech synthesis converts assistant text into spoken audio behind an
 * interface the product can replace. The provider is resolved from configuration
 * rather than hard-coded, and a deployment without one answers honestly instead
 * of inventing audio or failing silently.
 *
 * Three properties keep that honest:
 *
 * - No adapter exists until `REASONATE_TTS_URL` (or `TTS_URL`) names an endpoint,
 *   so there is no fallback implementation that could be mistaken for a working one.
 * - A provider failure is raised as `TtsProviderError`, which carries the
 *   status and a message this repository wrote. The provider's own response
 *   body is discarded unread: it is external data, and nothing here has
 *   a reason to hold it.
 * - Audio and text are never logged. The text it receives and the audio it produces
 *   remain in memory for the duration of the request only.
 */

/** Primary endpoint variable that turns speech synthesis on for a deployment. */
export const TTS_URL_ENV = "REASONATE_TTS_URL";
export const TTS_URL_FALLBACK_ENV = "TTS_URL";

/** Bearer token for an endpoint that requires one. */
export const TTS_API_KEY_ENV = "REASONATE_TTS_API_KEY";
export const TTS_API_KEY_FALLBACK_ENV = "TTS_API_KEY";

/** Default voicepack identifier. */
export const TTS_VOICE_ENV = "REASONATE_TTS_VOICE";
export const TTS_VOICE_FALLBACK_ENV = "TTS_VOICE";

/** Model identifier for OpenAI-compatible endpoints. */
export const TTS_MODEL_ENV = "REASONATE_TTS_MODEL";
export const TTS_MODEL_FALLBACK_ENV = "TTS_MODEL";

/** Request timeout in milliseconds. */
export const TTS_TIMEOUT_ENV = "REASONATE_TTS_TIMEOUT_MS";
export const TTS_TIMEOUT_FALLBACK_ENV = "TTS_TIMEOUT_MS";

/** Default Kokoro voicepack. Matches services/kokoro-tts default. */
export const DEFAULT_TTS_VOICE = "af_heart";

/** Default model parameter sent to OpenAI-compatible speech endpoints. */
export const DEFAULT_TTS_MODEL = "kokoro";

/** Default audio format. */
export const DEFAULT_TTS_FORMAT = "mp3";

/** Default timeout for text-to-speech synthesis (60 seconds). */
export const DEFAULT_TTS_TIMEOUT_MS = 60_000;

/** Provider name for OpenAI-compatible TTS. */
export const OPENAI_COMPATIBLE_TTS_NAME = "openai-compatible";

/**
 * The refusal a deployment with no synthesis provider owes its caller. It names
 * exactly what is missing so the operator who can configure it sees the remedy.
 */
export const TTS_UNCONFIGURED_MESSAGE = `Text-to-speech is not configured for this deployment. Set ${TTS_URL_ENV} to an OpenAI-compatible /audio/speech endpoint.`;

/** Stable error code for provider failures. */
export const TTS_PROVIDER_ERROR = "tts_provider_error";

/**
 * One provider call that did not produce speech. The message is written here
 * and never the provider's response body, so a caller can surface it safely
 * without leaking remote state.
 */
export class TtsProviderError extends Error {
  readonly code = TTS_PROVIDER_ERROR;

  /** The provider's HTTP status, or null when no response arrived at all. */
  readonly status: number | null;

  constructor(
    message: string,
    options: { cause?: unknown; status: number | null }
  ) {
    super(message, { cause: options.cause });
    this.name = "TtsProviderError";
    this.status = options.status;
  }
}

/**
 * The shape the speech synthesis route depends on.
 */
export interface TtsAdapter {
  readonly defaultVoice: string;
  readonly name: string;
  readonly synthesize: (input: {
    format?: string;
    speed?: number;
    text: string;
    voice?: string;
  }) => Promise<{
    audio: Uint8Array;
    mediaType: string;
  }>;
}

export interface OpenAiCompatibleTtsOptions {
  apiKey?: string | undefined;
  defaultVoice?: string | undefined;
  model?: string | undefined;
  timeoutMs?: number | undefined;
  url: string;
}

const MEDIA_TYPE_BY_FORMAT: Readonly<Record<string, string>> = {
  aac: "audio/aac",
  flac: "audio/flac",
  mp3: "audio/mpeg",
  opus: "audio/ogg; codecs=opus",
  pcm: "audio/pcm",
  wav: "audio/wav",
};

/**
 * Adapter for OpenAI-compatible `/v1/audio/speech` endpoints (such as Kokoro-FastAPI).
 */
export class OpenAiCompatibleTtsAdapter implements TtsAdapter {
  readonly name = OPENAI_COMPATIBLE_TTS_NAME;
  readonly defaultVoice: string;
  private readonly apiKey: string | undefined;
  private readonly model: string | undefined;
  private readonly timeoutMs: number;
  private readonly url: string;

  constructor(options: OpenAiCompatibleTtsOptions) {
    this.url = options.url;
    this.apiKey = options.apiKey;
    this.defaultVoice = options.defaultVoice ?? DEFAULT_TTS_VOICE;
    this.model = options.model ?? DEFAULT_TTS_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TTS_TIMEOUT_MS;
  }

  async synthesize(input: {
    format?: string;
    speed?: number;
    text: string;
    voice?: string;
  }): Promise<{ audio: Uint8Array; mediaType: string }> {
    const format = input.format ?? DEFAULT_TTS_FORMAT;
    const voice = input.voice ?? this.defaultVoice;
    const body = JSON.stringify({
      input: input.text,
      model: this.model,
      response_format: format,
      speed: input.speed ?? 1.0,
      voice,
    });

    let response: Response;
    try {
      response = await fetch(this.url, {
        body,
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey === undefined || this.apiKey.length === 0
            ? {}
            : { Authorization: `Bearer ${this.apiKey}` }),
        },
        method: "POST",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new TtsProviderError(
        timedOut
          ? `The speech endpoint did not answer within ${this.timeoutMs / 1000} seconds.`
          : "The speech endpoint could not be reached.",
        { cause: error, status: null }
      );
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new TtsProviderError(
        `The speech endpoint failed with status ${response.status}.`,
        { status: response.status }
      );
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0) {
      throw new TtsProviderError(
        `The speech endpoint answered with status ${response.status} but no audio.`,
        { status: response.status }
      );
    }

    const rawContentType = response.headers.get("content-type")?.trim();
    const mediaType =
      rawContentType && rawContentType.length > 0
        ? rawContentType.split(";")[0]?.trim() ||
          (MEDIA_TYPE_BY_FORMAT[format] ?? "audio/mpeg")
        : (MEDIA_TYPE_BY_FORMAT[format] ?? "audio/mpeg");

    return {
      audio: new Uint8Array(buffer),
      mediaType,
    };
  }
}

/** Environment dictionary accepted by TTS resolution. */
export type TtsEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Creates a configured TTS adapter from environment variables, or returns `undefined`
 * if no endpoint is configured.
 */
export function createTtsAdapterFromEnv(
  env: TtsEnvironment = process.env
): TtsAdapter | undefined {
  const url = env[TTS_URL_ENV]?.trim() || env[TTS_URL_FALLBACK_ENV]?.trim();
  if (!url || url.length === 0) {
    return undefined;
  }

  const apiKey =
    env[TTS_API_KEY_ENV]?.trim() || env[TTS_API_KEY_FALLBACK_ENV]?.trim();
  const defaultVoice =
    env[TTS_VOICE_ENV]?.trim() || env[TTS_VOICE_FALLBACK_ENV]?.trim();
  const model =
    env[TTS_MODEL_ENV]?.trim() || env[TTS_MODEL_FALLBACK_ENV]?.trim();

  const rawTimeout =
    env[TTS_TIMEOUT_ENV]?.trim() || env[TTS_TIMEOUT_FALLBACK_ENV]?.trim();
  const parsedTimeout = rawTimeout
    ? Number.parseInt(rawTimeout, 10)
    : undefined;
  const timeoutMs =
    parsedTimeout && Number.isFinite(parsedTimeout) && parsedTimeout > 0
      ? parsedTimeout
      : DEFAULT_TTS_TIMEOUT_MS;

  return new OpenAiCompatibleTtsAdapter({
    apiKey: apiKey && apiKey.length > 0 ? apiKey : undefined,
    defaultVoice:
      defaultVoice && defaultVoice.length > 0
        ? defaultVoice
        : DEFAULT_TTS_VOICE,
    model: model && model.length > 0 ? model : DEFAULT_TTS_MODEL,
    timeoutMs,
    url,
  });
}

/** Alias for createTtsAdapterFromEnv matching resolveAsrAdapter. */
export const resolveTtsAdapter = createTtsAdapterFromEnv;
