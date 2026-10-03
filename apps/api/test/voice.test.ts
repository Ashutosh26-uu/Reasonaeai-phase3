import { randomUUID } from "node:crypto";
import { SESSION_COOKIE } from "@reasonateai/contracts/auth";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
  UserIdSchema,
} from "@reasonateai/contracts/identity";
import {
  MAX_SPEECH_TEXT_CHARS,
  MAX_VOICE_AUDIO_BYTES,
} from "@reasonateai/contracts/voice";
import {
  createProjectStateStore,
  type ProjectStateStore,
} from "@reasonateai/project-state/postgres";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { type AsrAdapter, AsrProviderError } from "../src/mastra/adapters/asr";
import {
  OPENAI_COMPATIBLE_TTS_NAME,
  resolveTtsAdapter,
  type TtsAdapter,
  TtsProviderError,
} from "../src/mastra/adapters/tts";
import { resolveSessionPrincipal } from "../src/mastra/principal";
import {
  createVoiceHandlers,
  type VoiceHandlerContext,
  type VoiceHandlers,
  type VoiceRouteDeps,
} from "../src/mastra/routes/voice";

const connectionString = process.env.DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

const HOUR = 1000 * 60 * 60;

interface StubRequest {
  bodyBytes?: Uint8Array;
  contentType?: string;
  cookie?: string;
  declaredLength?: number;
  query?: Record<string, string>;
  requestId?: string;
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function context(input: StubRequest): VoiceHandlerContext {
  return {
    json: (body, status) =>
      new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
        status,
      }),
    req: {
      header: (name) => {
        const key = name.toLowerCase();
        if (key === "content-type") {
          return input.contentType;
        }
        if (key === "content-length") {
          return String(
            input.declaredLength ?? input.bodyBytes?.byteLength ?? 0
          );
        }
        if (key === "cookie") {
          return input.cookie;
        }
        if (key === "x-request-id") {
          return input.requestId ?? "req-test";
        }
      },
      query: (name) => input.query?.[name],
      raw: {
        body: input.bodyBytes === undefined ? null : streamOf(input.bodyBytes),
      },
    },
  };
}

/** A multipart upload serialized the way a browser sends it. */
async function multipartRequest(input: {
  audioType: string;
  language?: string;
}): Promise<{ bytes: Uint8Array; contentType: string }> {
  const form = new FormData();
  form.append(
    "audio",
    new Blob([new Uint8Array([1, 2, 3, 4])], { type: input.audioType }),
    "message.webm"
  );
  if (input.language !== undefined) {
    form.append("language", input.language);
  }
  const serialized = new Response(form);
  return {
    bytes: new Uint8Array(await serialized.arrayBuffer()),
    contentType: serialized.headers.get("content-type") ?? "",
  };
}

function jsonBody(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/**
 * The refusal envelope a voice route answers with, read the way a client reads
 * it. `code` is the route's own vocabulary — `voice_unconfigured` and its
 * siblings deliberately sit outside the shared error-code enum — so the shape
 * is checked here instead of through a schema that would reject honest codes.
 */
function refusalOf(body: unknown): { code: string; message: string } {
  if (typeof body !== "object" || body === null || !("error" in body)) {
    throw new Error("expected a product error envelope");
  }
  const { error } = body;
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    !("message" in error) ||
    typeof error.code !== "string" ||
    typeof error.message !== "string"
  ) {
    throw new Error("expected an error envelope carrying a code and message");
  }
  return { code: error.code, message: error.message };
}

