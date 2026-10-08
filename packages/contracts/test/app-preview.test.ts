import { describe, expect, it } from "vitest";
import {
  AppPreviewConfigurationSchema,
  OpenAppPreviewRequestSchema,
} from "../src/execution.js";

describe("explicit app preview targets", () => {
  it.each([
    "http://127.0.0.1:5173/dashboard",
    "http://localhost:3000/",
    "http://0.0.0.0:8080/",
    "http://[::1]:4321/",
  ])("accepts a sandbox-local target: %s", (url) => {
    expect(OpenAppPreviewRequestSchema.parse({ script: "dev", url })).toEqual({
      script: "dev",
      url,
    });
  });

  it.each([
    "https://127.0.0.1:5173/",
    "http://example.com:5173/",
    "http://127.0.0.1/",
    "http://127.0.0.1:18080/",
    "http://127.0.0.1:80/",
    "http://user:password@127.0.0.1:5173/",
    "http://127.0.0.1:5173/?token=value",
    "http://127.0.0.1:5173/#fragment",
    "http://127.0.0.1:5173/%252fexternal",
  ])("refuses external or unsafe preview targets: %s", (url) => {
    expect(OpenAppPreviewRequestSchema.safeParse({ url }).success).toBe(false);
  });

  it("keeps the relay port separate from generated app configuration", () => {
    expect(
      AppPreviewConfigurationSchema.safeParse({ port: 18_080 }).success
    ).toBe(false);
    expect(
      AppPreviewConfigurationSchema.parse({ host: "::1", port: 3000 })
    ).toEqual({ host: "::1", port: 3000 });
    expect(
      AppPreviewConfigurationSchema.safeParse({ script: "dev; echo unsafe" })
        .success
    ).toBe(false);
  });
});
