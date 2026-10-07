import { randomUUID } from "node:crypto";
import {
  type OrganizationId,
  OrganizationIdSchema,
  type OrganizationRole,
  type ProjectId,
  ProjectIdSchema,
  type ProjectRole,
  SessionIdSchema,
  type UserId,
  UserIdSchema,
  type UserPrincipal,
} from "@reasonateai/contracts/identity";
import type { ProjectStateStore } from "@reasonateai/project-state/postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ASR_UNCONFIGURED_MESSAGE,
  AsrProviderError,
  OPENAI_COMPATIBLE_ASR_NAME,
  resolveAsrAdapter,
} from "../src/mastra/adapters/asr";
import {
  createTtsAdapterFromEnv,
  DEFAULT_TTS_VOICE,
  normalizeTtsUrl,
  OPENAI_COMPATIBLE_TTS_NAME,
  resolveTtsAdapter,
  TTS_UNCONFIGURED_MESSAGE,
  TtsProviderError,
} from "../src/mastra/adapters/tts";
import {
  createVoiceHandlers,
  type VoiceHandlerContext,
} from "../src/mastra/routes/voice";

const TEST_USER_ID = UserIdSchema.parse(randomUUID());
const TEST_ORG_ID = OrganizationIdSchema.parse(randomUUID());
const TEST_PROJECT_ID = ProjectIdSchema.parse(randomUUID());

function resolveScopeQuery(key: string): string | undefined {
  if (key === "organizationId") {
    return TEST_ORG_ID;
  }
  if (key === "projectId") {
    return TEST_PROJECT_ID;
  }
  return undefined;
}

function createPrincipal(overrides?: Partial<UserPrincipal>): UserPrincipal {
  return {
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    kind: "user",
    revokedAt: null,
    sessionId: SessionIdSchema.parse(randomUUID()),
    userId: TEST_USER_ID,
    ...overrides,
  };
}

function createMockStore(options?: {
  orgRole?: OrganizationRole;
  projectRole?: ProjectRole;
}) {
  const auditRecords: unknown[] = [];
  return {
    audit: {
      record: async (event: unknown) => {
        await Promise.resolve();
        auditRecords.push(event);
      },
    },
    auditRecords,
    memberships: {
      getOrganizationMembership: async (query: {
        organizationId: OrganizationId;
        userId: UserId;
      }) => {
        await Promise.resolve();
        if (query.organizationId !== TEST_ORG_ID) {
          return null;
        }
        return {
          createdAt: new Date().toISOString(),
          membershipId: randomUUID(),
          organizationId: query.organizationId,
          role: options?.orgRole ?? "owner",
          status: "active" as const,
          updatedAt: new Date().toISOString(),
          userId: query.userId,
        };
      },
      getProjectMembership: async (query: {
        organizationId: OrganizationId;
        projectId: ProjectId;
        userId: UserId;
      }) => {
        await Promise.resolve();
        if (
          query.organizationId !== TEST_ORG_ID ||
          query.projectId !== TEST_PROJECT_ID
        ) {
          return null;
        }
        return {
          createdAt: new Date().toISOString(),
          membershipId: randomUUID(),
          organizationId: query.organizationId,
          projectId: query.projectId,
          role: options?.projectRole ?? "builder",
          status: "active" as const,
          updatedAt: new Date().toISOString(),
          userId: query.userId,
        };
      },
    },
  } as unknown as ProjectStateStore & { auditRecords: unknown[] };
}

function createFormDataStream(
  audioContent: Uint8Array,
  mediaType = "audio/wav",
  language?: string
): { body: ReadableStream<Uint8Array>; contentType: string } {
  const boundary = `----WebKitFormBoundary${randomUUID().replace(/-/g, "")}`;
  const parts: Uint8Array[] = [];

  // Audio part
  const audioHeader = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="speech.wav"\r\nContent-Type: ${mediaType}\r\n\r\n`
  );
  parts.push(audioHeader);
  parts.push(audioContent);
  parts.push(Buffer.from("\r\n"));

  // Language part if present
  if (language !== undefined) {
    const langPart = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${language}\r\n`
    );
    parts.push(langPart);
  }

  // End boundary
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  const totalLength = parts.reduce((acc, p) => acc + p.byteLength, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.byteLength;
  }

  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(combined);
        controller.close();
      },
    }),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function createJsonStream(payload: unknown): {
  body: ReadableStream<Uint8Array>;
  contentType: string;
} {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    contentType: "application/json",
  };
}