describe("tts adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves no adapter when no endpoint is configured", () => {
    expect(resolveTtsAdapter({})).toBeUndefined();
  });

  it("sends the documented speech request and returns the audio that arrived", async () => {
    const calls: { body: Record<string, unknown>; url: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit) => {
        calls.push({
          body: JSON.parse(String(init.body)),
          url,
        });
        return new Response(new Uint8Array([9, 8, 7]), {
          headers: { "content-type": "audio/mpeg" },
          status: 200,
        });
      })
    );

    const adapter = resolveTtsAdapter({
      REASONATE_TTS_API_KEY: "key-1",
      REASONATE_TTS_MODEL: "kokoro-82m",
      REASONATE_TTS_URL: "http://tts.test/v1/audio/speech",
      REASONATE_TTS_VOICE: "af_heart",
    });
    if (adapter === undefined) {
      throw new Error("a configured endpoint must resolve an adapter");
    }
    expect(adapter.name).toBe(OPENAI_COMPATIBLE_TTS_NAME);

    const result = await adapter.synthesize({
      format: "mp3",
      language: "en",
      text: "The build passed.",
      voice: "am_michael",
    });

    expect(calls).toEqual([
      {
        body: {
          input: "The build passed.",
          language: "en",
          model: "kokoro-82m",
          response_format: "mp3",
          voice: "am_michael",
        },
        url: "http://tts.test/v1/audio/speech",
      },
    ]);
    expect(result.mediaType).toBe("audio/mpeg");
    expect(result.audio).toEqual(new Uint8Array([9, 8, 7]));
  });

  it("falls back to the configured voice when the caller names none", async () => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        calls.push(JSON.parse(String(init.body)));
        return new Response(new Uint8Array([1]), {
          headers: { "content-type": "audio/wav" },
          status: 200,
        });
      })
    );

    const adapter = resolveTtsAdapter({
      REASONATE_TTS_URL: "http://tts.test/v1/audio/speech",
      REASONATE_TTS_VOICE: "af_heart",
    });
    if (adapter === undefined) {
      throw new Error("a configured endpoint must resolve an adapter");
    }
    const result = await adapter.synthesize({ text: "Checkpoint saved." });

    expect(calls).toEqual([
      {
        input: "Checkpoint saved.",
        response_format: "mp3",
        voice: "af_heart",
      },
    ]);
    expect(result.mediaType).toBe("audio/wav");
  });

  it("refuses a provider failure in its own sentence, never the provider's body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Response("internal provider detail", { status: 500 }))
    );

    const adapter = resolveTtsAdapter({
      REASONATE_TTS_URL: "http://tts.test/v1/audio/speech",
    });
    if (adapter === undefined) {
      throw new Error("a configured endpoint must resolve an adapter");
    }
    const failure = await adapter
      .synthesize({ text: "Hello." })
      .catch((error: unknown) => error);
    if (!(failure instanceof TtsProviderError)) {
      throw failure;
    }

    expect(failure.status).toBe(500);
    expect(failure.message).toBe(
      "The synthesis endpoint failed with status 500."
    );
    expect(failure.message).not.toContain("internal provider detail");
  });

  it("refuses an answer with no audio", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Response(new Uint8Array(), { status: 200 }))
    );

    const adapter = resolveTtsAdapter({
      REASONATE_TTS_URL: "http://tts.test/v1/audio/speech",
    });
    if (adapter === undefined) {
      throw new Error("a configured endpoint must resolve an adapter");
    }
    const failure = await adapter
      .synthesize({ text: "Hello." })
      .catch((error: unknown) => error);
    if (!(failure instanceof TtsProviderError)) {
      throw failure;
    }

    expect(failure.status).toBe(200);
    expect(failure.message).toBe(
      "The synthesis endpoint answered with status 200 but no audio."
    );
  });
});

