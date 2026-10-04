import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FileContentPreview, FileSource } from "./file-content";
import {
  fileLanguage,
  highlightFile,
  highlightMatchesSource,
  sourceLines,
} from "./file-highlight";

describe("workspace file preview", () => {
  it.each([
    ["src/App.tsx", "tsx"],
    ["package.json", "json"],
    ["theme.css", "css"],
    ["README.md", "markdown"],
    ["Dockerfile", "docker"],
    ["Dockerfile.preview", "docker"],
    [".env.local", "dotenv"],
    ["scripts/build.sh", "shellscript"],
    ["LICENSE", null],
    ["data.unknown", null],
  ])("detects %s as %s", (path, expected) => {
    expect(fileLanguage(path)).toBe(expected);
  });

  it("highlights real TypeScript tokens and preserves source and trailing lines", async () => {
    const text = "const answer = 42;\nconsole.log(answer);\n";
    const result = await highlightFile(text, "typescript");
    expect(highlightMatchesSource(result, text)).toBe(true);
    const html = renderToStaticMarkup(
      <FileSource result={result} text={text} />
    );
    expect(html).toContain('data-line="3"');
    expect(html).toContain("--shiki-dark");
    expect(html).toContain(">const</span>");
    expect(
      result.tokens[0]?.find((token) => token.content === "const")?.htmlStyle
    ).not.toEqual(
      result.tokens[0]?.find((token) => token.content === "answer")?.htmlStyle
    );
  });

  it("escapes HTML and script source instead of executing a preview", async () => {
    const text =
      '<script>alert("example")</script>\n<img src="x" onerror="alert(1)">';
    const result = await highlightFile(text, "html");
    const html = renderToStaticMarkup(
      <FileSource result={result} text={text} />
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('<img src="x"');
    expect(html).toContain("&lt;");
    expect(highlightMatchesSource(result, text)).toBe(true);
  });

  it("displays unknown and empty files readably with accessible source controls", () => {
    const text = "first <literal>\r\nsecond\r\n";
    const html = renderToStaticMarkup(
      <FileContentPreview path="data.unknown" text={text} />
    );
    expect(html).toContain("Plain text");
    expect(html).toContain("3 lines");
    expect(html).toContain("first &lt;literal&gt;");
    expect(html).toContain('aria-label="Copy file source"');
    expect(html).toContain('aria-label="Wrap source lines"');
    const empty = renderToStaticMarkup(
      <FileContentPreview path="empty.txt" text="" />
    );
    expect(empty).toContain("1 line");
    expect(sourceLines(text).map((line) => line.content)).toEqual([
      "first <literal>",
      "second",
      "",
    ]);
  });

  it("rejects a cache collision rather than displaying a different file's content", async () => {
    const prefix = `// ${"a".repeat(120)}\n`;
    const suffix = `\n// ${"z".repeat(120)}`;
    const original = `${prefix}const middle = 1;${suffix}`;
    const changed = `${prefix}const middle = 2;${suffix}`;
    const first = await highlightFile(original, "typescript");
    expect(highlightMatchesSource(first, changed)).toBe(false);
    await expect(highlightFile(changed, "typescript")).rejects.toThrow(
      "did not match this file"
    );
    const fallback = renderToStaticMarkup(
      <FileSource result={null} text={changed} wrap />
    );
    expect(fallback).toContain("const middle = 2;");
    expect(fallback).toContain("data-wrap");
  });
});
