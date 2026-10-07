import { authorize } from "@reasonateai/auth/authorize";
import type { ApiErrorCode } from "@reasonateai/contracts/api-error";
import {
  type OrganizationId,
  OrganizationIdSchema,
  type Permission,
  type ProjectId,
  ProjectIdSchema,
  type UserPrincipal,
} from "@reasonateai/contracts/identity";
import {
  VOICE_SPEECH_PATH as CONTRACT_VOICE_SPEECH_PATH,
  VOICE_TRANSCRIPTION_PATH as CONTRACT_VOICE_TRANSCRIPTION_PATH,
  SpeechRequestSchema,
} from "@reasonateai/contracts/voice";
import type { ProjectStateStore } from "@reasonateai/project-state/postgres";
import { z } from "zod";
import {
  ASR_UNCONFIGURED_MESSAGE,
  type AsrAdapter,
  AsrProviderError,
} from "../adapters/asr";
import {
  TTS_UNCONFIGURED_MESSAGE,
  type TtsAdapter,
  TtsProviderError,
} from "../adapters/tts";
import { apiErrorResponse, unauthenticatedResponse } from "../principal";
import { auditEvent } from "./auth";

/**
 * Voice intake routes.
 *
 * Transcription exists to produce a turn: the caller speaks, this route turns
 * the recording into text, and the browser puts that text in front of the
 * person who decides whether to send it. Nothing here writes product state, so
 * nothing here is a security transition — the turn a person actually sends is
 * recorded in the run ledger, which is the authoritative record of it.
 *
 * Three properties make the route honest:
 *
 * - It is authorized like a run, because a transcript only exists to feed one.
 *   Tenant scope comes from the query string and is verified against
 *   membership, never trusted as-is.
 * - The provider is resolved per request. When no endpoint is configured the
 *   route refuses with `voice_unconfigured`, naming the setting that is
 *   missing, rather than answering with text from nowhere.
 * - Audio, transcripts, and provider response bodies are never logged. The only
 *   record this route can write is an authorization denial, which carries a
 *   reason and no content.
 */

/**
 * Product routes live outside the `/api` prefix on purpose, the same as the
 * other product routes: the ingress denial blocks every built-in Mastra route
 * group under `/api`.
 */
export const VOICE_TRANSCRIPTION_PATH = CONTRACT_VOICE_TRANSCRIPTION_PATH;
export const VOICE_SPEECH_PATH = CONTRACT_VOICE_SPEECH_PATH;

/** Largest audio payload this route accepts, in bytes. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/**
 * The media types a transcription may arrive as. A browser records WebM/Opus,
 * but a client may legitimately upload an existing file instead, so every
 * container the adapter can forward is accepted here.
 */
const ACCEPTED_AUDIO_MEDIA_TYPES: Readonly<Partial<Record<string, true>>> = {
  "audio/mp4": true,
  "audio/mpeg": true,
  "audio/ogg": true,
  "audio/wav": true,
  "audio/webm": true,
};

/**
 * Room above the audio cap for the multipart envelope itself: boundaries, part
 * headers, and the short `language` field. Without it, a body carrying exactly
 * the maximum audio would be refused for the framing wrapped around it.
 */
const MULTIPART_ENVELOPE_BYTES = 8 * 1024;

/** The largest language tag forwarded to a provider. */
const MAX_LANGUAGE_LENGTH = 64;

/**
 * Refusals this route states in its own vocabulary. They describe the voice
 * operation rather than the caller's authority or the shape of a generic
 * request, and each carries the status the clients were built against, so they
 * live here instead of in the shared product error codes.
 */
const VOICE_UNCONFIGURED_CODE = "voice_unconfigured";
const VOICE_UPLOAD_TOO_LARGE_CODE = "voice_upload_too_large";
const VOICE_UNSUPPORTED_MEDIA_TYPE_CODE = "voice_unsupported_media_type";

/**
 * What a caller gets back: the transcript, the language it was transcribed in
 * when the caller named one, and which adapter produced it, so a client can say
 * where the text came from.
 */
const TranscriptionSchema = z.strictObject({
  language: z.string().min(1).max(MAX_LANGUAGE_LENGTH).nullable(),
  provider: z.string().min(1).max(64),
  text: z.string(),
});

