import { describe, expect, it } from "vitest";
import {
  EditableSpecificationSchema,
  StructuredIntentSchema,
  SurfaceErrorSchema,
} from "../src/intent.js";

describe("intent contracts", () => {
  it("validates EditableSpecification correctly", () => {
    const validSpec = {
      description: "Sample desc",
      requirements: ["Req 1"],
      title: "Sample",
    };
    expect(EditableSpecificationSchema.parse(validSpec)).toEqual(validSpec);

    const invalidSpec = {
      title: "Sample",
    };
    expect(() => EditableSpecificationSchema.parse(invalidSpec)).toThrow();
  });

  it("validates StructuredIntent correctly", () => {
    const validIntent = {
      components: ["Header"],
      inferredFeatures: ["Auth"],
      screens: ["Home"],
      workflow: "User clicks login",
    };
    expect(StructuredIntentSchema.parse(validIntent)).toEqual(validIntent);
  });

  it("validates SurfaceError correctly", () => {
    const validError = {
      code: "TEST_ERROR",
      message: "Internal test error",
      userMessage: "Something went wrong.",
    };
    expect(SurfaceErrorSchema.parse(validError)).toEqual(validError);
  });
});
