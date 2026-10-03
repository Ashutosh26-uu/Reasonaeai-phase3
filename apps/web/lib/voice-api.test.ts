import { CSRF_COOKIE, CSRF_HEADER } from "@reasonateai/contracts/auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "./product-api";
import { synthesizeSpeech } from "./voice-api";

describe("voice synthesis client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks the product to speak a turn and returns the audio it produced", async () => {
    vi.stubGlobal("document", { cookie: `${CSRF_COOKIE}=csrf-token-1` });
    const calls: { body: unknown; headers: Headers; url: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit) => {
        calls.push({
          body: JSON.parse(String(init.body)),
          headers: new Headers(init.headers),
          url,
        });
        return new Response(new Uint8Array([4, 5, 6]), {
          headers: {
            "content-type": "audio/mpeg",
            "x-reasonate-voice-provider": "openai-compatible",
          },
          status: 200,
        });
      })
    );

    const speech = await synthesizeSpeech(
      {
        format: "mp3",
        language: "en",
        text: "The build passed.",
        voice: "af_heart",
      },
      { organizationId: "org-1", projectId: "proj-1" }
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "/v1/voice/speech?organizationId=org-1&projectId=proj-1"
    );
    expect(calls[0]?.headers.get(CSRF_HEADER)).toBe("csrf-token-1");
    expect(calls[0]?.body).toEqual({
      format: "mp3",
      language: "en",
      text: "The build passed.",
      voice: "af_heart",
    });
    expect(speech.mimeType).toBe("audio/mpeg");
    expect(speech.provider).toBe("openai-compatible");
    expect(new Uint8Array(await speech.audio.arrayBuffer())).toEqual(
      new Uint8Array([4, 5, 6])
    );
  });

  it("omits hints the caller did not decide", async () => {
    vi.stubGlobal("document", { cookie: "" });
    const calls: unknown[] = [];
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

    const speech = await synthesizeSpeech(
      { text: "Hi" },
      { organizationId: "org-1", projectId: "proj-1" }
    );

    expect(calls).toEqual([{ text: "Hi" }]);
    expect(speech.mimeType).toBe("audio/wav");
    expect(speech.provider).toBeNull();
  });

  it("surfaces a typed refusal the person can read", async () => {
    vi.stubGlobal("document", { cookie: "" });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Response(
            JSON.stringify({
              error: {
                code: "voice_unconfigured",
                message:
                  "Text-to-speech is not configured for this deployment.",
                requestId: "req-1",
              },
            }),
            {
              headers: { "content-type": "application/json" },
              status: 503,
            }
          )
      )
    );

    const failure = await synthesizeSpeech(
      { text: "Hi" },
      { organizationId: "org-1", projectId: "proj-1" }
    ).catch((error: unknown) => error);

    if (!(failure instanceof ApiRequestError)) {
      throw failure;
    }
    expect(failure.status).toBe(503);
    expect(failure.message).toContain("not configured");
  });
});
