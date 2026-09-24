import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageResponse } from "./message";

describe("MessageResponse", () => {
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