describeWithDatabase("voice routes", () => {
  const pool = new Pool({ connectionString });
  const store: ProjectStateStore = createProjectStateStore({
    connectionString: connectionString as string,
  });

  const organizationId = OrganizationIdSchema.parse(randomUUID());
  const foreignOrganizationId = OrganizationIdSchema.parse(randomUUID());
  const projectId = ProjectIdSchema.parse(randomUUID());
  const ownerUserId = UserIdSchema.parse(randomUUID());
  const viewerUserId = UserIdSchema.parse(randomUUID());
  const outsiderUserId = UserIdSchema.parse(randomUUID());

  let ownerCookie = "";
  let viewerCookie = "";

  const asrCalls: {
    audio: Uint8Array;
    language?: string;
    mediaType: string;
  }[] = [];
  const ttsCalls: {
    format?: string;
    language?: string;
    text: string;
    voice?: string;
  }[] = [];

  const asr: AsrAdapter = {
    name: "test-asr",
    transcribe: (input) => {
      asrCalls.push(input);
      return Promise.resolve({ text: "hello from the stub" });
    },
  };
  const tts: TtsAdapter = {
    name: "test-tts",
    synthesize: (input) => {
      ttsCalls.push(input);
      return Promise.resolve({
        audio: new Uint8Array([1, 2, 3]),
        mediaType: "audio/mpeg",
      });
    },
  };

  function handlers(overrides: Partial<VoiceRouteDeps> = {}): VoiceHandlers {
    return createVoiceHandlers({
      asr: () => asr,
      resolvePrincipal: async ({ cookieHeader }) =>
        await resolveSessionPrincipal({
          cookieHeader,
          sessions: store.sessions,
        }),
      store: () => store,
      tts: () => tts,
      ...overrides,
    });
  }

  function scoped(overrides: Partial<StubRequest> = {}): StubRequest {
    return {
      cookie: ownerCookie,
      query: { organizationId, projectId },
      requestId: randomUUID(),
      ...overrides,
    };
  }

  async function issueCookie(userId: string) {
    const issued = await store.sessions.createSession({
      absoluteTtlMs: 24 * HOUR,
      idleTtlMs: HOUR,
      userId,
    });
    return `${SESSION_COOKIE}=${issued.token}`;
  }

  beforeAll(async () => {
    await store.migrate();
    await pool.query(
      `insert into organizations (organization_id, name)
       select fixture_id, 'Voice route test' from unnest($1::uuid[]) as fixture_id
       on conflict do nothing`,
      [[organizationId, foreignOrganizationId]]
    );
    await pool.query(
      `insert into projects (project_id, organization_id, name)
       select f.project_id, f.organization_id, 'Voice route project'
         from unnest($1::uuid[], $2::uuid[]) as f(project_id, organization_id)
       on conflict do nothing`,
      [[projectId], [organizationId]]
    );
    await pool.query(
      `insert into users (user_id) select fixture_id
         from unnest($1::uuid[]) as fixture_id on conflict do nothing`,
      [[ownerUserId, viewerUserId, outsiderUserId]]
    );

    await store.memberships.grantOrganizationMembership({
      organizationId,
      role: "builder",
      status: "active",
      userId: ownerUserId,
    });
    await store.memberships.grantProjectMembership({
      organizationId,
      projectId,
      role: "builder",
      status: "active",
      userId: ownerUserId,
    });
    await store.memberships.grantOrganizationMembership({
      organizationId,
      role: "viewer",
      status: "active",
      userId: viewerUserId,
    });
    await store.memberships.grantProjectMembership({
      organizationId,
      projectId,
      role: "viewer",
      status: "active",
      userId: viewerUserId,
    });

    ownerCookie = await issueCookie(ownerUserId);
    viewerCookie = await issueCookie(viewerUserId);
  });

  afterAll(async () => {
    await pool.query(
      "delete from organizations where organization_id = any($1::uuid[])",
      [[organizationId, foreignOrganizationId]]
    );
    await pool.query("delete from users where user_id = any($1::uuid[])", [
      [ownerUserId, viewerUserId, outsiderUserId],
    ]);
    await pool.end();
    await store.close();
  });

  it("refuses an unauthenticated transcription", async () => {
    const response = await handlers().transcribe(
      context(scoped({ cookie: undefined }))
    );
    expect(response.status).toBe(401);
  });

  it("refuses a member without the capability to run the CTO", async () => {
    const upload = await multipartRequest({ audioType: "audio/webm" });
    const response = await handlers().transcribe(
      context(
        scoped({
          bodyBytes: upload.bytes,
          contentType: upload.contentType,
          cookie: viewerCookie,
        })
      )
    );
    expect(response.status).toBe(403);
    expect(refusalOf(await response.json()).code).toBe("forbidden");
    expect(asrCalls).toHaveLength(0);
  });

  it("names the missing setting instead of reading the upload when no ASR endpoint is configured", async () => {
    const response = await handlers({ asr: () => undefined }).transcribe(
      context(scoped())
    );
    expect(response.status).toBe(503);
    const refusal = refusalOf(await response.json());
    expect(refusal.code).toBe("voice_unconfigured");
    expect(refusal.message).toContain("REASONATE_ASR_URL");
  });

  it("transcribes a recording and reports the adapter that produced it", async () => {
    asrCalls.length = 0;
    const upload = await multipartRequest({
      audioType: "audio/webm",
      language: "en",
    });
    const response = await handlers().transcribe(
      context(
        scoped({
          bodyBytes: upload.bytes,
          contentType: upload.contentType,
        })
      )
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      language: "en",
      provider: "test-asr",
      text: "hello from the stub",
    });
    expect(asrCalls).toHaveLength(1);
    expect(asrCalls[0]).toMatchObject({
      language: "en",
      mediaType: "audio/webm",
    });
    expect(asrCalls[0]?.audio).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("refuses an audio container the adapters cannot forward", async () => {
    const upload = await multipartRequest({ audioType: "audio/flac" });
    const response = await handlers().transcribe(
      context(
        scoped({
          bodyBytes: upload.bytes,
          contentType: upload.contentType,
        })
      )
    );

    expect(response.status).toBe(415);
    const refusal = refusalOf(await response.json());
    expect(refusal.code).toBe("voice_unsupported_media_type");
    expect(refusal.message).toContain("audio/flac");
  });

  it("refuses an upload whose declared length cannot fit", async () => {
    const upload = await multipartRequest({ audioType: "audio/webm" });
    const response = await handlers().transcribe(
      context(
        scoped({
          bodyBytes: upload.bytes,
          contentType: upload.contentType,
          declaredLength: MAX_VOICE_AUDIO_BYTES * 2,
        })
      )
    );

    expect(response.status).toBe(413);
    const refusal = refusalOf(await response.json());
    expect(refusal.code).toBe("voice_upload_too_large");
  });

  it("reports a provider failure as its own sentence, never the provider's", async () => {
    const upload = await multipartRequest({ audioType: "audio/webm" });
    const failing: AsrAdapter = {
      name: "failing-asr",
      transcribe: () =>
        Promise.reject(
          new AsrProviderError("The transcription endpoint failed.", {
            cause: new Error("provider internals"),
            status: 502,
          })
        ),
    };
    const response = await handlers({ asr: () => failing }).transcribe(
      context(
        scoped({
          bodyBytes: upload.bytes,
          contentType: upload.contentType,
        })
      )
    );

    expect(response.status).toBe(500);
    const refusal = refusalOf(await response.json());
    expect(refusal.code).toBe("internal");
    expect(refusal.message).toBe("The transcription endpoint failed.");
  });

  it("names the missing setting instead of reading the body when no TTS endpoint is configured", async () => {
    const response = await handlers({ tts: () => undefined }).speak(
      context(scoped())
    );
    expect(response.status).toBe(503);
    const refusal = refusalOf(await response.json());
    expect(refusal.code).toBe("voice_unconfigured");
    expect(refusal.message).toContain("REASONATE_TTS_URL");
  });

  it("speaks a turn and returns the audio the adapter produced", async () => {
    ttsCalls.length = 0;
    const response = await handlers().speak(
      context(
        scoped({
          bodyBytes: jsonBody({ text: "The build passed." }),
          contentType: "application/json",
        })
      )
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("x-reasonate-voice-provider")).toBe("test-tts");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3])
    );
    expect(ttsCalls).toEqual([{ format: "mp3", text: "The build passed." }]);
  });

  it("forwards the voice, language, and format the caller chose", async () => {
    ttsCalls.length = 0;
    const response = await handlers().speak(
      context(
        scoped({
          bodyBytes: jsonBody({
            format: "wav",
            language: "en",
            text: "Checkpoint saved.",
            voice: "am_michael",
          }),
          contentType: "application/json",
        })
      )
    );

    expect(response.status).toBe(200);
    expect(ttsCalls).toEqual([
      {
        format: "wav",
        language: "en",
        text: "Checkpoint saved.",
        voice: "am_michael",
      },
    ]);
  });

  it("refuses a synthesis request that is not a bounded JSON turn", async () => {
    ttsCalls.length = 0;
    const oversized = handlers().speak(
      context(
        scoped({
          bodyBytes: jsonBody({ text: "x".repeat(MAX_SPEECH_TEXT_CHARS + 1) }),
          contentType: "application/json",
        })
      )
    );
    const malformed = handlers().speak(
      context(
        scoped({
          bodyBytes: new TextEncoder().encode("not json"),
          contentType: "application/json",
        })
      )
    );
    const unknownFormat = handlers().speak(
      context(
        scoped({
          bodyBytes: jsonBody({ format: "mp4", text: "Hello." }),
          contentType: "application/json",
        })
      )
    );

    const responses = await Promise.all([oversized, malformed, unknownFormat]);
    for (const response of responses) {
      expect(response.status).toBe(400);
    }
    const bodies = await Promise.all(
      responses.map((response) => response.json())
    );
    for (const body of bodies) {
      expect(refusalOf(body).code).toBe("invalid_request");
    }
    expect(ttsCalls).toHaveLength(0);
  });

  it("reports a synthesis provider failure as its own sentence", async () => {
    const failing: TtsAdapter = {
      name: "failing-tts",
      synthesize: () =>
        Promise.reject(
          new TtsProviderError("The synthesis endpoint failed.", {
            cause: new Error("provider internals"),
            status: 502,
          })
        ),
    };
    const response = await handlers({ tts: () => failing }).speak(
      context(
        scoped({
          bodyBytes: jsonBody({ text: "Hello." }),
          contentType: "application/json",
        })
      )
    );

    expect(response.status).toBe(500);
    const refusal = refusalOf(await response.json());
    expect(refusal.code).toBe("internal");
    expect(refusal.message).toBe("The synthesis endpoint failed.");
  });

  it("refuses an unauthenticated synthesis request", async () => {
    ttsCalls.length = 0;
    const response = await handlers().speak(
      context(
        scoped({
          bodyBytes: jsonBody({ text: "Hello." }),
          contentType: "application/json",
          cookie: undefined,
        })
      )
    );
    expect(response.status).toBe(401);
    expect(ttsCalls).toHaveLength(0);
  });
});
