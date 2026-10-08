import { CSRF_COOKIE, CSRF_HEADER } from "@reasonateai/contracts/auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { networkManager } from "./network-state";
import {
  ApiRequestError,
  exportWorkspaceZip,
  request,
  synthesizeSpeech,
} from "./product-api";

afterEach(() => vi.unstubAllGlobals());

describe("authenticated product requests", () => {
  it.each([
    new DOMException("deadline", "TimeoutError"),
    new DOMException("navigation", "AbortError"),
  ])(
    "keeps request cancellation separate from network loss: %s",
    async (reason) => {
      vi.stubGlobal("document", { cookie: "" });
      const controller = new AbortController();
      controller.abort(reason);
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(reason));
      const failure = vi.spyOn(networkManager, "notifyNetworkFailure");
      const report = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      try {
        await expect(
          request("/v1/example", (value) => value, {
            signal: controller.signal,
          })
        ).rejects.toMatchObject({ cause: reason });
        expect(failure).not.toHaveBeenCalled();
        expect(JSON.parse(report.mock.calls[0]?.[0] as string)).toMatchObject({
          reason:
            reason.name === "TimeoutError"
              ? "request_timeout"
              : "request_aborted",
        });
      } finally {
        failure.mockRestore();
        report.mockRestore();
      }
    }
  );

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

  describe("synthesizeSpeech", () => {
    it("posts JSON with CSRF token and returns an audio Blob on success", async () => {
      vi.stubGlobal("document", { cookie: `${CSRF_COOKIE}=speech-csrf` });
      const mockAudioBlob = new Blob(["mock-audio-data"], {
        type: "audio/mpeg",
      });
      const transport = vi.fn().mockResolvedValue(
        new Response(mockAudioBlob, {
          headers: { "content-type": "audio/mpeg" },
          status: 200,
        })
      );
      vi.stubGlobal("fetch", transport);

      const blob = await synthesizeSpeech({
        format: "mp3",
        organizationId: "org-123",
        projectId: "proj-456",
        speed: 1.0,
        text: "ReasonateAI synthesized speech test.",
        voice: "af_heart",
      });

      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBe(mockAudioBlob.size);
      expect(transport).toHaveBeenCalledTimes(1);
      const [calledUrl, calledOptions] = transport.mock.calls[0] as [
        string,
        RequestInit & { headers: Record<string, string> },
      ];
      expect(calledUrl).toBe(
        "/v1/voice/speech?organizationId=org-123&projectId=proj-456"
      );
      expect(calledOptions.credentials).toBe("same-origin");
      expect(calledOptions.headers["content-type"]).toBe("application/json");
      expect(calledOptions.headers[CSRF_HEADER]).toBe("speech-csrf");
      expect(JSON.parse(calledOptions.body as string)).toEqual({
        format: "mp3",
        speed: 1.0,
        text: "ReasonateAI synthesized speech test.",
        voice: "af_heart",
      });
    });

    it("throws ApiRequestError when speech synthesis is unconfigured (503)", async () => {
      vi.stubGlobal("document", { cookie: `${CSRF_COOKIE}=speech-csrf` });
      const transport = vi.fn().mockResolvedValue(
        Response.json(
          {
            error: {
              code: "voice_unconfigured",
              message: "Text-to-speech is not configured for this deployment.",
            },
          },
          { status: 503 }
        )
      );
      vi.stubGlobal("fetch", transport);

      await expect(
        synthesizeSpeech({
          organizationId: "org-1",
          projectId: "proj-1",
          text: "Test synthesis unconfigured",
        })
      ).rejects.toMatchObject({
        code: "voice_unconfigured",
        message: "Text-to-speech is not configured for this deployment.",
        status: 503,
      });
    });

    it("ensures plain 503 response without JSON error still gets voice_unconfigured code", async () => {
      vi.stubGlobal("document", { cookie: `${CSRF_COOKIE}=speech-csrf` });
      const transport = vi
        .fn()
        .mockResolvedValue(
          new Response("Service Unavailable", { status: 503 })
        );
      vi.stubGlobal("fetch", transport);

      await expect(
        synthesizeSpeech({
          organizationId: "org-1",
          projectId: "proj-1",
          text: "Test plain 503",
        })
      ).rejects.toMatchObject({
        code: "voice_unconfigured",
        status: 503,
      });
    });

    it("throws a user-readable error on network disconnect", async () => {
      vi.stubGlobal("document", { cookie: `${CSRF_COOKIE}=speech-csrf` });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new TypeError("Failed to fetch"))
      );

      await expect(
        synthesizeSpeech({
          organizationId: "org-1",
          projectId: "proj-1",
          text: "Test synthesis network failure",
        })
      ).rejects.toThrow("The speech synthesis service could not be reached");
    });
  });

  describe("exportWorkspaceZip", () => {
    it("requests zip export with same-origin credentials, CSRF header, and returns Blob", async () => {
      vi.stubGlobal("document", { cookie: `${CSRF_COOKIE}=zip-csrf-token` });
      const mockBlob = new Blob(["PK\x03\x04zipdata"], {
        type: "application/zip",
      });
      const transport = vi.fn().mockResolvedValue(
        new Response(mockBlob, {
          headers: {
            "content-disposition": 'attachment; filename="my-app-source.zip"',
            "content-type": "application/zip",
          },
          status: 200,
        })
      );
      vi.stubGlobal("fetch", transport);

      const result = await exportWorkspaceZip({
        buildSessionId: "session-123",
        organizationId: "org-1",
        projectId: "proj-1",
        projectName: "my-app",
      });

      expect(transport).toHaveBeenCalledTimes(1);
      const [url, init] = transport.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/v1/build-sessions/session-123/workspace/export?");
      expect(url).toContain("organizationId=org-1");
      expect(url).toContain("projectId=proj-1");
      expect(url).toContain("projectName=my-app");
      expect(init.method).toBe("GET");
      expect(init.credentials).toBe("same-origin");
      expect((init.headers as Record<string, string>)[CSRF_HEADER]).toBe(
        "zip-csrf-token"
      );
      expect(result).toBeInstanceOf(Blob);
    });

    it("throws ApiRequestError when the export request is refused", async () => {
      vi.stubGlobal("document", { cookie: "" });
      const transport = vi.fn().mockResolvedValue(
        Response.json(
          {
            error: {
              code: "forbidden",
              message: "You are not authorized to read this project.",
            },
          },
          { status: 403 }
        )
      );
      vi.stubGlobal("fetch", transport);

      await expect(
        exportWorkspaceZip({
          buildSessionId: "session-123",
          organizationId: "org-1",
          projectId: "proj-1",
        })
      ).rejects.toMatchObject({
        code: "forbidden",
        message: "You are not authorized to read this project.",
        status: 403,
      });
    });

    it("throws a user-readable error on network disconnect", async () => {
      vi.stubGlobal("document", { cookie: "" });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new TypeError("Failed to fetch"))
      );

      await expect(
        exportWorkspaceZip({
          buildSessionId: "session-123",
          organizationId: "org-1",
          projectId: "proj-1",
        })
      ).rejects.toThrow("The workspace export service could not be reached");
    });
  });
});
