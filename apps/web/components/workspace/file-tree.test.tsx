import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildFileTree, FileTree } from "./file-tree";

const ignoreOpen = () => undefined;

describe("workspace source tree", () => {
  const entries = [
    { bytes: 12, kind: "file" as const, path: "src/components/Button.tsx" },
    { bytes: 8, kind: "file" as const, path: "README.md" },
    { bytes: 5, kind: "file" as const, path: "src/app.ts" },
    { bytes: 0, kind: "directory" as const, path: "src" },
  ];
  it("groups nested files under synthesized parents and sorts folders first", () => {
    const tree = buildFileTree(entries);
    expect(tree.map((node) => node.name)).toEqual(["src", "README.md"]);
    expect(tree[0]?.children.map((node) => node.name)).toEqual([
      "components",
      "app.ts",
    ]);
    expect(tree[0]?.children[0]?.children[0]?.path).toBe(
      "src/components/Button.tsx"
    );
  });
  it("renders expandable folders with file selection and accessible groups", () => {
    const html = renderToStaticMarkup(
      <FileTree entries={entries} onOpen={ignoreOpen} selected="src/app.ts" />
    );
    expect(html).toContain('role="tree"');
    expect(html).toContain("<fieldset");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('data-path="src/app.ts"');
    expect(html).toContain('aria-expanded="false"');
  });
});
