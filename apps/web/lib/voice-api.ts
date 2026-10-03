import { CSRF_HEADER } from "@reasonateai/contracts/auth";
import type { SpeechFormat } from "@reasonateai/contracts/voice";
import {
  ApiRequestError,
  apiErrorMessage,
  csrfToken,
  scopeQuery,
} from "./product-api";

/**
 * The product's speech surface, as the browser calls it.
 *
 * Voice mode speaks a completed turn by asking the product to synthesize it;
 * this module owns that one call, so no surface invents its own request shape,
 * loses the CSRF companion the product API expects, or mistakes a refusal for
 * audio.
 */

/** What one synthesis call returns: playable audio and where it came from. */
export interface SynthesizedSpeech {
  audio: Blob;
  mimeType: string;
  provider: string | null;
}

/** One turn of text to speak, with the hints the caller decided. */
export interface SynthesisRequest {
  format?: SpeechFormat;
  language?: string;
  text: string;
  voice?: string;
}

/**
 * Asks the product to speak one turn and returns the audio. A deployment with
 * no synthesis adapter answers with a typed refusal, which arrives here as an
 * `ApiRequestError` whose message is already written for a person — the caller
 * shows it and falls back to the device voice.
 */
export async function synthesizeSpeech(
  input: SynthesisRequest,
  scope: { organizationId: string; projectId: string }
): Promise<SynthesizedSpeech> {
  const csrf = csrfToken();
  const response = await fetch(
    `/v1/voice/speech?${scopeQuery(scope.organizationId, scope.projectId)}`,
    {
      body: JSON.stringify({
        ...(input.format === undefined ? {} : { format: input.format }),
        ...(input.language === undefined ? {} : { language: input.language }),
        text: input.text,
        ...(input.voice === undefined ? {} : { voice: input.voice }),
      }),
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        ...(csrf === undefined ? {} : { [CSRF_HEADER]: csrf }),
      },
      method: "POST",
    }
  );

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    throw new ApiRequestError(
      response.status,
      apiErrorMessage(body, response.status)
    );
  }

  const contentType = response.headers.get("content-type") ?? "audio/mpeg";
  const separator = contentType.indexOf(";");
  return {
    audio: await response.blob(),
    mimeType: (separator === -1
      ? contentType
      : contentType.slice(0, separator)
    ).trim(),
    provider: response.headers.get("x-reasonate-voice-provider"),
  };
}