/**
 * Maps a contract denial reason to a client-facing code. Insufficient authority
 * and absent membership both surface as `forbidden`, so a denial never reveals
 * whether a resource exists in another tenant.
 */
const DENIAL_BY_REASON: Record<string, ApiErrorCode> = {
  CAPABILITY_EXPIRED: "unauthenticated",
  MEMBERSHIP_PRINCIPAL_MISMATCH: "forbidden",
  ORGANIZATION_MEMBERSHIP_INACTIVE: "forbidden",
  ORGANIZATION_MEMBERSHIP_REQUIRED: "forbidden",
  ORGANIZATION_SCOPE_MISMATCH: "forbidden",
  PERMISSION_DENIED: "forbidden",
  PROJECT_MEMBERSHIP_INACTIVE: "forbidden",
  PROJECT_MEMBERSHIP_REQUIRED: "forbidden",
  PROJECT_SCOPE_MISMATCH: "forbidden",
  SESSION_EXPIRED: "unauthenticated",
  SESSION_REVOKED: "unauthenticated",
  UNAUTHENTICATED: "unauthenticated",
};

/**
 * The subset of a Hono `Context` this route uses. Declaring it structurally
 * keeps the handler exercisable without constructing a server, while Hono's
 * real context remains assignable.
 */
export interface VoiceHandlerContext {
  json: (body: unknown, status: number) => Response;
  req: {
    header: (name: string) => string | undefined;
    query: (name: string) => string | undefined;
    raw: { body: ReadableStream<Uint8Array> | null };
  };
}

export interface VoiceRouteDeps {
  /**
   * Resolved per request so the adapter is built only when this deployment has
   * an endpoint configured, and `undefined` is the honest answer when it does
   * not.
   */
  asr: () => AsrAdapter | undefined;
  resolvePrincipal: (input: {
    cookieHeader: string | undefined;
  }) => Promise<UserPrincipal | undefined>;
  /**
   * Resolved per request so the store is created only when the authoritative
   * database is configured, and so tests can inject their own.
   */
  store: () => ProjectStateStore;
  /**
   * Resolved per request so the speech synthesis adapter is built only when
   * this deployment has an endpoint configured, and `undefined` when it does not.
   */
  tts?: () => TtsAdapter | undefined;
}

/**
 * A refusal whose status is not one the shared error codes carry. The body is
 * the same product envelope every other refusal uses, so a client switches on
 * `code` exactly as it does elsewhere, and the message is written to be shown
 * to a person as-is.
 */
function voiceErrorResponse(input: {
  code: string;
  message: string;
  requestId: string;
  status: number;
}): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: input.code,
        message: input.message,
        requestId: input.requestId,
      },
    }),
    {
      headers: { "Content-Type": "application/json" },
      status: input.status,
    }
  );
}

/**
 * The one refusal an oversized upload gets, wherever it is noticed: a declared
 * length that cannot fit, a body that runs past the cap while it is read, or an
 * audio part larger than the cap. One message keeps the stated limit and the
 * enforced limit from drifting apart.
 */
function tooLargeResponse(requestId: string): Response {
  return voiceErrorResponse({
    code: VOICE_UPLOAD_TOO_LARGE_CODE,
    message: `An audio recording may not exceed ${MAX_AUDIO_BYTES} bytes.`,
    requestId,
    status: 413,
  });
}

/**
 * The media type without its parameters. A browser records WebM/Opus and sends
 * `audio/webm;codecs=opus`, which is the same container this route accepts, so
 * the parameters are dropped rather than treated as a different type.
 */
function baseMediaType(value: string): string {
  return (value.split(";")[0] ?? "").trim().toLowerCase();
}

/** The outcome of reading an upload: its bytes, or why it was refused. */
type UploadRead =
  | { bytes: Uint8Array<ArrayBuffer>; ok: true }
  | { ok: false; refusal: "too_large" | "unreadable" };

