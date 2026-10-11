import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_TIMELINE } from "@/components/chat/timeline";
import { exportWorkspaceZip } from "@/lib/product-api";
import {
  FilesView,
  Panel,
  type PanelProps,
  sanitizeDownloadFilename,
  triggerBlobDownload,
} from "./panel";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const defaultPanelProps: PanelProps = {
  buildSessionId: "session-123",
  messages: [],
  newTabRequest: 0,
  onClose: vi.fn(),
  onNewTabHandled: vi.fn(),
  organizationId: "org-1",
  projectId: "proj-1",
  projectName: "Super App",
  requestedView: "new",
  timeline: EMPTY_TIMELINE,
};

describe("sanitizeDownloadFilename helper", () => {
  it("sanitizes names, converts to lowercase, replaces symbols with dashes", () => {
    expect(sanitizeDownloadFilename("Super App 2026!")).toBe(
      "super-app-2026-source.zip"
    );
  });

  it("neutralizes path traversal attempts and special characters", () => {
    expect(sanitizeDownloadFilename("../../../etc/passwd")).toBe(
      "etc-passwd-source.zip"
    );
    expect(sanitizeDownloadFilename("..\\..\\windows\\system32")).toBe(
      "windows-system32-source.zip"
    );
  });

  it("falls back to project-source.zip for undefined, empty, or whitespace strings", () => {
    expect(sanitizeDownloadFilename(undefined)).toBe("project-source.zip");
    expect(sanitizeDownloadFilename("")).toBe("project-source.zip");
    expect(sanitizeDownloadFilename("   ---   ")).toBe("project-source.zip");
  });
});

describe("triggerBlobDownload helper", () => {
  it("creates object URL, appends anchor, triggers click, and cleans up URL", () => {
    vi.useFakeTimers();

    const mockBlob = new Blob(["test-data"], { type: "application/zip" });
    const mockUrl = "blob:http://localhost:3000/mock-uuid";

    const mockCreateObjectURL = vi.fn().mockReturnValue(mockUrl);
    const mockRevokeObjectURL = vi.fn();

    vi.stubGlobal("window", {
      URL: {
        createObjectURL: mockCreateObjectURL,
        revokeObjectURL: mockRevokeObjectURL,
      },
    });

    const clicked: string[] = [];
    const mockAnchor = {
      click: vi.fn(function (this: { download: string }) {
        clicked.push(this.download);
      }),
      download: "",
      href: "",
      remove: vi.fn(),
    };

    const appendedNodes: unknown[] = [];
    vi.stubGlobal("document", {
      body: {
        appendChild: vi.fn((node) => {
          appendedNodes.push(node);
          return node;
        }),
      },
      createElement: vi.fn((tag: string) => {
        if (tag === "a") {
          return mockAnchor;
        }
        return {};
      }),
    });

    triggerBlobDownload(mockBlob, "my-app-source.zip");

    expect(mockCreateObjectURL).toHaveBeenCalledWith(mockBlob);
    expect(mockAnchor.href).toBe(mockUrl);
    expect(mockAnchor.download).toBe("my-app-source.zip");
    expect(mockAnchor.click).toHaveBeenCalledTimes(1);
    expect(mockAnchor.remove).toHaveBeenCalledTimes(1);
    expect(appendedNodes).toContain(mockAnchor);

    // Revocation happens after timeout
    expect(mockRevokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(mockRevokeObjectURL).toHaveBeenCalledWith(mockUrl);

    vi.useRealTimers();
  });
});

describe("FilesView component", () => {
  it("renders loading state when tree has not yet settled", () => {
    const html = renderToStaticMarkup(
      <FilesView
        buildSessionId="session-123"
        organizationId="org-1"
        projectId="proj-1"
        projectName="Super App"
      />
    );

    expect(html).toContain("project&#x27;s workspace");
  });

  it("renders empty state when checkpoint has no files", () => {
    const html = renderToStaticMarkup(
      <FilesView
        buildSessionId="session-123"
        initialTree={{
          checkpointId: "cp-empty",
          commit: "",
          files: [],
          source: "checkpoint",
          truncated: false,
        }}
        organizationId="org-1"
        projectId="proj-1"
        projectName="Super App"
      />
    );

    expect(html).toContain("Files appear here as the agent creates them.");
  });

  it("renders accessible 'Export ZIP' / 'Download Source' button with Download icon when files exist", () => {
    const html = renderToStaticMarkup(
      <FilesView
        buildSessionId="session-123"
        initialTree={{
          checkpointId: "cp-1",
          commit: "abcdef12345678",
          files: [
            { bytes: 120, kind: "file", path: "src/main.ts" },
            { bytes: 45, kind: "file", path: "package.json" },
          ],
          source: "checkpoint",
          truncated: false,
        }}
        organizationId="org-1"
        projectId="proj-1"
        projectName="Super App"
      />
    );

    // Chrome bar
    expect(html).toContain("/workspace");
    expect(html).toContain("src/main.ts");
    expect(html).toContain("package.json");

    // Accessible export button
    expect(html).toContain('aria-label="Export ZIP"');
    expect(html).toContain('title="Download Source"');
    expect(html).toContain("Export ZIP");

    // Download SVG icon presence
    expect(html).toContain("<svg");
  });

  it("handles exportWorkspaceZip integration and triggers file download", async () => {
    const mockBlob = new Blob(["PK\x03\x04zipdata"], {
      type: "application/zip",
    });
    const mockFetch = vi.fn().mockResolvedValue({
      blob: () => Promise.resolve(mockBlob),
      headers: new Headers({ "content-type": "application/zip" }),
      ok: true,
      status: 200,
    });
    vi.stubGlobal("fetch", mockFetch);

    const mockCreateObjectURL = vi.fn().mockReturnValue("blob:test-url");
    const mockRevokeObjectURL = vi.fn();
    vi.stubGlobal("window", {
      URL: {
        createObjectURL: mockCreateObjectURL,
        revokeObjectURL: mockRevokeObjectURL,
      },
    });

    const mockAnchor = {
      click: vi.fn(),
      download: "",
      href: "",
      remove: vi.fn(),
    };
    vi.stubGlobal("document", {
      body: { appendChild: vi.fn() },
      cookie: "",
      createElement: vi.fn(() => mockAnchor),
    });

    const blob = await exportWorkspaceZip({
      buildSessionId: "session-123",
      organizationId: "org-1",
      projectId: "proj-1",
      projectName: "Super App",
    });

    const filename = sanitizeDownloadFilename("Super App");
    triggerBlobDownload(blob, filename);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockCreateObjectURL).toHaveBeenCalledWith(mockBlob);
    expect(mockAnchor.download).toBe("super-app-source.zip");
    expect(mockAnchor.href).toBe("blob:test-url");
    expect(mockAnchor.click).toHaveBeenCalledTimes(1);
  });
});

describe("Panel component", () => {
  it("renders workspace container with tab strip and header controls", () => {
    const html = renderToStaticMarkup(<Panel {...defaultPanelProps} />);

    expect(html).toContain('aria-label="Conversation workspace"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="New workspace tab"');
    expect(html).toContain('aria-label="Close the workspace panel"');
  });
});
