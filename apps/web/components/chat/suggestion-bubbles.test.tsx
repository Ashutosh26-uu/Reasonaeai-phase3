import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SuggestionBubbles } from "./suggestion-bubbles";
import type { PromptSuggestion } from "./suggestions";

const mockSuggestions: PromptSuggestion[] = [
  {
    category: "ai",
    categoryLabel: "✨ AI Features",
    icon: "sparkles",
    id: "sugg-1",
    prompt: "Add AI lyrics translation and chord detection",
    title: "Add AI lyrics capabilities",
  },
  {
    category: "design",
    categoryLabel: "Design",
    icon: "design",
    id: "sugg-2",
    prompt: "Add lyric hover effects with karaoke glow",
    title: "Add lyric hover effects",
  },
  {
    category: "feature",
    categoryLabel: "New feature",
    icon: "feature",
    id: "sugg-3",
    prompt: "Add progress audio visualizer with seek scrubbing",
    title: "Add progress audio visualizer",
  },
  {
    category: "quality",
    categoryLabel: "Reliability",
    icon: "quality",
    id: "sugg-4",
    prompt: "Add playback error recovery and tests",
    title: "Add error recovery",
  },
];

describe("SuggestionBubbles", () => {
  it("renders all 4 suggestions with titles and category badges", () => {
    const html = renderToStaticMarkup(
      <SuggestionBubbles
        onDismiss={vi.fn()}
        onRefresh={vi.fn()}
        onSelect={vi.fn()}
        suggestions={mockSuggestions}
      />
    );

    expect(html).toContain("Add AI lyrics capabilities");
    expect(html).toContain("Add lyric hover effects");
    expect(html).toContain("Add progress audio visualizer");
    expect(html).toContain("Add error recovery");

    expect(html).toContain("✨ AI Features");
    expect(html).toContain("Design");
    expect(html).toContain("New feature");
    expect(html).toContain("Reliability");

    expect(html).toContain('aria-label="More suggestions"');
    expect(html).toContain('aria-label="Dismiss suggestions"');
  });

  it("renders nothing when suggestions array is empty", () => {
    const html = renderToStaticMarkup(
      <SuggestionBubbles onSelect={vi.fn()} suggestions={[]} />
    );
    expect(html).toBe("");
  });

  it("renders watermark icons with aria-hidden", () => {
    const html = renderToStaticMarkup(
      <SuggestionBubbles onSelect={vi.fn()} suggestions={mockSuggestions} />
    );
    expect(html).toContain('aria-hidden="true"');
  });

  it("applies disabled attributes when disabled prop is true", () => {
    const html = renderToStaticMarkup(
      <SuggestionBubbles
        disabled
        onDismiss={vi.fn()}
        onRefresh={vi.fn()}
        onSelect={vi.fn()}
        suggestions={mockSuggestions}
      />
    );
    // Button elements should have disabled attribute
    expect(html).toContain("disabled");
  });

  it("omits action buttons when onRefresh and onDismiss are not provided", () => {
    const html = renderToStaticMarkup(
      <SuggestionBubbles onSelect={vi.fn()} suggestions={mockSuggestions} />
    );
    expect(html).not.toContain('aria-label="More suggestions"');
    expect(html).not.toContain('aria-label="Dismiss suggestions"');
  });

  it("renders watermark pencil-ruler for design suggestions", () => {
    const designSuggestions = mockSuggestions.filter(
      (item) => item.category === "design"
    );
    const html = renderToStaticMarkup(
      <SuggestionBubbles onSelect={vi.fn()} suggestions={designSuggestions} />
    );
    expect(html).toContain("lucide-pencil-ruler");
  });
});
