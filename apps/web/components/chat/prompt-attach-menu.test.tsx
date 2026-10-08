import type { ProjectSummary } from "@reasonateai/contracts/auth";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PromptInput } from "@/components/ai-elements/prompt-input";
import {
  PromptAttachMenu,
  type PromptAttachMenuProps,
} from "./prompt-attach-menu";

vi.mock("radix-ui", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const actualDropdown = actual.DropdownMenu as Record<string, unknown>;
  const actualDialog = actual.Dialog as Record<string, unknown>;
  return {
    ...actual,
    Dialog: {
      ...actualDialog,
      Portal: ({ children }: { children: React.ReactNode }) => children,
    },
    DropdownMenu: {
      ...actualDropdown,
      Portal: ({ children }: { children: React.ReactNode }) => children,
    },
  };
});

const defaultProps: PromptAttachMenuProps = {
  busy: false,
  filesAvailable: true,
  onAddUrl: vi.fn(),
  onErrorClear: vi.fn(),
  onOpenFiles: vi.fn(),
  onProjectSelect: vi.fn(),
  projectId: "p-1",
  projectPickerDisabled: false,
  projects: [
    {
      name: "Reasonate Web",
      organizationId: "org-1" as unknown as ProjectSummary["organizationId"],
      projectId: "p-1" as unknown as ProjectSummary["projectId"],
    },
  ],
};

function renderMenu(overrides: Partial<PromptAttachMenuProps> = {}) {
  return renderToStaticMarkup(
    <PromptInput onSubmit={vi.fn()}>
      <PromptAttachMenu {...defaultProps} {...overrides} />
    </PromptInput>
  );
}

describe("PromptAttachMenu component", () => {
  it("renders trigger button with accessibility attributes", () => {
    const html = renderMenu();

    expect(html).toContain('aria-label="Add to message"');
    expect(html).toContain('aria-haspopup="menu"');
  });

  it("disables the trigger button when busy is true", () => {
    const html = renderMenu({ busy: true });

    expect(html).toContain('aria-label="Add to message"');
    expect(html).toContain("disabled");
  });

  it("renders attachment options in dropdown content when opened", () => {
    const html = renderMenu({ defaultOpen: true });

    expect(html).toContain("Add Files");
    expect(html).toContain("Mention a file");
    expect(html).toContain("Add URL");
    expect(html).toContain("Sketch");
    expect(html).toContain("Connectors");
    expect(html).toContain("Tools");
    expect(html).toContain("Work in a project");
    expect(html).toContain("Reasonate Web");
  });

  it("omits Mention a file when filesAvailable is false", () => {
    const html = renderMenu({ defaultOpen: true, filesAvailable: false });

    expect(html).not.toContain("Mention a file");
    expect(html).toContain("Add Files");
    expect(html).toContain("Add URL");
    expect(html).toContain("Sketch");
    expect(html).toContain("Connectors");
    expect(html).toContain("Tools");
  });
});