/**
 * Reads the request body, stopping as soon as it exceeds the cap.
 *
 * The bytes are collected here rather than handed straight to `formData()`
 * because only this loop can refuse an oversized upload before it is buffered:
 * a parsed multipart body already holds the whole audio part in memory by the
 * time its length is known, so the cap would describe a request that had
 * already been accepted. Returning early closes the stream, which stops an
 * oversized upload from being drained to its end.
 */
async function readBoundedUpload(
  body: ReadableStream<Uint8Array>,
  limit: number
): Promise<UploadRead> {
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for await (const chunk of body) {
      total += chunk.byteLength;
      if (total > limit) {
        return { ok: false, refusal: "too_large" };
      }
      chunks.push(chunk);
    }
  } catch {
    return { ok: false, refusal: "unreadable" };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { bytes, ok: true };
}

/** The audio and options one accepted upload carries. */
interface AudioUpload {
  audio: Uint8Array<ArrayBuffer>;
  language: string | undefined;
  mediaType: string;
}

/**
 * Reads and validates the multipart upload, returning either the audio the
 * adapter will transcribe or the typed refusal the caller is owed. Everything
 * the request can be wrong about — framing, size, container, language — is
 * decided here, so the handler stays about transcription.
 */
async function readAudioUpload(
  c: VoiceHandlerContext,
  requestId: string
): Promise<AudioUpload | Response> {
  const contentType = c.req.header("content-type")?.trim() ?? "";
  if (baseMediaType(contentType) !== "multipart/form-data") {
    return apiErrorResponse({
      code: "invalid_request",
      message:
        "The request must be multipart/form-data carrying one audio field.",
      requestId,
    });
  }

  const uploadLimit = MAX_AUDIO_BYTES + MULTIPART_ENVELOPE_BYTES;

  // A declared length that cannot fit is refused before the body is read at
  // all; the bounded read below is what holds when the header is absent or does
  // not match the bytes that follow.
  const declaredLength = Number(c.req.header("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > uploadLimit) {
    return tooLargeResponse(requestId);
  }

  const { body } = c.req.raw;
  if (body === null) {
    return apiErrorResponse({
      code: "invalid_request",
      message: "The request must carry a multipart audio upload.",
      requestId,
    });
  }

  const upload = await readBoundedUpload(body, uploadLimit);
  if (!upload.ok) {
    return upload.refusal === "too_large"
      ? tooLargeResponse(requestId)
      : apiErrorResponse({
          code: "invalid_request",
          message: "The upload could not be read.",
          requestId,
        });
  }

  let form: FormData;
  try {
    form = await new Response(upload.bytes, {
      headers: { "content-type": contentType },
    }).formData();
  } catch {
    return apiErrorResponse({
      code: "invalid_request",
      message: "The multipart body could not be read.",
      requestId,
    });
  }

  const audio = form.get("audio");
  if (!(audio instanceof Blob)) {
    return apiErrorResponse({
      code: "invalid_request",
      message: "A multipart request with one audio file field is required.",
      requestId,
    });
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    return tooLargeResponse(requestId);
  }

  const mediaType = baseMediaType(audio.type);
  if (ACCEPTED_AUDIO_MEDIA_TYPES[mediaType] !== true) {
    return voiceErrorResponse({
      code: VOICE_UNSUPPORTED_MEDIA_TYPE_CODE,
      message: `Audio must be one of ${Object.keys(ACCEPTED_AUDIO_MEDIA_TYPES).join(", ")}; this upload was ${mediaType.length === 0 ? "sent without a media type" : mediaType}.`,
      requestId,
      status: 415,
    });
  }

  const languageField = form.get("language");
  if (languageField !== null && typeof languageField !== "string") {
    return apiErrorResponse({
      code: "invalid_request",
      message: "The optional language field must be text.",
      requestId,
    });
  }
  const language = (languageField ?? "").trim();
  if (language.length > MAX_LANGUAGE_LENGTH) {
    return apiErrorResponse({
      code: "invalid_request",
      message: `A language tag may not exceed ${MAX_LANGUAGE_LENGTH} characters.`,
      requestId,
    });
  }

  if (audio.size === 0) {
    return apiErrorResponse({
      code: "invalid_request",
      message: "The audio upload is empty.",
      requestId,
    });
  }

  return {
    audio: new Uint8Array(await audio.arrayBuffer()),
    language: language.length === 0 ? undefined : language,
    mediaType,
  };
}

async function authorizeProjectAction(input: {
  action: Permission;
  deps: VoiceRouteDeps;
  organizationId: OrganizationId;
  principal: UserPrincipal;
  projectId: ProjectId;
}) {
  const organizationMembership = await input.deps
    .store()
    .memberships.getOrganizationMembership({
      organizationId: input.organizationId,
      userId: input.principal.userId,
    });

  const projectMembership = await input.deps
    .store()
    .memberships.getProjectMembership({
      organizationId: input.organizationId,
      projectId: input.projectId,
      userId: input.principal.userId,
    });

  return authorize({
    action: input.action,
    now: new Date().toISOString(),
    organizationMembership: organizationMembership ?? null,
    principal: input.principal,
    projectMembership: projectMembership ?? null,
    resource: {
      kind: "project",
      organizationId: input.organizationId,
      projectId: input.projectId,
      resourceId: null,
    },
  });
}

/**
 * The refusal a caller is owed, or `undefined` once they may transcribe here.
 * Authentication, both scope identifiers, and the centralized decision are one
 * question, so they are answered in one place: the identifiers in the query are
 * a scope to authorize, never proof of access.
 */
async function authorizeVoiceRequest(input: {
  action?: Permission;
  context: VoiceHandlerContext;
  denialMessage?: string;
  deps: VoiceRouteDeps;
  requestId: string;
}): Promise<Response | undefined> {
  const principal = await input.deps.resolvePrincipal({
    cookieHeader: input.context.req.header("cookie"),
  });
  if (!principal) {
    return unauthenticatedResponse(input.requestId);
  }

  const organizationId = OrganizationIdSchema.safeParse(
    input.context.req.query("organizationId")
  );
  const projectId = ProjectIdSchema.safeParse(
    input.context.req.query("projectId")
  );
  if (!(organizationId.success && projectId.success)) {
    return apiErrorResponse({
      code: "invalid_request",
      message: "Both scope identifiers are required.",
      requestId: input.requestId,
    });
  }

  const action = input.action ?? "agent:run";
  const decision = await authorizeProjectAction({
    action,
    deps: input.deps,
    organizationId: organizationId.data,
    principal,
    projectId: projectId.data,
  });
  if (decision.allowed) {
    return undefined;
  }

  // A refused voice request is a security-relevant decision and is recorded as
  // one. The reason stays in the trail, where an operator needs it, and never
  // reaches the caller.
  await input.deps.store().audit.record(
    auditEvent({
      action: "authorization.denied",
      actor: principal,
      metadata: { action, reason: decision.reason },
      organizationId: organizationId.data,
      projectId: projectId.data,
      requestId: input.requestId,
    })
  );

  return apiErrorResponse({
    code: DENIAL_BY_REASON[decision.reason] ?? "forbidden",
    message:
      input.denialMessage ??
      "You are not authorized to run this project's CTO.",
    requestId: input.requestId,
  });
}

async function parseSpeechBody(
  c: VoiceHandlerContext,
  rid: string
): Promise<
  | { ok: true; data: z.infer<typeof SpeechRequestSchema> }
  | { ok: false; response: Response }
> {
  const contentType = c.req.header("content-type")?.trim() ?? "";
  if (baseMediaType(contentType) !== "application/json") {
    return {
      ok: false,
      response: apiErrorResponse({
        code: "invalid_request",
        message:
          "The request must be application/json carrying text to synthesize.",
        requestId: rid,
      }),
    };
  }

  const { body } = c.req.raw;
  if (body === null) {
    return {
      ok: false,
      response: apiErrorResponse({
        code: "invalid_request",
        message: "The request must carry a JSON body.",
        requestId: rid,
      }),
    };
  }

  const upload = await readBoundedUpload(body, 1024 * 1024);
  if (!upload.ok) {
    return {
      ok: false,
      response: apiErrorResponse({
        code: "invalid_request",
        message: "The request body could not be read.",
        requestId: rid,
      }),
    };
  }

  let jsonPayload: unknown;
  try {
    jsonPayload = JSON.parse(new TextDecoder().decode(upload.bytes));
  } catch {
    return {
      ok: false,
      response: apiErrorResponse({
        code: "invalid_request",
        message: "The request body must be valid JSON.",
        requestId: rid,
      }),
    };
  }

  const parsed = SpeechRequestSchema.safeParse(jsonPayload);
  if (!parsed.success) {
    const [firstIssue] = parsed.error.issues;
    const detail = firstIssue
      ? ` (${firstIssue.path.join(".")}: ${firstIssue.message})`
      : "";
    return {
      ok: false,
      response: apiErrorResponse({
        code: "invalid_request",
        message: `Invalid speech request payload${detail}.`,
        requestId: rid,
      }),
    };
  }

  return { data: parsed.data, ok: true };
}

async function handleSpeechRequest(
  c: VoiceHandlerContext,
  deps: VoiceRouteDeps
): Promise<Response> {
  const rid = c.req.header("x-request-id") ?? crypto.randomUUID();

  const refusal = await authorizeVoiceRequest({
    action: "agent:run",
    context: c,
    denialMessage:
      "You are not authorized to synthesize speech for this project.",
    deps,
    requestId: rid,
  });
  if (refusal !== undefined) {
    return refusal;
  }

  const tts = deps.tts?.();
  if (tts === undefined) {
    return voiceErrorResponse({
      code: VOICE_UNCONFIGURED_CODE,
      message: TTS_UNCONFIGURED_MESSAGE,
      requestId: rid,
      status: 503,
    });
  }

  const bodyResult = await parseSpeechBody(c, rid);
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  let result: { audio: Uint8Array; mediaType: string };
  try {
    result = await tts.synthesize({
      format: bodyResult.data.format,
      speed: bodyResult.data.speed,
      text: bodyResult.data.text,
      voice: bodyResult.data.voice,
    });
  } catch (error) {
    if (!(error instanceof TtsProviderError)) {
      throw error;
    }
    return apiErrorResponse({
      code: "internal",
      message: error.message,
      requestId: rid,
    });
  }

  const audioBuffer = new Uint8Array(
    result.audio.buffer as ArrayBuffer,
    result.audio.byteOffset,
    result.audio.byteLength
  );

  return new Response(audioBuffer, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Length": String(result.audio.byteLength),
      "Content-Type": result.mediaType || "audio/mpeg",
    },
    status: 200,
  });
}

