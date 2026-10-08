import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ConnectorsDialog, WORKSPACE_CONNECTORS } from "./connectors-dialog";

vi.mock("radix-ui", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const actualDialog = actual.Dialog as Record<string, unknown>;
  return {
    ...actual,
    Dialog: {
      ...actualDialog,
      Portal: ({ children }: { children: React.ReactNode }) => children,
    },
  };
});

describe("WORKSPACE_CONNECTORS", () => {
  it("includes all core enterprise integrations with required metadata", () => {
    const ids = WORKSPACE_CONNECTORS.map((c) => c.id);
    expect(ids).toContain("github");
    expect(ids).toContain("jira");
    expect(ids).toContain("linear");
    expect(ids).toContain("figma");
    expect(ids).toContain("notion");
    expect(ids).toContain("slack");
    expect(ids).toContain("gdrive");

    for (const connector of WORKSPACE_CONNECTORS) {
      expect(connector.name.length).toBeGreaterThan(0);
      expect(connector.description.length).toBeGreaterThan(10);
      expect(connector.permissions.length).toBeGreaterThan(0);
      expect(connector.statusLabel).toBe("Coming Soon");
      expect(connector.author.length).toBeGreaterThan(0);
      expect(connector.useCase.length).toBeGreaterThan(0);
    }
  });
});

describe("ConnectorsDialog component", () => {
  it("renders connector directory cards when open", () => {
    const html = renderToStaticMarkup(
      <ConnectorsDialog onOpenChange={vi.fn()} open={true} />
    );

    expect(html).toContain("Workspace Connectors");
    expect(html).toContain("Integrations Directory");
    expect(html).toContain('aria-label="Search connectors"');
    expect(html).toContain("Request Integration");

    // Connectors displayed
    expect(html).toContain("GitHub");
    expect(html).toContain("Jira");
    expect(html).toContain("Linear");
    expect(html).toContain("Figma");
    expect(html).toContain("Notion");
    expect(html).toContain("Slack");
    expect(html).toContain("Google Drive");

    // Coming soon badge on all cards
    expect(html).toContain("Coming Soon");
    expect(html).toContain("Details");
  });

  it("does not render when open is false", () => {
    const html = renderToStaticMarkup(
      <ConnectorsDialog onOpenChange={vi.fn()} open={false} />
    );

    expect(html).not.toContain("Workspace Connectors");
    expect(html).not.toContain("Integrations Directory");
  });
});
