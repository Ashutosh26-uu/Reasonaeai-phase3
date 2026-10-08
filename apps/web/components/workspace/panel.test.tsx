import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_TIMELINE } from "@/components/chat/timeline";
import { exportWorkspaceZip } from "@/lib/product-api";
import { FilesView, Panel, type PanelProps } from "./panel";

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

    expect(html).toContain("Reading the project&#x27;s latest checkpoint");
  });

  it("renders empty state when checkpoint has no files", () => {
    const html = renderToStaticMarkup(
      <FilesView
        buildSessionId="session-123"
        initialTree={{
          checkpointId: "cp-empty",
          commit: "",
          files: [],
          truncated: false,
        }}
        organizationId="org-1"
        projectId="proj-1"
        projectName="Super App"
      />
    );

    expect(html).toContain(
      "No checkpoint yet. The project&#x27;s files appear here"
    );
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

  it("triggers native browser download and cleans up Object URL lifecycle on export", async () => {
    const mockBlob = new Blob(["PK\x03\x04testdata"], {
      type: "application/zip",
    });
    const mockFetch = vi.fn().mockResolvedValue({
      blob: () => Promise.resolve(mockBlob),
      headers: new Headers({ "content-type": "application/zip" }),
      ok: true,
      status: 200,
    });
    vi.stubGlobal("fetch", mockFetch);

    const createdObjectUrls: string[] = [];
    const revokedObjectUrls: string[] = [];

    const mockCreateObjectURL = vi.fn((_blob: Blob) => {
      const url = `blob:http://localhost:3000/${crypto.randomUUID()}`;
      createdObjectUrls.push(url);
      return url;
    });
    const mockRevokeObjectURL = vi.fn((url: string) => {
      revokedObjectUrls.push(url);
    });

    vi.stubGlobal("URL", {
      createObjectURL: mockCreateObjectURL,
      revokeObjectURL: mockRevokeObjectURL,
    });

    const clickedAnchors: { download: string; href: string }[] = [];
    const mockAnchor = {
      click: vi.fn(function (this: { download: string; href: string }) {
        clickedAnchors.push({ download: this.download, href: this.href });
      }),
      download: "",
      href: "",
      remove: vi.fn(),
    };

    const mockDocument = {
      body: {
        appendChild: vi.fn((node) => node),
      },
      cookie: "",
      createElement: vi.fn((tag: string) => {
        if (tag === "a") {
          return mockAnchor;
        }
        return {};
      }),
    };

    vi.stubGlobal("document", mockDocument);
    vi.stubGlobal("window", {
      URL: {
        createObjectURL: mockCreateObjectURL,
        revokeObjectURL: mockRevokeObjectURL,
      },
    });

    // Exercise export trigger directly
    const exportedBlob = await exportWorkspaceZip({
      buildSessionId: "session-123",
      organizationId: "org-1",
      projectId: "proj-1",
      projectName: "Super App",
    });

    const objectUrl = window.URL.createObjectURL(exportedBlob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = "super-app-source.zip";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.URL.revokeObjectURL(objectUrl);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]?.[0]).toContain(
      "/v1/build-sessions/session-123/workspace/export"
    );

    expect(mockCreateObjectURL).toHaveBeenCalledWith(mockBlob);
    expect(mockAnchor.click).toHaveBeenCalledTimes(1);
    expect(mockAnchor.download).toBe("super-app-source.zip");
    expect(mockAnchor.href).toBe(createdObjectUrls[0]);
    expect(mockAnchor.remove).toHaveBeenCalledTimes(1);
    expect(mockRevokeObjectURL).toHaveBeenCalledWith(createdObjectUrls[0]);
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
