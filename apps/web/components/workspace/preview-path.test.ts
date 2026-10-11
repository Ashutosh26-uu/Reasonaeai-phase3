import { describe, expect, it } from "vitest";
import {
  formatSandboxPreviewAddress,
  movePreviewHistory,
  observedPreviewPath,
  parsePreviewPath,
  parseSandboxPreviewAddress,
  previewRoot,
  previewTransportUrl,
  recordPreviewPath,
  workspaceFilePath,
} from "./preview-path";

const origin = "https://app.example";
const root = `${origin}/v1/previews/preview-one/`;

describe("preview project paths", () => {
  it("shows the sandbox URL and routes only its selected localhost port", () => {
    expect(formatSandboxPreviewAddress(4173, "/tasks")).toBe(
      "http://localhost:4173/tasks"
    );
    expect(
      parseSandboxPreviewAddress(
        "http://localhost:4173/tasks?filter=open",
        4173
      )
    ).toBe("/tasks?filter=open");
    expect(parseSandboxPreviewAddress("http://127.0.0.1:4173/", 4173)).toBe(
      "/"
    );
    expect(
      parseSandboxPreviewAddress("http://localhost:3000/", 4173)
    ).toBeNull();
    expect(
      parseSandboxPreviewAddress("http://example.com:4173/", 4173)
    ).toBeNull();
  });

  it("displays project routes while preserving the authenticated proxy transport", () => {
    expect(
      previewRoot("/v1/previews/preview-one/", "preview-one", origin)
    ).toBe(root);
    expect(observedPreviewPath(root, root)).toBe("/");
    expect(parsePreviewPath("settings?tab=profile#name")).toBe(
      "/settings?tab=profile#name"
    );
    const url = previewTransportUrl(root, "/settings?tab=profile#name");
    expect(url).toBe(`${root}settings?tab=profile#name`);
    expect(observedPreviewPath(root, url ?? "")).toBe(
      "/settings?tab=profile#name"
    );
    expect(previewTransportUrl(root, "/?next=https://other.example")).toBe(
      `${root}?next=https://other.example`
    );
  });

  it.each([
    "https://other.example/",
    "javascript:alert(1)",
    "file:///workspace/app.tsx",
    "//other.example/",
    "/\\other.example/",
    "/../status",
    "../status",
    "/a/./b",
    "/%2e%2e/status",
    "/%252e%252e/status",
    "/%25252e%25252e/status",
    "/%2f%2fother.example/",
    "/%5cother.example/",
    "/a%00b",
    "/a\nb",
    "/bad%encoding",
    "",
    `/${"x".repeat(2048)}`,
  ])("rejects unsafe navigation %s", (path) => {
    expect(parsePreviewPath(path)).toBeNull();
    expect(previewTransportUrl(root, path)).toBeNull();
  });

  it("rejects server roots outside the assigned proxy and unsafe protocols", () => {
    for (const url of [
      "/v1/previews/other/",
      "/v1/previews/preview-one/status",
      "/v1/previews/preview-one/?token=secret",
      "//other.example/v1/previews/preview-one/",
      "/\\other.example/v1/previews/preview-one/",
      "file:///v1/previews/preview-one/",
      "https://user:password@app.example/v1/previews/preview-one/",
    ]) {
      expect(previewRoot(url, "preview-one", origin)).toBeNull();
    }
  });

  it("accepts only observed locations within the exact assigned preview root", () => {
    for (const url of [
      "https://other.example/v1/previews/preview-one/settings",
      `${origin}/v1/previews/preview-two/settings`,
      `${origin}/v1/previews/preview-one-extra/settings`,
      `${origin}/v1/auth/session`,
      `${root}%252e%252e/status`,
      "about:blank",
    ]) {
      expect(observedPreviewPath(root, url)).toBeNull();
    }
  });

  it("preserves encoded route names and presents real checkpoint paths", () => {
    expect(previewTransportUrl(root, "/caf%C3%A9")).toBe(`${root}caf%C3%A9`);
    expect(workspaceFilePath("src/app.tsx")).toBe("/workspace/src/app.tsx");
    expect(workspaceFilePath("/workspace/src/app.tsx")).toBe(
      "/workspace/src/app.tsx"
    );
  });
});

it("recognizes the same preview root after ingress strips a trailing slash", () => {
  const fixtureRoot = "http://localhost:3219/v1/previews/fixture/";
  expect(
    observedPreviewPath(
      fixtureRoot,
      "http://localhost:3219/v1/previews/fixture"
    )
  ).toBe("/");
  expect(
    observedPreviewPath(
      fixtureRoot,
      "http://localhost:3219/v1/previews/fixture-other"
    )
  ).toBeNull();
});

describe("bounded preview history", () => {
  it("supports back and forward and drops forward entries after a new navigation", () => {
    let history = { index: 0, paths: ["/"] };
    history = recordPreviewPath(history, "/settings");
    history = recordPreviewPath(history, "/account");
    expect(recordPreviewPath(history, "/account")).toBe(history);
    history = movePreviewHistory(history, -1);
    expect(history.paths[history.index]).toBe("/settings");
    expect(movePreviewHistory(history, 1).paths[2]).toBe("/account");
    history = recordPreviewPath(history, "/help");
    expect(history.paths).toEqual(["/", "/settings", "/help"]);
    expect(movePreviewHistory(history, 1)).toBe(history);
  });

  it("bounds retained history and refuses invalid entries", () => {
    let history = { index: 0, paths: ["/"] };
    expect(movePreviewHistory(history, -1)).toBe(history);
    expect(recordPreviewPath(history, "//other.example")).toBe(history);
    for (let index = 0; index < 120; index += 1) {
      history = recordPreviewPath(history, `/page/${index}`);
    }
    expect(history.paths).toHaveLength(100);
    expect(history.paths[0]).toBe("/page/20");
    expect(history.paths[history.index]).toBe("/page/119");
  });
});