export function createVoiceHandlers(deps: VoiceRouteDeps) {
  const speechHandler = (c: VoiceHandlerContext) =>
    handleSpeechRequest(c, deps);

  return {
    speech: speechHandler,
    synthesize: speechHandler,
    transcribe: async (c: VoiceHandlerContext): Promise<Response> => {
      const rid = c.req.header("x-request-id") ?? crypto.randomUUID();

      const refusal = await authorizeVoiceRequest({
        context: c,
        deps,
        requestId: rid,
      });
      if (refusal !== undefined) {
        return refusal;
      }

      // Configuration is decided before the upload is read: with no endpoint
      // there is nothing the audio could be transcribed by, and refusing
      // without consuming a 25 MiB body is the cheaper honest answer.
      const asr = deps.asr();
      if (asr === undefined) {
        return voiceErrorResponse({
          code: VOICE_UNCONFIGURED_CODE,
          message: ASR_UNCONFIGURED_MESSAGE,
          requestId: rid,
          status: 503,
        });
      }

      const upload = await readAudioUpload(c, rid);
      if (upload instanceof Response) {
        return upload;
      }

      let result: { text: string };
      try {
        result = await asr.transcribe({
          audio: upload.audio,
          ...(upload.language === undefined
            ? {}
            : { language: upload.language }),
          mediaType: upload.mediaType,
        });
      } catch (error) {
        if (!(error instanceof AsrProviderError)) {
          throw error;
        }
        // The message is this repository's own sentence about the failure,
        // never the provider's body, so stating it to the caller is safe and
        // tells an operator which status the provider answered with.
        return apiErrorResponse({
          code: "internal",
          message: error.message,
          requestId: rid,
        });
      }

      return c.json(
        TranscriptionSchema.parse({
          language: upload.language ?? null,
          provider: asr.name,
          text: result.text,
        }),
        200
      );
    },
  };
}