describe("Speech-to-text ASR Adapter", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("resolves undefined when REASONATE_ASR_URL is absent or blank", () => {
    expect(resolveAsrAdapter({})).toBeUndefined();
    expect(resolveAsrAdapter({ REASONATE_ASR_URL: "" })).toBeUndefined();
    expect(resolveAsrAdapter({ REASONATE_ASR_URL: "   " })).toBeUndefined();
  });

  it("resolves an openai-compatible adapter when REASONATE_ASR_URL is set", () => {
    const adapter = resolveAsrAdapter({
      REASONATE_ASR_URL: "http://127.0.0.1:8081/v1/audio/transcriptions",
    });
    expect(adapter).toBeDefined();
    expect(adapter?.name).toBe(OPENAI_COMPATIBLE_ASR_NAME);
  });

  it("transcribes audio and handles multipart form data properly", async () => {
    const adapter = resolveAsrAdapter({
      REASONATE_ASR_API_KEY: "secret-key",
      REASONATE_ASR_MODEL: "Confucius4-R2T2",
      REASONATE_ASR_URL: "http://127.0.0.1:8081/v1/audio/transcriptions",
    });
    expect(adapter).toBeDefined();

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ text: "Reasonate verified transcription." }),
        {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }
      )
    );

    const result = await adapter?.transcribe({
      audio: new Uint8Array([1, 2, 3, 4]),
      language: "en",
      mediaType: "audio/wav",
    });

    expect(result).toEqual({ text: "Reasonate verified transcription." });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    const [firstCall] = vi.mocked(globalThis.fetch).mock.calls;
    expect(firstCall).toBeDefined();
    const [calledUrl, calledInit] = firstCall ?? [];
    expect(calledUrl).toBe("http://127.0.0.1:8081/v1/audio/transcriptions");
    expect(calledInit?.headers).toEqual({ authorization: "Bearer secret-key" });
    expect(calledInit?.body).toBeInstanceOf(FormData);
  });

  it("throws AsrProviderError when provider endpoint fails with non-200", async () => {
    const adapter = resolveAsrAdapter({
      REASONATE_ASR_URL: "http://127.0.0.1:8081/v1/audio/transcriptions",
    });

    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("Model failed to load", { status: 500 }));

    await expect(
      adapter?.transcribe({
        audio: new Uint8Array([1, 2, 3]),
        mediaType: "audio/wav",
      })
    ).rejects.toThrow(AsrProviderError);
  });

  it("throws AsrProviderError on network failure", async () => {
    const adapter = resolveAsrAdapter({
      REASONATE_ASR_URL: "http://127.0.0.1:8081/v1/audio/transcriptions",
    });

    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(
      adapter?.transcribe({
        audio: new Uint8Array([1, 2, 3]),
        mediaType: "audio/wav",
      })
    ).rejects.toThrow(AsrProviderError);
  });
});

