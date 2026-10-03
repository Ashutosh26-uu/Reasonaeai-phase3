import {
  type SpeechFormat,
  speechFormatMediaTypes,
} from "@reasonateai/contracts/voice";
import { z } from "zod";

/**
 * Text-to-speech boundary.
 *
 * The mirror image of the transcription adapter: a sentence goes to an
 * OpenAI-compatible `/audio/speech` endpoint and audio comes back. A second
 * provider — a streaming model, a hosted service, a different self-hosted
 * server — is a new implementation of `TtsAdapter` and nothing else, which is
 * what keeps the product's model choice replaceable.
 */

/** The endpoint that turns text-to-speech on for a deployment. */
const TTS_URL_ENV = "REASONATE_TTS_URL";

/** The bearer token for an endpoint that requires one. */
const TTS_API_KEY_ENV = "REASONATE_TTS_API_KEY";

/** The model the endpoint should synthesize with. */
const TTS_MODEL_ENV = "REASONATE_TTS_MODEL";

/** The voice used when a caller does not name one. */
const TTS_VOICE_ENV = "REASONATE_TTS_VOICE";

/**
 * The refusal a deployment with no synthesis provider owes its caller. It names
 * exactly what is missing, because the operator who can fix it is the one who
 * sees it.
 */
export const TTS_UNCONFIGURED_MESSAGE = `Text-to-speech is not configured for this deployment. Set ${TTS_URL_ENV} to an OpenAI-compatible /audio/speech endpoint.`;

/** Why a provider call failed, as a stable value rather than prose. */
export const TTS_PROVIDER_ERROR = "tts_provider_error";

/**
 * One provider call that did not produce audio. The message is a sentence
 * written here and never the provider's response body, so a caller can surface
 * it without leaking another system's output, while the original failure stays
 * attached as the cause for an operator reading a stack trace.
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
 * The shape the route depends on. The result carries the bytes and the media
 * type the provider answered with, so the route can play what actually arrived
 * rather than what was asked for.
 */
export interface TtsAdapter {
  readonly name: string;
  readonly synthesize: (input: {
    format?: SpeechFormat;
    language?: string;
    text: string;
    voice?: string;
  }) => Promise<{ audio: Uint8Array; mediaType: string }>;
}

/** The name this adapter reports in a synthesis response. */
export const OPENAI_COMPATIBLE_TTS_NAME = "openai-compatible";

/**
 * How long one synthesis call may take before it is abandoned. Speech is
 * generated for a bounded turn rather than a document, so this is shorter than
 * the transcription window — but still finite for the same reason: a request
 * that waits forever holds its connection for the life of the process.
 */
const TTS_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * The most audio one synthesis call may return. A full speech request at the
 * text cap is a few minutes of audio, so anything past this is a misbehaving
 * endpoint rather than a large but valid answer, and it is refused instead of
 * buffered.
 */
const MAX_SPEECH_AUDIO_BYTES = 16 * 1024 * 1024;

/**
 * A provider's reply headers. Only the media type is read: the format the
 * caller asked for is a request, and the container that arrived is a fact.
 */
const AudioContentTypeSchema = z
  .string()
  .transform((value) => (value.split(";")[0] ?? "").trim().toLowerCase())
  .pipe(z.string().startsWith("audio/"));

/** The provider configuration one adapter instance was built from. */
interface OpenAiCompatibleTtsConfig {
  apiKey?: string | undefined;
  model?: string | undefined;
  url: string;
  voice?: string | undefined;
}

/**
 * The documented `/audio/speech` JSON body. Only the fields this deployment or
 * the caller actually decided are sent: an endpoint that validates strictly
 * must not be handed empty hints it would have to reject.
 */
function speechRequestBody(
  config: OpenAiCompatibleTtsConfig,
  input: {
    format?: SpeechFormat;
    language?: string;
    text: string;
    voice?: string;
  }
): Record<string, string> {
  const body: Record<string, string> = {
    input: input.text,
    response_format: input.format ?? "mp3",
  };
  const voice = input.voice ?? config.voice;
  if (voice !== undefined) {
    body.voice = voice;
  }
  if (config.model !== undefined) {
    body.model = config.model;
  }
  if (input.language !== undefined) {
    body.language = input.language;
  }
  return body;
}

