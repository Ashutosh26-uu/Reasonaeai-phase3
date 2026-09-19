import { describe, expect, it } from "vitest";
import { reasonateCtoRuntime } from "../src/mastra/index";

const AUTONOMOUS_CTO_PATTERN = /autonomous CTO/i;

describe("API CTO runtime host", () => {
  it("registers the branded full-capability CTO mode", () => {
    const [mode] = reasonateCtoRuntime.controller.listModes();

    expect(reasonateCtoRuntime.mainAgent.getDescription()).toMatch(
      AUTONOMOUS_CTO_PATTERN
    );
    expect(mode?.id).toBe("cto");
    expect(mode?.availableTools).toBeUndefined();
  });
});
