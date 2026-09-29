import { describe, expect, it } from "vitest";
import { MockASRAdapter } from "../src/mock-asr-adapter.js";
import { MockVisionAdapter } from "../src/mock-vision-adapter.js";

describe("Mock Adapters", () => {
  it("MockASRAdapter returns deterministic output", async () => {
    const adapter = new MockASRAdapter();
    const result = await adapter.processAudio(new Blob());
    expect(result).toHaveProperty("title", "Sample Application");
    expect(result).toHaveProperty(
      "description",
      "Sample requirement generated from voice input (MOCK)"
    );
    expect(result).toHaveProperty("requirements", [
      "Requirement 1",
      "Requirement 2",
    ]);
  });

  it("MockVisionAdapter returns deterministic output", async () => {
    const adapter = new MockVisionAdapter();
    const result = await adapter.processImage(new File([], "test.png"));
    expect(result).toHaveProperty("screens", ["Dashboard (Mock)"]);
    expect(result).toHaveProperty("components", [
      "Data Table (Mock)",
      "Sidebar (Mock)",
    ]);
    expect(result).toHaveProperty(
      "workflow",
      "User navigates to dashboard to view records (MOCK)"
    );
    expect(result).toHaveProperty("inferredFeatures", [
      "Pagination (Mock)",
      "Filtering (Mock)",
    ]);
  });
});