describe("Voice Transcription Route Handlers", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const handlers = createVoiceHandlers({
      asr: () => undefined,
      resolvePrincipal: async () => undefined,
      store: () => createMockStore(),
    });

    const ctx: VoiceHandlerContext = {
      json: (responsePayload, status) =>
        new Response(JSON.stringify(responsePayload), { status }),
      req: {
        header: () => undefined,
        query: () => undefined,
        raw: { body: null },
      },
    };

    const res = await handlers.transcribe(ctx);
    expect(res.status).toBe(401);
  });

  it("rejects requests missing scope parameters with 400", async () => {
    const handlers = createVoiceHandlers({
      asr: () => undefined,
      resolvePrincipal: async () => createPrincipal(),
      store: () => createMockStore(),
    });

    const ctx: VoiceHandlerContext = {
      json: (responsePayload, status) =>
        new Response(JSON.stringify(responsePayload), { status }),
      req: {
        header: () => undefined,
        query: (key) => (key === "organizationId" ? TEST_ORG_ID : undefined),
        raw: { body: null },
      },
    };

    const res = await handlers.transcribe(ctx);
    expect(res.status).toBe(400);
  });

  it("rejects unauthorized requests with 403 and records audit event", async () => {
    const mockStore = createMockStore({
      orgRole: "viewer",
      projectRole: "viewer",
    });
    const handlers = createVoiceHandlers({
      asr: () => undefined,
      resolvePrincipal: async () => createPrincipal(),
      store: () => mockStore,
    });

    const ctx: VoiceHandlerContext = {
      json: (responsePayload, status) =>
        new Response(JSON.stringify(responsePayload), { status }),
      req: {
        header: () => undefined,
        query: (key) => resolveScopeQuery(key),
        raw: { body: null },
      },
    };

    const res = await handlers.transcribe(ctx);
    expect(res.status).toBe(403);
    expect(mockStore.auditRecords.length).toBeGreaterThan(0);
  });

  it("returns 503 voice_unconfigured when ASR adapter is not configured", async () => {
    const handlers = createVoiceHandlers({
      asr: () => undefined,
      resolvePrincipal: async () => createPrincipal(),
      store: () => createMockStore(),
    });

    const ctx: VoiceHandlerContext = {
      json: (responsePayload, status) =>
        new Response(JSON.stringify(responsePayload), { status }),
      req: {
        header: () => undefined,
        query: (key) => resolveScopeQuery(key),
        raw: { body: null },
      },
    };

    const res = await handlers.transcribe(ctx);
    expect(res.status).toBe(503);
    const data = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(data.error.code).toBe("voice_unconfigured");
    expect(data.error.message).toBe(ASR_UNCONFIGURED_MESSAGE);
  });

  it("rejects non-multipart requests with 400", async () => {
    const handlers = createVoiceHandlers({
      asr: () => ({
        name: "test-asr",
        transcribe: async () => {
          await Promise.resolve();
          return { text: "test" };
        },
      }),
      resolvePrincipal: async () => createPrincipal(),
      store: () => createMockStore(),
    });

    const ctx: VoiceHandlerContext = {
      json: (responsePayload, status) =>
        new Response(JSON.stringify(responsePayload), { status }),
      req: {
        header: (name) =>
          name.toLowerCase() === "content-type"
            ? "application/json"
            : undefined,
        query: (key) => resolveScopeQuery(key),
        raw: { body: null },
      },
    };

    const res = await handlers.transcribe(ctx);
    expect(res.status).toBe(400);
  });

  it("rejects unsupported media type with 415", async () => {
    const handlers = createVoiceHandlers({
      asr: () => ({
        name: "test-asr",
        transcribe: async () => {
          await Promise.resolve();
          return { text: "test" };
        },
      }),
      resolvePrincipal: async () => createPrincipal(),
      store: () => createMockStore(),
    });

    const { body, contentType } = createFormDataStream(
      new Uint8Array([1, 2, 3]),
      "text/plain"
    );

    const ctx: VoiceHandlerContext = {
      json: (responsePayload, status) =>
        new Response(JSON.stringify(responsePayload), { status }),
      req: {
        header: (name) =>
          name.toLowerCase() === "content-type" ? contentType : undefined,
        query: (key) => resolveScopeQuery(key),
        raw: { body },
      },
    };

    const res = await handlers.transcribe(ctx);
    expect(res.status).toBe(415);
  });

  it("transcribes audio successfully and returns transcription schema", async () => {
    const handlers = createVoiceHandlers({
      asr: () => ({
        name: "r2t2-llama",
        transcribe: async ({ audio, language }) => {
          await Promise.resolve();
          return {
            text: `Transcribed ${audio.byteLength} bytes in ${language ?? "auto"}`,
          };
        },
      }),
      resolvePrincipal: async () => createPrincipal(),
      store: () => createMockStore(),
    });

    const audioBytes = new Uint8Array([10, 20, 30, 40]);
    const { body, contentType } = createFormDataStream(
      audioBytes,
      "audio/wav",
      "English"
    );

    const ctx: VoiceHandlerContext = {
      json: (responsePayload, status) =>
        new Response(JSON.stringify(responsePayload), { status }),
      req: {
        header: (name) =>
          name.toLowerCase() === "content-type" ? contentType : undefined,
        query: (key) => resolveScopeQuery(key),
        raw: { body },
      },
    };

    const res = await handlers.transcribe(ctx);
    expect(res.status).toBe(200);

    const result = (await res.json()) as {
      language: string;
      provider: string;
      text: string;
    };
    expect(result.language).toBe("English");
    expect(result.provider).toBe("r2t2-llama");
    expect(result.text).toBe("Transcribed 4 bytes in English");
  });

  it("rejects declared content-length exceeding 25 MiB with 413", async () => {
    const handlers = createVoiceHandlers({
      asr: () => ({
        name: "test-asr",
        transcribe: async () => {
          await Promise.resolve();
          return { text: "test" };
        },
      }),
      resolvePrincipal: async () => createPrincipal(),
      store: () => createMockStore(),
    });

    const ctx: VoiceHandlerContext = {
      json: (responsePayload, status) =>
        new Response(JSON.stringify(responsePayload), { status }),
      req: {
        header: (name) => {
          const key = name.toLowerCase();
          if (key === "content-type") {
            return "multipart/form-data";
          }
          if (key === "content-length") {
            return String(30 * 1024 * 1024);
          }
        },
        query: (key) => resolveScopeQuery(key),
        raw: { body: null },
      },
    };

    const res = await handlers.transcribe(ctx);
    expect(res.status).toBe(413);
  });

  it("handles AsrProviderError gracefully", async () => {
    const handlers = createVoiceHandlers({
      asr: () => ({
        name: "failing-asr",
        transcribe: async () => {
          await Promise.resolve();
          throw new AsrProviderError(
            "The transcription endpoint failed with status 502.",
            {
              status: 502,
            }
          );
        },
      }),
      resolvePrincipal: async () => createPrincipal(),
      store: () => createMockStore(),
    });

    const { body, contentType } = createFormDataStream(
      new Uint8Array([1, 2, 3])
    );
    const ctx: VoiceHandlerContext = {
      json: (responsePayload, status) =>
        new Response(JSON.stringify(responsePayload), { status }),
      req: {
        header: (name) =>
          name.toLowerCase() === "content-type" ? contentType : undefined,
        query: (key) => resolveScopeQuery(key),
        raw: { body },
      },
    };

    const res = await handlers.transcribe(ctx);
    expect(res.status).toBe(500);
    const errBody = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(errBody.error.code).toBe("internal");
    expect(errBody.error.message).toContain("status 502");
  });
});

