import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createRunResources } from "../src/resources/handlers/index.js";
import type { ResolveContext } from "../src/resources/types.js";
import { ResourceError } from "../src/resources/types.js";
import type { RunScope } from "../src/run-scope.js";
import {
  formatDirectoryListing,
  normalizePathArgument,
  readTarget,
  renderLines,
  resolveReadPath,
  splitLines,
} from "../src/tools/read.js";

const scope: RunScope = {
  buildSessionId: "bs_1",
  organizationId: "org_1",
  projectId: "proj_1",
  runId: "run_1",
} as RunScope;

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "reasonate-read-"));
  await Promise.all(
    Object.entries(files).map(async ([relative, content]) => {
      const target = join(root, relative);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, content);
    })
  );
  return root;
}

async function harness(
  cwd: string,
  spill?: (text: string, ext: string) => Promise<number>
) {
  const root = await mkdtemp(join(tmpdir(), "reasonate-store-"));
  const { router, artifacts } = createRunResources({ cwd, root, scope });
  const context: ResolveContext = { cwd, scope };

  return {
    artifacts,
    context,
    read: (
      target: string,
      options: { maxInlineBytes?: number; maxInlineLines?: number } = {}
    ) =>
      readTarget(target, context, router, {
        spill: spill ?? ((text, ext) => artifacts.write(text, ext)),
        ...options,
      }),
    router,
  };
}

describe("path argument normalisation", () => {
  it("strips the noise a model wraps a path in", () => {
    expect(normalizePathArgument('  "@src/app.ts"  ')).toBe("src/app.ts");
    expect(normalizePathArgument("file:///tmp/x.ts")).toBe("tmp/x.ts");
  });

  it("normalises non-breaking and escaped spaces so the file is found", () => {
    expect(normalizePathArgument("my\u00A0file.ts")).toBe("my file.ts");
    expect(normalizePathArgument("my\\ file.ts")).toBe("my file.ts");
  });

  it("resolves relative input against the working directory", () => {
    const cwd = process.cwd();
    expect(resolveReadPath("src/app.ts", cwd)).toBe(join(cwd, "src", "app.ts"));
  });
});

describe("line rendering", () => {
  const lines = ["a", "b", "c", "d", "e"];

  it("numbers lines with the file's real numbering, not the excerpt's", () => {
    const { text } = renderLines(
      lines,
      [{ endLine: 4, startLine: 3 }],
      lines.length
    );
    expect(text).toContain("   3| c");
    expect(text).toContain("   4| d");
  });

  it("marks the gap between disjoint ranges instead of implying continuity", () => {
    const { text } = renderLines(
      lines,
      [
        { endLine: 1, startLine: 1 },
        { endLine: 5, startLine: 5 },
      ],
      lines.length
    );
    expect(text).toContain("---- omitted lines 2-4 ----");
  });

  it("renders the whole file when no range is given", () => {
    const { text } = renderLines(lines, undefined, lines.length);
    expect(text.split("\n")).toHaveLength(5);
  });

  it("widens the gutter for a large file so numbers stay aligned", () => {
    const wide = renderLines(["x"], [{ endLine: 1, startLine: 1 }], 12_345);
    expect(wide.text.startsWith("    1| ")).toBe(true);
  });

  it("ignores a trailing newline rather than reporting a phantom last line", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
  });
});

describe("directory listing", () => {
  it("caps child directories and states the real remainder", () => {
    const entries = [
      ...Array.from({ length: 14 }, (_, index) => ({
        isDirectory: true,
        name: `dir${index}`,
      })),
      { isDirectory: false, name: "file.ts" },
    ];
    const listing = formatDirectoryListing(entries);

    expect(listing).toContain("… 2 more directories");
    expect(listing).toContain("file.ts");
    // The cap must not hide the fact that entries were withheld.
    expect(listing).not.toContain("dir13/");
  });

  it("says so when a directory is empty rather than returning nothing", () => {
    expect(formatDirectoryListing([])).toBe("(empty directory)");
  });
});

