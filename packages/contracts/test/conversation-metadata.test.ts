import { describe, expect, it } from "vitest";
import { UpdateConversationRequestSchema } from "../src/execution.js";

describe("conversation metadata commands", () => {
  it("trims valid names and supports explicit reversible archive decisions", () => {
    expect(
      UpdateConversationRequestSchema.parse({ title: "  My app  " })
    ).toEqual({ title: "My app" });
    expect(UpdateConversationRequestSchema.parse({ archived: false })).toEqual({
      archived: false,
    });
    expect(UpdateConversationRequestSchema.parse({ archived: true })).toEqual({
      archived: true,
    });
  });
  it.each([
    {},
    { title: " " },
    { title: "a".repeat(501) },
    { archived: true, title: "App" },
    { archived: "true" },
    { organizationId: "other", title: "App" },
  ])("rejects ambiguous or invalid edits: %j", (body) => {
    expect(UpdateConversationRequestSchema.safeParse(body).success).toBe(false);
  });
});
