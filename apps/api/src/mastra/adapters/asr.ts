import { z } from "zod";

/**
 * Speech-to-text boundary.
 *
 * Voice intake needs one thing from a transcription provider: audio in, text
 * out, behind an interface the product can replace. The provider is therefore
 * resolved from configuration rather than chosen in code, and a deployment
 * without one answers honestly instead of inventing a transcript.
 *
 * Two properties keep that honest:
 *
 * - No adapter exists until `REASONATE_ASR_URL` names an endpoint, so there is
 *   no fallback implementation that could be mistaken for a working one.
 * - A provider failure is raised as `AsrProviderError`, which carries the
 *   status and a message this repository wrote. The provider's own response
 *   body is discarded unread: it is the provider's data, and nothing here has
 *   a reason to hold it.
 *
 * This module never logs. The audio it is handed and the transcript it returns
 * are the user's speech, so both stay in memory for the length of one call.
 */

/** The endpoint that turns speech-to-text on for a deployment. */
const ASR_URL_ENV = "REASONATE_ASR_URL";

/** The bearer token for an endpoint that requires one. */
const ASR_API_KEY_ENV = "REASONATE_ASR_API_KEY";

/** The model the endpoint should transcribe with. */
const ASR_MODEL_ENV = "REASONATE_ASR_MODEL";

/**
 * The refusal a deployment with no transcription provider owes its caller. It
 * is a sentence a person can read that names exactly what is missing, because
 * the operator who can fix it is the one who sees it.
 */
export const ASR_UNCONFIGURED_MESSAGE = `Speech-to-text is not configured for this deployment. Set ${ASR_URL_ENV} to an OpenAI-compatible /audio/transcriptions endpoint.`;

/** Why a provider call failed, as a stable value rather than prose. */
export const ASR_PROVIDER_ERROR = "asr_provider_error";

/**
 * One provider call that did not produce a transcript. The message is a
 * sentence written here and never the provider's response body, so a caller can
 * surface it without leaking another system's output, while the original
 * failure stays attached as the cause for an operator reading a stack trace.
 */
export class AsrProviderError extends Error {
  readonly code = ASR_PROVIDER_ERROR;

  /** The provider's HTTP status, or null when no response arrived at all. */
  readonly status: number | null;

  constructor(
    message: string,
    options: { cause?: unknown; status: number | null }
  ) {
    super(message, { cause: options.cause });
    this.name = "AsrProviderError";
    this.status = options.status;
  }
}

/**
 * The shape the route depends on. A second provider — hosted or local — is a
 * new implementation of this interface and nothing else.
 */
export interface AsrAdapter {
  readonly name: string;
  readonly transcribe: (input: {
    audio: Uint8Array;
    language?: string;
    mediaType: string;
  }) => Promise<{ text: string }>;
}

/** The name this adapter reports in a transcription response. */
export const OPENAI_COMPATIBLE_ASR_NAME = "openai-compatible";

/**
 * How long one provider call may take before it is abandoned. Generous, because
 * a long recording over local inference is slow rather than broken, but finite:
 * a request that waits forever holds its upload for the life of the connection.
 */
const ASR_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The filename the multipart part carries. Endpoints that infer the audio
 * container from the part's name read it here, and the media type the caller
 * sent is the only fact this adapter has to name it with.
 */
const FILENAME_BY_MEDIA_TYPE: Readonly<Partial<Record<string, string>>> = {
  "audio/mp4": "audio.mp4",
  "audio/mpeg": "audio.mp3",
  "audio/ogg": "audio.ogg",
  "audio/wav": "audio.wav",
  "audio/webm": "audio.webm",
};

/**
 * A provider's success body. Only `text` is required: an OpenAI-compatible
 * endpoint is free to add timing, detected language, or segment detail, and a
 * transcript that arrived is not made unusable by the company it keeps.
 */
const TranscriptionResponseSchema = z.object({ text: z.string() });

/**
 * One OpenAI-compatible `/audio/transcriptions` endpoint. The request is the
 * documented multipart form — `file`, plus `model` and `language` when they are
 * configured — and the transcript is the `text` of the JSON reply.
 */
function createOpenAiCompatibleAsr(config: {
  apiKey?: string | undefined;
  model?: string | undefined;
  url: string;
}): AsrAdapter {
  return {
    name: OPENAI_COMPATIBLE_ASR_NAME,
    transcribe: async (input) => {
      const form = new FormData();
      // The adapter is handed a plain `Uint8Array`, while a `BlobPart` must be
      // a view over a non-shared buffer. Re-viewing the identical memory
      // narrows that type without copying the bytes: same buffer, same offset,
      // same length.
      const audio = new Uint8Array(
        input.audio.buffer as ArrayBuffer,
        input.audio.byteOffset,
        input.audio.byteLength
      );
      form.set(
        "file",
        new Blob([audio], { type: input.mediaType }),
        FILENAME_BY_MEDIA_TYPE[input.mediaType] ?? "audio"
      );
      if (config.model !== undefined) {
        form.set("model", config.model);
      }
      if (input.language !== undefined) {
        form.set("language", input.language);
      }

      let response: Response;
      try {
        response = await fetch(config.url, {
          body: form,
          headers:
            config.apiKey === undefined
              ? {}
              : { authorization: `Bearer ${config.apiKey}` },
          method: "POST",
          signal: AbortSignal.timeout(ASR_REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        // No response body exists to leak here: the endpoint was unreachable
        // or refused to answer in time.
        const timedOut =
          error instanceof Error && error.name === "TimeoutError";
        throw new AsrProviderError(
          timedOut
            ? `The transcription endpoint did not answer within ${ASR_REQUEST_TIMEOUT_MS / 1000} seconds.`
            : "The transcription endpoint could not be reached.",
          { cause: error, status: null }
        );
      }

      if (!response.ok) {
        // The body is discarded rather than read. A provider's error text is
        // its own data and can echo what it was sent, so the facts this code
        // keeps are that the call failed and with which status.
        await response.body?.cancel();
        throw new AsrProviderError(
          `The transcription endpoint failed with status ${response.status}.`,
          { status: response.status }
        );
      }

      const payload = TranscriptionResponseSchema.safeParse(
        await response.json().catch(() => undefined)
      );
      if (!payload.success) {
        throw new AsrProviderError(
          `The transcription endpoint answered with status ${response.status} but no transcript.`,
          { status: response.status }
        );
      }

      return { text: payload.data.text };
    },
  };
}

/** The variables this resolver reads. `process.env` satisfies it as-is. */
export type AsrEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * The adapter this deployment can talk to, or `undefined` when none is
 * configured. Absent configuration is not an error and not an empty adapter: it
 * is the reason the route refuses with `voice_unconfigured`, so the caller
 * learns the truth rather than receiving a transcript from nowhere.
 */
export function resolveAsrAdapter(
  env: AsrEnvironment = process.env
): AsrAdapter | undefined {
  const url = env[ASR_URL_ENV]?.trim();
  if (url === undefined || url.length === 0) {
    return undefined;
  }

  const apiKey = env[ASR_API_KEY_ENV]?.trim();
  const model = env[ASR_MODEL_ENV]?.trim();

  return createOpenAiCompatibleAsr({
    ...(apiKey === undefined || apiKey.length === 0 ? {} : { apiKey }),
    ...(model === undefined || model.length === 0 ? {} : { model }),
    url,
  });
}
