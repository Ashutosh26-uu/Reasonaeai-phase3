import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { normalizeAndValidateUrl, UrlDialog } from "./url-dialog";

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

describe("normalizeAndValidateUrl", () => {
  it("rejects empty or whitespace-only inputs", () => {
    expect(normalizeAndValidateUrl("")).toEqual({
      error: "Please enter a web URL.",
      valid: false,
    });
    expect(normalizeAndValidateUrl("   \t\n  ")).toEqual({
      error: "Please enter a web URL.",
      valid: false,
    });
  });

  it("accepts valid https and http URLs", () => {
    const httpsRes = normalizeAndValidateUrl(
      "https://docs.anthropic.com/en/docs"
    );
    expect(httpsRes.valid).toBe(true);
    expect(httpsRes.url).toBe("https://docs.anthropic.com/en/docs");

    const httpRes = normalizeAndValidateUrl("http://example.com/api");
    expect(httpRes.valid).toBe(true);
    expect(httpRes.url).toBe("http://example.com/api");
  });

  it("automatically prepends https to domain names without protocol", () => {
    const result = normalizeAndValidateUrl("github.com/ReasonateAI/reasonate");
    expect(result.valid).toBe(true);
    expect(result.url).toBe("https://github.com/ReasonateAI/reasonate");
  });

  it("rejects non-http/https protocols for security", () => {
    const jsResult = normalizeAndValidateUrl("javascript:alert(1)");
    expect(jsResult.valid).toBe(false);
    expect(jsResult.error).toContain("HTTP or HTTPS");

    const fileResult = normalizeAndValidateUrl("file:///etc/passwd");
    expect(fileResult.valid).toBe(false);
    expect(fileResult.error).toContain("HTTP or HTTPS");
  });

  it("rejects inputs without a dot in the hostname", () => {
    const invalidResult = normalizeAndValidateUrl("not-a-domain");
    expect(invalidResult.valid).toBe(false);
    expect(invalidResult.error).toContain("valid web domain");
  });
});

describe("UrlDialog component", () => {
  it("renders modal structure when open", () => {
    const html = renderToStaticMarkup(
      <UrlDialog onAddUrl={vi.fn()} onOpenChange={vi.fn()} open={true} />
    );

    expect(html).toContain("Add URL Reference");
    expect(html).toContain(
      "Attach a web page, documentation link, or repository URL"
    );
    expect(html).toContain("composer-url-input");
    expect(html).toContain("composer-url-title");
    expect(html).toContain("Cancel");
    expect(html).toContain("Add to Prompt");
    expect(html).toContain('role="dialog"');
  });

  it("does not render dialog content when open is false", () => {
    const html = renderToStaticMarkup(
      <UrlDialog onAddUrl={vi.fn()} onOpenChange={vi.fn()} open={false} />
    );

    expect(html).not.toContain("Add URL Reference");
    expect(html).not.toContain("composer-url-input");
  });
});
