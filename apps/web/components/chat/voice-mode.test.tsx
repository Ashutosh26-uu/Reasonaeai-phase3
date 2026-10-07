import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  isFallbackEligibleError,
  prepareSpeechText,
  VoiceMode,
  type VoiceModeProps,
} from "./voice-mode";

const defaultProps: VoiceModeProps = {
  busy: false,
  disabled: false,
  onClose: vi.fn(),
  onStop: vi.fn(),
  onSubmit: vi.fn(async () => true),
  onSynthesize: vi.fn(
    async () => new Blob(["test-audio"], { type: "audio/mpeg" })
  ),
  onTranscribe: vi.fn(async () => "Transcription"),
  projectName: "ReasonateAI Project",
  response: null,
};

describe("VoiceMode helpers", () => {
  describe("prepareSpeechText", () => {
    it("returns short text trimmed as-is", () => {
      expect(prepareSpeechText("  Hello world!  ")).toBe("Hello world!");
    });

    it("truncates text exceeding maxLength at sentence boundary", () => {
      const sentence1 = "First sentence of the response. ";
      const sentence2 = "Second sentence of the response. ";
      const sentence3 = "Third sentence that goes beyond the limit.";
      const combined = sentence1 + sentence2 + sentence3;
      const prepared = prepareSpeechText(
        combined,
        sentence1.length + sentence2.length + 5
      );
      expect(prepared).toBe((sentence1 + sentence2).trim());
    });

    it("hard-truncates when no sentence boundary exists in upper half", () => {
      const longWord = "a".repeat(100);
      expect(prepareSpeechText(longWord, 50)).toBe("a".repeat(50));
    });
  });

  describe("isFallbackEligibleError", () => {
    it("returns true for unconfigured code or status 503", () => {
      expect(
        isFallbackEligibleError({ code: "voice_unconfigured", status: 503 })
      ).toBe(true);
      expect(isFallbackEligibleError({ code: "voice_unconfigured" })).toBe(
        true
      );
      expect(isFallbackEligibleError({ status: 503 })).toBe(true);
      expect(
        isFallbackEligibleError(new Error("Text-to-speech is not configured"))
      ).toBe(true);
    });

    it("returns true for network disconnect or unreachable error", () => {
      expect(isFallbackEligibleError(new TypeError("Failed to fetch"))).toBe(
        true
      );
      expect(
        isFallbackEligibleError(
          new Error("The speech synthesis service could not be reached")
        )
      ).toBe(true);
    });

    it("returns false for authorization, authentication, or server errors", () => {
      expect(
        isFallbackEligibleError({
          code: "forbidden",
          message: "Forbidden",
          status: 403,
        })
      ).toBe(false);
      expect(
        isFallbackEligibleError({
          code: "unauthenticated",
          message: "Unauthorized",
          status: 401,
        })
      ).toBe(false);
      expect(
        isFallbackEligibleError({
          code: "invalid_request",
          message: "Bad Request",
          status: 400,
        })
      ).toBe(false);
      expect(
        isFallbackEligibleError({
          code: "internal",
          message: "Server error",
          status: 500,
        })
      ).toBe(false);
      expect(
        isFallbackEligibleError(new Error("Database connection error"))
      ).toBe(false);
    });
  });
});

describe("VoiceMode component", () => {
  it("renders voice mode surface with speech synthesis capability enabled", () => {
    const html = renderToStaticMarkup(<VoiceMode {...defaultProps} />);

    expect(html).toContain('aria-label="Voice chat"');
    expect(html).toContain("ReasonateAI Project");
    expect(html).toContain("Responses are spoken aloud.");
    expect(html).toContain("Start speaking");
    expect(html).toContain('aria-label="Mute spoken responses"');
  });

  it("renders fallback message when onSynthesize is not provided and no device voice is present", () => {
    const html = renderToStaticMarkup(
      <VoiceMode {...defaultProps} onSynthesize={undefined} />
    );

    expect(html).toContain(
      "A device voice is unavailable. Responses appear here as text."
    );
  });

  it("renders spoken response controls when response is present", () => {
    const html = renderToStaticMarkup(
      <VoiceMode
        {...defaultProps}
        response={{ id: "resp-1", text: "Your plan is ready to execute." }}
      />
    );

    expect(html).toContain("Your CTO");
    expect(html).toContain("Your plan is ready to execute.");
    expect(html).toContain('aria-label="Read response aloud"');
  });
});
