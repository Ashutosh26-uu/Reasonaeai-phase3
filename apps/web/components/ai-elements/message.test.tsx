import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageResponse } from "./message";

describe("MessageResponse", () => {
  it("keeps one copy action and a language title outside the source", () => {
    const html = renderToStaticMarkup(
      <MessageResponse>
        {"```typescript\nconst answer = 42;\n```"}
      </MessageResponse>
    );
    expect(html).toContain('data-streamdown="code-block-header"');
    expect(html).toContain("typescript");
    expect(html.split('data-streamdown="code-block-copy-button"')).toHaveLength(
      2
    );
    expect(html).not.toContain('data-streamdown="code-block-download-button"');
    expect(html).toContain("const answer = 42;");
  });

  it("retains safe text for unknown languages and removes active HTML", () => {
    const html = renderToStaticMarkup(
      <MessageResponse>
        {
          '```unknown\nsafe text\n```\n\n<script>alert(\'unsafe\')</script>\n<img src="https://example.com/tracker" onerror="alert(1)" />'
        }
      </MessageResponse>
    );
    expect(html).toContain("safe text");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("renders inline and display equations with KaTeX", () => {
    const html = renderToStaticMarkup(
      <MessageResponse>
        {"Inline $$E = mc^2$$.\n\n$$\n\\frac{1}{2}\n$$"}
      </MessageResponse>
    );

    expect(html).toContain('class="katex"');
    expect(html).toContain('class="katex-display"');
    expect(html).toContain("MathML");
  });
});