/**
 * One call to the endpoint, where every failure becomes a sentence written
 * here. The reply is returned whole when it is a success; a failure reply's
 * body is discarded rather than read, because a provider's error text is its
 * own data and can echo what it was sent.
 */
async function fetchSpeech(
  config: OpenAiCompatibleTtsConfig,
  body: Record<string, string>
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(config.url, {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        ...(config.apiKey === undefined
          ? {}
          : { authorization: `Bearer ${config.apiKey}` }),
      },
      method: "POST",
      signal: AbortSignal.timeout(TTS_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // No response body exists to leak here: the endpoint was unreachable or
    // refused to answer in time.
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new TtsProviderError(
      timedOut
        ? `The synthesis endpoint did not answer within ${TTS_REQUEST_TIMEOUT_MS / 1000} seconds.`
        : "The synthesis endpoint could not be reached.",
      { cause: error, status: null }
    );
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new TtsProviderError(
      `The synthesis endpoint failed with status ${response.status}.`,
      { status: response.status }
    );
  }
  return response;
}

/**
 * The audio a successful reply carries. The media type is read from the reply
 * when it states one, because the container that arrived is a fact and the
 * format the caller asked for was only a request.
 */
async function readSpeechAudio(
  response: Response,
  format: SpeechFormat
): Promise<{ audio: Uint8Array; mediaType: string }> {
  const audio = new Uint8Array(await response.arrayBuffer());
  if (audio.byteLength === 0) {
    throw new TtsProviderError(
      `The synthesis endpoint answered with status ${response.status} but no audio.`,
      { status: response.status }
    );
  }
  if (audio.byteLength > MAX_SPEECH_AUDIO_BYTES) {
    throw new TtsProviderError(
      "The synthesis endpoint returned more audio than this deployment accepts.",
      { status: response.status }
    );
  }

  const contentType = AudioContentTypeSchema.safeParse(
    response.headers.get("content-type")
  );
  return {
    audio,
    mediaType: contentType.success
      ? contentType.data
      : speechFormatMediaTypes[format],
  };
}

/**
 * One OpenAI-compatible `/audio/speech` endpoint. The request is the documented
 * JSON body — `input`, plus `model`, `voice`, `response_format`, and a language
 * hint when the caller sent one — and the answer is the audio itself.
 */
function createOpenAiCompatibleTts(
  config: OpenAiCompatibleTtsConfig
): TtsAdapter {
  return {
    name: OPENAI_COMPATIBLE_TTS_NAME,
    synthesize: async (input) => {
      const format: SpeechFormat = input.format ?? "mp3";
      const response = await fetchSpeech(
        config,
        speechRequestBody(config, input)
      );
      return readSpeechAudio(response, format);
    },
  };
}

/** The variables this resolver reads. `process.env` satisfies it as-is. */
export type TtsEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * The adapter this deployment can talk to, or `undefined` when none is
 * configured. Absent configuration is not an error and not an empty adapter: it
 * is the reason the route refuses with `voice_unconfigured`, so the caller
 * learns the truth rather than receiving speech from nowhere.
 */
export function resolveTtsAdapter(
  env: TtsEnvironment = process.env
): TtsAdapter | undefined {
  const url = env[TTS_URL_ENV]?.trim();
  if (url === undefined || url.length === 0) {
    return undefined;
  }

  const apiKey = env[TTS_API_KEY_ENV]?.trim();
  const model = env[TTS_MODEL_ENV]?.trim();
  const voice = env[TTS_VOICE_ENV]?.trim();

  return createOpenAiCompatibleTts({
    ...(apiKey === undefined || apiKey.length === 0 ? {} : { apiKey }),
    ...(model === undefined || model.length === 0 ? {} : { model }),
    ...(voice === undefined || voice.length === 0 ? {} : { voice }),
    url,
  });
}