describe("Text-to-speech TTS Adapter", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("resolves undefined when REASONATE_TTS_URL is absent or blank", () => {
    expect(createTtsAdapterFromEnv({})).toBeUndefined();
    expect(createTtsAdapterFromEnv({ REASONATE_TTS_URL: "" })).toBeUndefined();
    expect(
      createTtsAdapterFromEnv({ REASONATE_TTS_URL: "   " })
    ).toBeUndefined();
    expect(resolveTtsAdapter({})).toBeUndefined();
  });

  it("resolves an openai-compatible adapter when REASONATE_TTS_URL is set", () => {
    const adapter = createTtsAdapterFromEnv({
      REASONATE_TTS_URL: "http://127.0.0.1:8880/v1/audio/speech",
    });
    expect(adapter).toBeDefined();
    expect(adapter?.name).toBe(OPENAI_COMPATIBLE_TTS_NAME);
    expect(adapter?.defaultVoice).toBe(DEFAULT_TTS_VOICE);
  });

  it("normalizes base and endpoint URLs correctly", () => {
    expect(normalizeTtsUrl("http://127.0.0.1:8880")).toBe(
      "http://127.0.0.1:8880/v1/audio/speech"
    );
    expect(normalizeTtsUrl("http://127.0.0.1:8880/")).toBe(
      "http://127.0.0.1:8880/v1/audio/speech"
    );
    expect(normalizeTtsUrl("http://127.0.0.1:8880/v1")).toBe(
      "http://127.0.0.1:8880/v1/audio/speech"
    );
    expect(normalizeTtsUrl("http://127.0.0.1:8880/v1/")).toBe(
      "http://127.0.0.1:8880/v1/audio/speech"
    );
    expect(normalizeTtsUrl("http://127.0.0.1:8880/v1/audio/speech")).toBe(
      "http://127.0.0.1:8880/v1/audio/speech"
    );
    expect(normalizeTtsUrl("http://127.0.0.1:8880/v1/audio/speech/")).toBe(
      "http://127.0.0.1:8880/v1/audio/speech"
    );
  });

  it("normalizes base URL when REASONATE_TTS_URL is set without path", async () => {
    const adapter = createTtsAdapterFromEnv({
      REASONATE_TTS_URL: "http://127.0.0.1:8880",
    });
    expect(adapter).toBeDefined();

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "Content-Type": "audio/mpeg" },
        status: 200,
      })
    );

    await adapter?.synthesize({ text: "Hello from normalized base URL" });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8880/v1/audio/speech",
      expect.anything()
    );
  });

  it("resolves adapter when TTS_URL fallback is set", () => {
    const adapter = createTtsAdapterFromEnv({
      TTS_URL: "http://127.0.0.1:8880/v1/audio/speech",
    });
    expect(adapter).toBeDefined();
    expect(adapter?.name).toBe(OPENAI_COMPATIBLE_TTS_NAME);
  });

  it("uses custom voice and model configuration", () => {
    const adapter = createTtsAdapterFromEnv({
      REASONATE_TTS_MODEL: "custom-kokoro",
      REASONATE_TTS_URL: "http://127.0.0.1:8880/v1/audio/speech",
      REASONATE_TTS_VOICE: "am_adam",
    });
    expect(adapter).toBeDefined();
    expect(adapter?.defaultVoice).toBe("am_adam");
  });

  it("synthesizes audio and sends JSON payload with authorization header", async () => {
    const adapter = createTtsAdapterFromEnv({
      REASONATE_TTS_API_KEY: "secret-tts-key",
      REASONATE_TTS_MODEL: "kokoro",
      REASONATE_TTS_URL: "http://127.0.0.1:8880/v1/audio/speech",
      REASONATE_TTS_VOICE: "af_heart",
    });
    expect(adapter).toBeDefined();

    const expectedAudio = new Uint8Array([10, 20, 30, 40]);
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(expectedAudio, {
        headers: { "Content-Type": "audio/mpeg" },
        status: 200,
      })
    );

    const result = await adapter?.synthesize({
      format: "mp3",
      speed: 1.0,
      text: "Reasonate verified speech output.",
      voice: "af_bella",
    });

    expect(result).toBeDefined();
    expect(result?.mediaType).toBe("audio/mpeg");
    expect(result?.audio).toEqual(expectedAudio);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8880/v1/audio/speech",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer secret-tts-key",
          "Content-Type": "application/json",
        }),
        method: "POST",
      })
    );

    const [callArgs] = (globalThis.fetch as any).mock.calls;
    const parsedBody = JSON.parse(callArgs[1].body);
    expect(parsedBody).toEqual({
      input: "Reasonate verified speech output.",
      model: "kokoro",
      response_format: "mp3",
      speed: 1.0,
      voice: "af_bella",
    });
  });

  it("throws TtsProviderError when provider endpoint fails with non-200", async () => {
    const adapter = createTtsAdapterFromEnv({
      REASONATE_TTS_URL: "http://127.0.0.1:8880/v1/audio/speech",
    });

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("Internal Server Error", {
        status: 500,
      })
    );

    await expect(adapter?.synthesize({ text: "Hello" })).rejects.toThrow(
      TtsProviderError
    );
    await expect(adapter?.synthesize({ text: "Hello" })).rejects.toMatchObject({
      status: 500,
    });
  });

  it("throws TtsProviderError when provider returns empty body", async () => {
    const adapter = createTtsAdapterFromEnv({
      REASONATE_TTS_URL: "http://127.0.0.1:8880/v1/audio/speech",
    });

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([]), {
        status: 200,
      })
    );

    await expect(adapter?.synthesize({ text: "Hello" })).rejects.toThrow(
      TtsProviderError
    );
  });

  it("throws TtsProviderError on network failure", async () => {
    const adapter = createTtsAdapterFromEnv({
      REASONATE_TTS_URL: "http://127.0.0.1:8880/v1/audio/speech",
    });

    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("Connection refused"));

    await expect(adapter?.synthesize({ text: "Hello" })).rejects.toThrow(
      TtsProviderError
    );
  });
});

