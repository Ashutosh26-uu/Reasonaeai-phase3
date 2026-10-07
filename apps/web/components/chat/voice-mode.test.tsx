import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { VoiceMode, type VoiceModeProps } from "./voice-mode";

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