describe("reading files", () => {
  it("reads a file with a gutter", async () => {
    const cwd = await workspace({
      "src/app.ts": "const a = 1;\nconst b = 2;\n",
    });
    const { read } = await harness(cwd);

    const result = await read("src/app.ts");
    expect(result.kind).toBe("file");
    expect(result.text).toContain("const a = 1;");
  });

  it("honours a line range and reports which lines it showed", async () => {
    const cwd = await workspace({ "big.ts": "1\n2\n3\n4\n5\n6\n7\n8\n" });
    const { read } = await harness(cwd);

    const result = await read("big.ts:3-5");
    expect(result.kind).toBe("range");
    expect(result.shownRanges).toEqual([{ endLine: 5, startLine: 3 }]);
    expect(result.text).toContain("3| 3");
    expect(result.text).not.toContain("6| 6");
  });

  it("returns raw bytes when asked, without a gutter", async () => {
    const cwd = await workspace({ "data.txt": "a\nb\n" });
    const { read } = await harness(cwd);

    const result = await read("data.txt:raw");
    expect(result.text).toBe("a\nb\n");
  });

  it("reports conflict markers rather than dumping the whole file", async () => {
    const cwd = await workspace({
      "merged.ts": "ok\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> other\n",
    });
    const { read } = await harness(cwd);

    const result = await read("merged.ts:conflicts");
    expect(result.text).toContain("conflict marker line(s)");
    expect(result.text).toContain("<<<<<<< HEAD");
  });

  it("says a file has no conflicts when it has none", async () => {
    const cwd = await workspace({ "clean.ts": "const a = 1;\n" });
    const { read } = await harness(cwd);

    expect((await read("clean.ts:conflicts")).text).toContain(
      "No unresolved merge conflicts"
    );
  });

  it("fails with an actionable message for a missing file", async () => {
    const cwd = await workspace({ "present.ts": "x\n" });
    const { read } = await harness(cwd);

    await expect(read("absent.ts")).rejects.toThrow(ResourceError);
    await expect(read("absent.ts")).rejects.toThrow("Cannot read absent.ts");
  });

  it("lists a directory instead of failing when asked for one", async () => {
    const cwd = await workspace({ "pkg/a.ts": "x\n", "pkg/b.ts": "y\n" });
    const { read } = await harness(cwd);

    const result = await read("pkg");
    expect(result.kind).toBe("directory");
    expect(result.text).toContain("a.ts");
  });

  it("refuses a selector on a directory rather than guessing which file it meant", async () => {
    const cwd = await workspace({ "pkg/a.ts": "x\n" });
    const { read } = await harness(cwd);

    await expect(read("pkg:1-2")).rejects.toThrow(
      "A selector cannot be applied to a directory"
    );
  });
});

describe("tail selectors", () => {
  it("reads the last N lines from an explicit count", async () => {
    const cwd = await workspace({ "log.txt": "1\n2\n3\n4\n5\n" });
    const { read } = await harness(cwd);

    const result = await read("log.txt:-2");
    // Resolved against the real length, so it must not return the head.
    expect(result.shownRanges).toEqual([{ endLine: 5, startLine: 4 }]);
    expect(result.text).toContain("5| 5");
    expect(result.text).not.toContain("1| 1");
  });

  it("treats a tail larger than the file as the whole file", async () => {
    const cwd = await workspace({ "small.txt": "1\n2\n" });
    const { read } = await harness(cwd);

    expect((await read("small.txt:-99")).shownRanges).toEqual([
      { endLine: 2, startLine: 1 },
    ]);
  });
});

describe("path spelling", () => {
  it("resolves a trailing slash to the same target as without one", async () => {
    const cwd = await workspace({ "pkg/a.ts": "x\n" });
    const { read } = await harness(cwd);

    expect((await read("pkg/")).text).toBe((await read("pkg")).text);
  });
});

describe("nested listing", () => {
  it("expands the first levels so the layout is visible without a second read", async () => {
    const cwd = await workspace({
      "src/app/main.ts": "x\n",
      "src/lib/util.ts": "y\n",
    });
    const { read } = await harness(cwd);

    const result = await read("src");
    expect(result.text).toContain("app/");
    expect(result.text).toContain("main.ts");
  });
});

describe("truncation", () => {
  it("announces a line elision instead of silently dropping the tail", async () => {
    const cwd = await workspace({ "long.txt": "line\n".repeat(50) });
    const { read } = await harness(cwd);

    const result = await read("long.txt", { maxInlineLines: 10 });
    expect(result.truncation?.reason).toBe("lines");
    expect(result.truncation?.omittedLines).toBe(40);
    expect(result.text).toContain("40 more lines");
  });

  it("spills oversized output and hands back the handle that recovers it", async () => {
    const cwd = await workspace({ "huge.txt": "x".repeat(500) });
    const { read, artifacts } = await harness(cwd);

    const result = await read("huge.txt", { maxInlineBytes: 200 });
    expect(result.truncation?.reason).toBe("bytes");

    const handle = result.truncation?.artifactUrl;
    expect(handle).toBeDefined();
    expect(result.text).toContain(handle as string);

    // The whole point of spilling: the full text is still reachable.
    const id = Number.parseInt(
      (handle as string).replace("artifact://", ""),
      10
    );
    expect((await artifacts.read(id))?.content).toBe("x".repeat(500));
  });

  it("keeps the output reachable by naming a narrower range when spilling is off", async () => {
    const cwd = await workspace({ "huge.txt": "y".repeat(500) });
    const root = await mkdtemp(join(tmpdir(), "reasonate-store-"));
    const { router } = createRunResources({ cwd, root, scope });
    const context: ResolveContext = { cwd, scope };

    const result = await readTarget("huge.txt", context, router, {
      maxInlineBytes: 200,
    });
    expect(result.truncation?.artifactUrl).toBeUndefined();
    expect(result.text).toContain("Read a narrower line range");
  });
});

describe("reading through the resource layer", () => {
  it("dispatches a resource url instead of treating it as a path", async () => {
    const cwd = await workspace({ "a.ts": "x\n" });
    const { read, artifacts } = await harness(cwd);
    await artifacts.write("spilled content");

    const result = await read("artifact://0");
    expect(result.kind).toBe("resource");
    expect(result.text).toContain("spilled content");
  });

  it("rejects an empty target", async () => {
    const cwd = await workspace({});
    const { read } = await harness(cwd);

    await expect(read("   ")).rejects.toThrow("A read target is required");
  });
});
