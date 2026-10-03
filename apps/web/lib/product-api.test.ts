import { CSRF_COOKIE, CSRF_HEADER } from "@reasonateai/contracts/auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, request } from "./product-api";

afterEach(() => vi.unstubAllGlobals());

describe("authenticated product requests", () => {
  it("sends multipart audio with session CSRF and a browser-generated boundary", async () => {
    vi.stubGlobal("document", { cookie: `${CSRF_COOKIE}=test-csrf` });
    const transport = vi
      .fn()
      .mockResolvedValue(Response.json({ text: "A project update" }));
    vi.stubGlobal("fetch", transport);
    const audio = new FormData();
    audio.append(
      "audio",
      new Blob(["recording"], { type: "audio/webm" }),
      "message.webm"
    );
    await expect(
      request("/v1/voice/transcriptions", (value) => value, {
        body: audio,
        method: "POST",
      })
    ).resolves.toEqual({ text: "A project update" });
    expect(transport).toHaveBeenCalledWith(
      "/v1/voice/transcriptions",
      expect.objectContaining({
        body: audio,
        credentials: "same-origin",
        headers: { [CSRF_HEADER]: "test-csrf" },
      })
    );
  });

  it("preserves JSON requests and the service's actionable error", async () => {
    vi.stubGlobal("document", { cookie: `${CSRF_COOKIE}=test-csrf` });
    const transport = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { error: { message: "Voice transcription is not configured." } },
          { status: 503 }
        )
      );
    vi.stubGlobal("fetch", transport);
    await expect(
      request("/v1/example", (value) => value, { body: "{}", method: "POST" })
    ).rejects.toEqual(
      new ApiRequestError(503, "Voice transcription is not configured.")
    );
    expect(transport).toHaveBeenCalledWith(
      "/v1/example",
      expect.objectContaining({
        headers: {
          "content-type": "application/json",
          [CSRF_HEADER]: "test-csrf",
        },
      })
    );
  });
});
