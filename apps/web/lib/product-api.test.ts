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
        headers: expect.objectContaining({
          [CSRF_HEADER]: "test-csrf",
          "x-request-id": expect.any(String),
        }),
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
        headers: expect.objectContaining({
          "content-type": "application/json",
          [CSRF_HEADER]: "test-csrf",
        }),
      })
    );
  });
  it("explains a missing running route and logs correlation without message content", async () => {
    vi.stubGlobal("document", { cookie: `${CSRF_COOKIE}=private-csrf` });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("404 Not Found", { status: 404 }))
    );
    const report = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    try {
      await expect(
        request(
          "/v1/example/steering?organizationId=scoped",
          (value) => value,
          {
            body: JSON.stringify({ message: "private steering content" }),
            method: "POST",
          }
        )
      ).rejects.toMatchObject({
        message: expect.stringContaining("latest branch"),
        requestId: expect.any(String),
        status: 404,
      });
      const diagnostic = JSON.parse(report.mock.calls[0]?.[0] as string);
      expect(diagnostic).toMatchObject({
        event: "product.request.failed",
        path: "/v1/example/steering",
        requestId: expect.any(String),
        status: 404,
      });
      expect(JSON.stringify(diagnostic)).not.toContain("private");
      expect(JSON.stringify(diagnostic)).not.toContain("organizationId");
    } finally {
      report.mockRestore();
    }
  });
});