describe("Voice Speech Synthesis Route Handlers", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const handlers = createVoiceHandlers({
      asr: () => undefined,
      resolvePrincipal: async () => undefined,
      store: () => createMockStore(),
      tts: () => undefined,
    });

    const ctx: VoiceHandlerContext = {
      json: (payload, status) =>
        new Response(JSON.stringify(payload), { status }),
      req: {
        header: () => undefined,
        query: () => undefined,
        raw: { body: null },
      },
    };

    const res = await handlers.speech(ctx);
    expect(res.status).toBe(401);
  });

  it("rejects requests missing scope parameters with 400", async () => {
    const handlers = createVoiceHandlers({
      asr: () => undefined,
      resolvePrincipal: async () => createPrincipal(),
      store: () => createMockStore(),
      tts: () => undefined,
    });

    const ctx: VoiceHandlerContext = {
      json: (payload, status) =>
        new Response(JSON.stringify(payload), { status }),
      req: {
        header: () => undefined,
        query: (key) => (key === "organizationId" ? TEST_ORG_ID : undefined),
        raw: { body: null },
      },
    };

    const res = await handlers.speech(ctx);
    expect(res.status).toBe(400);
  });

  it("rejects unauthorized requests with 403 and records audit event", async () => {
    const mockStore = createMockStore({
      orgRole: "viewer",
      projectRole: "viewer",
    });
    const handlers = createVoiceHandlers({
      asr: () => undefined,
      resolvePrincipal: async () => createPrincipal(),
      store: () => mockStore,
      tts: () => undefined,
    });

    const ctx: VoiceHandlerContext = {
      json: (payload, status) =>
        new Response(JSON.stringify(payload), { status }),
      req: {
        header: () => undefined,
        query: (key) => resolveScopeQuery(key),
        raw: { body: null },
      },
    };

    const res = await handlers.speech(ctx);
    expect(res.status).toBe(403);
    expect(mockStore.auditRecords.length).toBeGreaterThan(0);
  });

  it("returns 503 voice_unconfigured when TTS adapter is not configured", async () => {
    const handlers = createVoiceHandlers({
      asr: () => undefined,
      resolvePrincipal: async () => createPrincipal(),
      store: () => createMockStore(),
      tts: () => undefined,
    });

    const ctx: VoiceHandlerContext = {
      json: (payload, status) =>
        new Response(JSON.stringify(payload), { status }),
      req: {
        header: () => undefined,
        query: (key) => resolveScopeQuery(key),
        raw: { body: null },
      },
    };

    const res = await handlers.speech(ctx);
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("voice_unconfigured");
    expect(body.error.message).toBe(TTS_UNCONFIGURED_MESSAGE);
  });

  it("rejects non-JSON requests with 400", async () => {
    const handlers = createVoiceHandlers({
      asr: () => undefined,
      resolvePrincipal: async () => createPrincipal(),
      store: () => createMockStore(),
      tts: () => ({
        defaultVoice: "af_heart",
        name: "test-tts",
        synthesize: async () => ({
          audio: new Uint8Array([]),
          mediaType: "audio/mpeg",
        }),
      }),
    });

    const ctx: VoiceHandlerContext = {
      json: (payload, status) =>
        new Response(JSON.stringify(payload), { status }),
      req: {
        header: (name) =>
          name.toLowerCase() === "content-type" ? "text/plain" : undefined,
        query: (key) => resolveScopeQuery(key),
        raw: { body: null },
      },
    };

    const res = await handlers.speech(ctx);
    expect(res.status).toBe(400);
  });

  it("rejects invalid payload (empty text) with 400 invalid_request", async () => {
    const handlers = createVoiceHandlers({
      asr: () => undefined,
      resolvePrincipal: async () => createPrincipal(),
      store: () => createMockStore(),
      tts: () => ({
        defaultVoice: "af_heart",
        name: "test-tts",
        synthesize: async () => ({
          audio: new Uint8Array([]),
          mediaType: "audio/mpeg",
        }),
      }),
    });

    const { body, contentType } = createJsonStream({ text: "" });
    const ctx: VoiceHandlerContext = {
      json: (payload, status) =>
        new Response(JSON.stringify(payload), { status }),
      req: {
        header: (name) =>
          name.toLowerCase() === "content-type" ? contentType : undefined,
        query: (key) => resolveScopeQuery(key),
        raw: { body },
      },
    };

    const res = await handlers.speech(ctx);
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: { code: string } };
    expect(err.error.code).toBe("invalid_request");
  });

  it("rejects whitespace-only speech text with 400 invalid_request", async () => {
    const handlers = createVoiceHandlers({
      asr: () => undefined,
      resolvePrincipal: async () => createPrincipal(),
      store: () => createMockStore(),
      tts: () => ({
        defaultVoice: "af_heart",
        name: "test-tts",
        synthesize: async () => ({
          audio: new Uint8Array([]),
          mediaType: "audio/mpeg",
        }),
      }),
    });

    const { body, contentType } = createJsonStream({ text: "   " });
    const ctx: VoiceHandlerContext = {
      json: (payload, status) =>
        new Response(JSON.stringify(payload), { status }),
      req: {
        header: (name) =>
          name.toLowerCase() === "content-type" ? contentType : undefined,
        query: (key) => resolveScopeQuery(key),
        raw: { body },
      },
    };

    const res = await handlers.speech(ctx);
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: { code: string } };
    expect(err.error.code).toBe("invalid_request");
  });

  it("rejects speech text exceeding 4096 characters with 400 invalid_request", async () => {
    const handlers = createVoiceHandlers({
      asr: () => undefined,
      resolvePrincipal: async () => createPrincipal(),
      store: () => createMockStore(),
      tts: () => ({
        defaultVoice: "af_heart",
        name: "test-tts",
        synthesize: async () => ({
          audio: new Uint8Array([]),
          mediaType: "audio/mpeg",
        }),
      }),
    });

    const { body, contentType } = createJsonStream({
      text: "a".repeat(4097),
    });
    const ctx: VoiceHandlerContext = {
      json: (payload, status) =>
        new Response(JSON.stringify(payload), { status }),
      req: {
        header: (name) =>
          name.toLowerCase() === "content-type" ? contentType : undefined,
        query: (key) => resolveScopeQuery(key),
        raw: { body },
      },
    };

    const res = await handlers.speech(ctx);
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: { code: string } };
    expect(err.error.code).toBe("invalid_request");
  });

  it("synthesizes speech successfully and returns audio/mpeg with headers", async () => {
    const expectedAudio = new Uint8Array([1, 2, 3, 4, 5]);
    const handlers = createVoiceHandlers({
      asr: () => undefined,
      resolvePrincipal: async () => createPrincipal(),
      store: () => createMockStore(),
      tts: () => ({
        defaultVoice: "af_heart",
        name: "test-tts",
        synthesize: async (input) => {
          await Promise.resolve();
          expect(input.text).toBe("Hello, this is ReasonateAI speaking.");
          expect(input.voice).toBe("af_heart");
          expect(input.format).toBe("mp3");
          return {
            audio: expectedAudio,
            mediaType: "audio/mpeg",
          };
        },
      }),
    });

    const { body, contentType } = createJsonStream({
      format: "mp3",
      text: "Hello, this is ReasonateAI speaking.",
      voice: "af_heart",
    });

    const ctx: VoiceHandlerContext = {
      json: (payload, status) =>
        new Response(JSON.stringify(payload), { status }),
      req: {
        header: (name) =>
          name.toLowerCase() === "content-type" ? contentType : undefined,
        query: (key) => resolveScopeQuery(key),
        raw: { body },
      },
    };

    const res = await handlers.synthesize(ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-length")).toBe("5");
    const audioData = new Uint8Array(await res.arrayBuffer());
    expect(audioData).toEqual(expectedAudio);
  });

  it("handles TtsProviderError gracefully with 500 internal", async () => {
    const handlers = createVoiceHandlers({
      asr: () => undefined,
      resolvePrincipal: async () => createPrincipal(),
      store: () => createMockStore(),
      tts: () => ({
        defaultVoice: "af_heart",
        name: "failing-tts",
        synthesize: async () => {
          await Promise.resolve();
          throw new TtsProviderError(
            "The speech endpoint failed with status 503.",
            { status: 503 }
          );
        },
      }),
    });

    const { body, contentType } = createJsonStream({
      text: "Failing synthesis test",
    });

    const ctx: VoiceHandlerContext = {
      json: (payload, status) =>
        new Response(JSON.stringify(payload), { status }),
      req: {
        header: (name) =>
          name.toLowerCase() === "content-type" ? contentType : undefined,
        query: (key) => resolveScopeQuery(key),
        raw: { body },
      },
    };

    const res = await handlers.speech(ctx);
    expect(res.status).toBe(500);
    const err = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(err.error.code).toBe("internal");
    expect(err.error.message).toContain("status 503");
  });
});
