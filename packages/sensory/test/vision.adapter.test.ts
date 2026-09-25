import type { VisionInput, VisionOutput } from "@reasonateai/contracts/sensory";
import { describe, expect, it, vi } from "vitest";

import { createVisionAdapter } from "../src/vision/vision.adapter.js";

const input: VisionInput = {
  image: new Uint8Array([1, 2, 3]),
  mimeType: "image/png",
  prompt: "Extract the visible UI requirements.",
};

const output: VisionOutput = {
  elements: [
    {
      description: "Primary heading",
      text: "Dashboard",
      type: "text",
    },
  ],
  summary: "A dashboard wireframe with a primary heading.",
};

describe("Vision adapter", () => {
  it("delegates extraction to the configured provider", async () => {
    // The adapter is intentionally thin. Model-specific behavior belongs
    // inside the provider, while callers depend only on the stable adapter
    // contract.
    const extract = vi.fn().mockResolvedValue(output);

    const adapter = createVisionAdapter({ extract });

    await expect(adapter.extract(input)).resolves.toEqual(output);
    expect(extract).toHaveBeenCalledWith(input);
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it("supports replacing the Vision provider without changing the adapter", async () => {
    // Different providers can return different results, but the caller
    // should not need to know which Vision model or inference backend is used.
    const firstProvider = {
      extract: vi.fn().mockResolvedValue(output),
    };

    const secondOutput: VisionOutput = {
      elements: [],
      summary: "A different provider returned no elements.",
    };

    const secondProvider = {
      extract: vi.fn().mockResolvedValue(secondOutput),
    };

    // Both providers are consumed through the exact same adapter factory.
    // This is the key property that lets us swap Qwen, a proprietary model,
    // or another OpenAI-compatible backend later without changing callers.
    const firstAdapter = createVisionAdapter(firstProvider);
    const secondAdapter = createVisionAdapter(secondProvider);

    await expect(firstAdapter.extract(input)).resolves.toEqual(output);
    await expect(secondAdapter.extract(input)).resolves.toEqual(secondOutput);
  });

  it("propagates provider failures unchanged", async () => {
    // The adapter should not hide or rewrite provider failures. Higher layers
    // such as the sensory gateway are responsible for adding operation-level
    // error handling, timeouts, and observability.
    const failure = new Error("Vision provider unavailable");
    const extract = vi.fn().mockRejectedValue(failure);

    const adapter = createVisionAdapter({ extract });

    await expect(adapter.extract(input)).rejects.toBe(failure);
  });
});
