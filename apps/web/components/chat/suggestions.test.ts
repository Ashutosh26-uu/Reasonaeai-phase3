import { describe, expect, it } from "vitest";
import {
  detectDomain,
  generatePromptSuggestions,
  type SuggestionContext,
} from "./suggestions";

describe("detectDomain", () => {
  it("detects audio domain from prompt keywords", () => {
    const domain = detectDomain({
      userPrompt: "Build an audio player with synchronized lyrics",
    });
    expect(domain).toBe("audio");
  });

  it("detects audio domain from modified checkpoint files", () => {
    const domain = detectDomain({
      checkpointFiles: [
        { path: "src/components/AudioPlayer.tsx", status: "added" },
        { path: "src/styles/visualizer.css", status: "added" },
      ],
    });
    expect(domain).toBe("audio");
  });

  it("detects dashboard domain from metrics and charts keywords", () => {
    const domain = detectDomain({
      userPrompt: "Create a sales analytics dashboard with charts",
    });
    expect(domain).toBe("dashboard");
  });

  it("detects commerce domain from shop/cart keywords", () => {
    const domain = detectDomain({
      userPrompt: "Add shopping cart drawer and checkout flow",
    });
    expect(domain).toBe("commerce");
  });

  it("detects productivity domain from todo/kanban keywords", () => {
    const domain = detectDomain({
      userPrompt: "Create a kanban board with task cards",
    });
    expect(domain).toBe("productivity");
  });

  it("detects auth domain from login/session keywords", () => {
    const domain = detectDomain({
      userPrompt: "Implement OAuth login and user session management",
    });
    expect(domain).toBe("auth");
  });

  it("detects chat domain from messaging keywords", () => {
    const domain = detectDomain({
      userPrompt: "Add real-time chat with message threads",
    });
    expect(domain).toBe("chat");
  });

  it("detects game domain from canvas/score keywords", () => {
    const domain = detectDomain({
      userPrompt: "Create a 2D canvas game with high score loop",
    });
    expect(domain).toBe("game");
  });

  it("falls back to general domain when context is empty or unspecific", () => {
    const domain = detectDomain({});
    expect(domain).toBe("general");
  });

  it("correctly detects auth domain even when assistant uses 'In order to...' phrasing", () => {
    const domain = detectDomain({
      assistantText: "In order to help you, I configured OAuth credentials.",
      userPrompt: "Build a login and signup page with OAuth",
    });
    expect(domain).toBe("auth");
  });

  it("correctly detects game domain for '2-player snake game' without false-triggering audio", () => {
    const domain = detectDomain({
      assistantText: "I implemented snake movement and canvas rendering.",
      userPrompt: "Create a 2-player snake game",
    });
    expect(domain).toBe("game");
  });

  it("classifies calculator as general without false-triggering productivity from 'completed task'", () => {
    const domain = detectDomain({
      assistantText:
        "I have completed this task for you and created the calculator.",
      userPrompt: "Create a simple calculator",
    });
    expect(domain).toBe("general");
  });

  it("detects auth domain for GraphQL endpoint without false-triggering dashboard from 'graph'", () => {
    const domain = detectDomain({
      assistantText: "I configured the GraphQL schema and resolvers for users.",
      userPrompt: "Set up a GraphQL endpoint for user auth",
    });
    expect(domain).toBe("auth");
  });

  it("detects chat domain when assistant mentions 'track messages' without false-triggering audio", () => {
    const domain = detectDomain({
      assistantText:
        "In order to track messages, I set up WebSocket connection.",
      userPrompt: "Create a chat app with real-time messages",
    });
    expect(domain).toBe("chat");
  });

  it("prioritizes project name when detecting domain", () => {
    const domain = detectDomain({
      projectName: "retro-arcade-adventure",
      userPrompt: "Add keyboard controls",
    });
    expect(domain).toBe("game");
  });

  it("bounds checkpoint files inspection without crashing on large file lists", () => {
    const massiveFiles = Array.from({ length: 500 }, (_, i) => ({
      path: `src/generated/file_${i}.ts`,
      status: "added",
    }));
    massiveFiles.push({ path: "src/audio/synthesizer.ts", status: "added" });
    const domain = detectDomain({ checkpointFiles: massiveFiles });
    expect(domain).toBe("general");
  });
});

describe("generatePromptSuggestions", () => {
  it("generates exactly 4 suggestions spanning the 4 required categories", () => {
    const context: SuggestionContext = {
      userPrompt: "Build a music player with lyrics",
    };
    const suggestions = generatePromptSuggestions(context);

    expect(suggestions).toHaveLength(4);
    const categories = suggestions.map((item) => item.category);
    expect(categories).toEqual(["ai", "design", "feature", "quality"]);

    const [s0, s1, s2, s3] = suggestions;
    expect(s0?.categoryLabel).toBe("✨ AI Features");
    expect(s1?.categoryLabel).toBe("Design");
    expect(s2?.categoryLabel).toBe("New feature");
    expect(s3?.categoryLabel).toBe("Reliability");

    // Check that title and prompt are populated and actionable
    for (const item of suggestions) {
      expect(item.title.length).toBeGreaterThan(5);
      expect(item.prompt.length).toBeGreaterThan(15);
      expect(item.id).toBeDefined();
    }
  });

  it("produces tailored suggestions matching the reference screenshot for audio apps", () => {
    const suggestions = generatePromptSuggestions({
      userPrompt: "Add lyric player component",
    });

    const titles = suggestions.map((s) => s.title);
    // Matches screenshot features: "Add lyric hover effects", "Add progress audio visualizer"
    expect(titles).toContain("Add lyric hover effects");
    expect(titles).toContain("Add progress audio visualizer");
  });

  it("rotates suggestions when a seed is provided (refresh / shuffle)", () => {
    const base = generatePromptSuggestions({
      seed: 0,
      userPrompt: "Dashboard metrics",
    });
    const rotated = generatePromptSuggestions({
      seed: 1,
      userPrompt: "Dashboard metrics",
    });

    // Should generate distinct titles on next seed rotation
    const [b0, b1] = base;
    const [r0, r1] = rotated;
    expect(b0?.title).not.toEqual(r0?.title);
    expect(b1?.title).not.toEqual(r1?.title);
  });

  it("handles empty context gracefully and provides robust fallback suggestions", () => {
    const suggestions = generatePromptSuggestions({});
    expect(suggestions).toHaveLength(4);
    expect(suggestions.every((item) => item.title && item.prompt)).toBe(true);
  });
});
