import { describe, expect, it } from "vitest";
import { resolveWorkspacePath } from "../src/tools/workspace-path.js";

describe("sandbox path resolution", () => {
  it.each([
    "src/app.ts",
    "/workspace/src/app.ts",
    "src\\app.ts",
    "C:\\workspace\\src\\app.ts",
    "@/src/app.ts",
    "file:///workspace/src/app.ts",
    "file://localhost/workspace/src/app.ts",
    "file:///C:/workspace/src/app.ts",
  ])("resolves %s to the same sandbox file", (path) => {
    const resolved = resolveWorkspacePath(path, "/workspace");
    expect(resolved).toBe("/workspace/src/app.ts");
    expect(resolveWorkspacePath(resolved, "/workspace")).toBe(resolved);
  });

  it("accepts an explicit workspace root shortcut", () => {
    expect(resolveWorkspacePath("@/", "/workspace")).toBe("/workspace");
  });

  it.each(["@scope/app.ts", "@@scope/app.ts", " leading /app.ts"])(
    "preserves the filename in %s",
    (path) => {
      expect(resolveWorkspacePath(path, "/workspace")).toBe(
        `/workspace/${path}`
      );
    }
  );

  it.each([
    "/src/app.ts",
    "C:\\src\\app.ts",
    "file:///src/app.ts",
    "../secret",
    "/workspace/../secret",
    "file:///workspace/%2e%2e/secret",
    "/workspace-neighbor/app.ts",
  ])("rejects %s rather than rebasing it", (path) => {
    expect(() => resolveWorkspacePath(path, "/workspace")).toThrow(
      "escapes the verified workspace"
    );
  });

  it.each([
    "",
    "bad\0name",
    "~/app.ts",
    "C:app.ts",
    "\\\\server\\share\\app.ts",
    "file://server/workspace/app.ts",
    "file:///workspace/%ZZ",
    "https://example.com/app.ts",
  ])("rejects an unsupported path %s", (path) => {
    expect(() => resolveWorkspacePath(path, "/workspace")).toThrow();
  });
});
