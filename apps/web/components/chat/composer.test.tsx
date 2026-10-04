import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Composer, type ComposerProps } from "./composer";

const props: ComposerProps = {
  busy: false,
  count: 0,
  draft: "",
  hasConversation: false,
  limit: 20_000,
  model: "deepseek-flash",
  onChange: vi.fn(),
  onCreateProject: vi.fn(async () => true),
  onKeyDown: vi.fn(),
  onProjectSelect: vi.fn(),
  onStop: vi.fn(),
  onSubmit: vi.fn(async () => true),
  onTranscribe: vi.fn(async () => "Hello"),
  onVoiceMode: vi.fn(),
  pending: false,
  placeholder: "Message your CTO",
  projectId: "project",
  projectPickerDisabled: false,
  projects: [],
  stopping: false,
};

describe("composer primary action", () => {
  it("shows project/file context only before a conversation is selected", () => {
    const withFiles = {
      ...props,
      listFiles: vi.fn(async () => ["index.html"]),
    };
    const fresh = renderToStaticMarkup(<Composer {...withFiles} />);
    expect(fresh).toContain("project-picker-trigger");
    expect(fresh).toContain('aria-label="Mention a file from this project"');
    const selected = renderToStaticMarkup(
      <Composer {...withFiles} hasConversation />
    );
    expect(selected).not.toContain("project-picker-trigger");
    expect(selected).not.toContain(
      'aria-label="Mention a file from this project"'
    );
    expect(selected).toContain('aria-label="Add to message"');
    expect(selected).toContain('aria-haspopup="menu"');
    expect(selected).toContain('aria-label="Speak your message"');
    expect(selected).toContain('aria-label="Send message"');
  });
  it("offers only voice mode in a fresh empty conversation", () => {
    const html = renderToStaticMarkup(<Composer {...props} />);
    expect(html).toContain('aria-label="Open voice mode"');
    expect(html).not.toContain('aria-label="Send message"');
    expect(html).not.toContain('aria-label="Stop run"');
  });

  it.each([{ draft: "Hello" }, { hasConversation: true }])(
    "shows only Send for a draft or existing text conversation: %j",
    (state) => {
      const html = renderToStaticMarkup(<Composer {...props} {...state} />);
      expect(html).toContain('aria-label="Send message"');
      expect(html).not.toContain('aria-label="Open voice mode"');
      expect(html).not.toContain('aria-label="Stop run"');
    }
  );

  it("shows Stop only during execution and returns to Send while saving", () => {
    const working = renderToStaticMarkup(
      <Composer {...props} hasConversation pending />
    );
    expect(working).toContain('aria-label="Stop run"');
    expect(working).not.toContain('aria-label="Open voice mode"');
    expect(working).not.toContain('aria-label="Send message"');
    const saving = renderToStaticMarkup(
      <Composer {...props} busy hasConversation />
    );
    expect(saving).toContain('aria-label="Send message"');
    expect(saving).not.toContain('aria-label="Stop run"');
  });
  it("shows a disabled arrow once Stop has been requested", () => {
    const html = renderToStaticMarkup(
      <Composer {...props} hasConversation pending stopping />
    );
    expect(html).toContain('aria-label="Stopping run"');
    expect(html).toContain("lucide-arrow-up");
    expect(html).not.toContain("lucide-square");
    expect(html).toContain("disabled");
  });
});
