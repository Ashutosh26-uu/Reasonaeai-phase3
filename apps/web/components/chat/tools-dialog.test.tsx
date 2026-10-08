import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CTO_RUNTIME_TOOLS, ToolsDialog } from "./tools-dialog";

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

describe("CTO_RUNTIME_TOOLS", () => {
  it("matches the canonical tools in @reasonateai/cto-runtime", () => {
    const runtimeToolNames = CTO_RUNTIME_TOOLS.map((t) => t.runtimeToolName);

    expect(runtimeToolNames).toContain("execute_command");
    expect(runtimeToolNames).toContain("read_file");
    expect(runtimeToolNames).toContain("edit_file");
    expect(runtimeToolNames).toContain("write_file");
    expect(runtimeToolNames).toContain("list_files");
    expect(runtimeToolNames).toContain("grep");
    expect(runtimeToolNames).toContain("browser_verify");
    expect(runtimeToolNames).toContain("test_execution");

    for (const tool of CTO_RUNTIME_TOOLS) {
      expect(tool.name.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(15);
      expect(tool.defaultEnabled).toBe(true);
      expect(["execution", "filesystem", "search", "verification"]).toContain(
        tool.category
      );
    }
  });
});

describe("ToolsDialog component", () => {
  it("renders runtime tools with accessible switches and metadata when open", () => {
    const html = renderToStaticMarkup(
      <ToolsDialog
        onOpenChange={vi.fn()}
        onReturnFocus={vi.fn()}
        onToggleTool={vi.fn()}
        open={true}
      />
    );

    expect(html).toContain("CTO Runtime Tools");
    expect(html).toContain("@reasonateai/cto-runtime");
    expect(html).toContain('aria-label="Search tools"');
    expect(html).toContain("Reset Defaults");
    expect(html).toContain("Enable All");
    expect(html).toContain("8 of 8 Active");

    // All tools rendered
    expect(html).toContain("Terminal Execution");
    expect(html).toContain("Read Files");
    expect(html).toContain("Code Editor");
    expect(html).toContain("Write Files");
    expect(html).toContain("Directory Discovery");
    expect(html).toContain("Codebase Search");
    expect(html).toContain("Browser Verification");
    expect(html).toContain("Test Runner &amp; Repair");

    // Accessible switches
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-label="Toggle Terminal Execution"');
  });

  it("correctly reflects custom selectedTools set", () => {
    const customSelected = ["execute_command", "read_file"];
    const html = renderToStaticMarkup(
      <ToolsDialog
        onOpenChange={vi.fn()}
        open={true}
        selectedTools={customSelected}
      />
    );

    expect(html).toContain("2 of 8 Active");
    expect(html).toContain("Active");
    expect(html).toContain("Disabled");
  });

  it("does not render when open is false", () => {
    const html = renderToStaticMarkup(
      <ToolsDialog onOpenChange={vi.fn()} open={false} />
    );

    expect(html).not.toContain("CTO Runtime Tools");
    expect(html).not.toContain("@reasonateai/cto-runtime");
  });
});
