import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { selectorLineRanges, splitPathAndSel } from "../src/tools/selectors.js";
import type {
  SourceNode,
  StructuralSummary,
} from "../src/tools/source-summary.js";
import {
  MAX_FOOTER_SELECTORS,
  MAX_SUMMARY_LINES,
  MIN_BODY_LINES,
  MIN_SUMMARY_LINES,
  summarizeSource,
} from "../src/tools/source-summary.js";

/** A fixture on disk, and what summarising its content produced. */
interface Summarized {
  filePath: string;
  summary: StructuralSummary | undefined;
}

const SELECTOR_HINT_END_RE = /[;\]]/;

/** A failed expectation, narrowed so the rest of a test can read the summary. */
function requireSummary(
  summary: StructuralSummary | undefined
): StructuralSummary {
  if (summary === undefined) {
    throw new Error("expected a structural summary");
  }

  return summary;
}

/** Write a fixture to a temp file, read it back, and summarise it. */
async function summarize(
  name: string,
  lines: readonly string[]
): Promise<Summarized> {
  const root = await mkdtemp(join(tmpdir(), "reasonate-summary-"));
  const filePath = join(root, name);
  await writeFile(filePath, lines.join("\n"), "utf8");
  const content = await readFile(filePath, "utf8");

  return { filePath, summary: summarizeSource(content, filePath) };
}

/** Pad a fixture with declarations that hold no body. */
function fillTo(lines: string[], target: number): string[] {
  while (lines.length < target) {
    lines.push(`export const filler${lines.length + 1} = ${lines.length + 1};`);
  }

  return lines;
}

/** The selector the footer tells the caller to re-read with. */
function footerSelector(content: string, filePath: string): string | undefined {
  const marker = `with ${filePath}:`;
  const start = content.indexOf(marker);

  if (start === -1) {
    return undefined;
  }

  const rest = content.slice(start + marker.length);
  const end = rest.search(SELECTOR_HINT_END_RE);

  return end === -1 ? rest : rest.slice(0, end);
}

/** A large file: two declarations around one body long enough to collapse. */
function largeFixture(): string[] {
  return fillTo(
    [
      'import { z } from "zod";',
      "",
      "export const FIRST_CONSTANT = 1;",
      "",
      "export function big(current: number): number {",
      ...Array.from(
        { length: 60 },
        (_, index) => `  const inner${index} = ${index};`
      ),
      "  return current;",
      "}",
      "",
      "export const LAST_CONSTANT = 2;",
    ],
    MIN_SUMMARY_LINES + 20
  );
}

/** A large file: more collapsible bodies than the footer names inline. */
function manyBodiesFixture(): string[] {
  const functions: string[] = [];

  for (let index = 0; index < MAX_FOOTER_SELECTORS + 2; index += 1) {
    functions.push(`export function fn${index}(value: number): number {`);
    functions.push(
      ...Array.from(
        { length: MIN_BODY_LINES + 2 },
        (_, step) => `  const step${step} = value + ${step};`
      )
    );
    functions.push("  return value;", "}", "");
  }

  return fillTo(functions, MIN_SUMMARY_LINES + 20);
}

describe("summarising a large source file", () => {
  let fixture: Summarized;

  beforeAll(async () => {
    fixture = await summarize("big.ts", largeFixture());
  });

  it("collapses a long body and keeps the declarations around it", () => {
    const summary = requireSummary(fixture.summary);

    expect(summary.content).toContain(
      "export function big(current: number): number {"
    );
    expect(summary.content).toContain("export const FIRST_CONSTANT = 1;");
    expect(summary.content).toContain("export const LAST_CONSTANT = 2;");
    expect(summary.content).toContain('import { z } from "zod";');
    expect(summary.content).not.toContain("const inner0 = 0;");
    expect(summary.content).not.toContain("const inner59 = 59;");
    expect(summary.content).toContain("---- omitted lines 6-66 ----");
    expect(summary.elidedRanges).toEqual([{ endLine: 66, startLine: 6 }]);
    expect(summary.elidedLines).toBe(61);
    expect(summary.capped).toBe(false);
  });

  it("names a selector in the footer that recovers what it elided", () => {
    const { filePath, summary: maybe } = fixture;
    const summary = requireSummary(maybe);
    const hint = footerSelector(summary.content, filePath);

    expect(hint).toBeDefined();
    if (hint === undefined) {
      throw new Error("expected a recovery selector in the footer");
    }

    expect(summary.content).toContain(
      `re-read required ranges with ${filePath}:${hint}`
    );
    // The hint is not decoration: it parses back to exactly the elided ranges.
    expect(selectorLineRanges(hint)).toEqual(summary.elidedRanges);

    const reRead = splitPathAndSel(`${filePath}:${hint}`);
    expect(reRead.path).toBe(filePath);
    expect(reRead.sel).toBe(hint);
  });

  it("collapses a long block comment the same way", async () => {
    const lines = fillTo(
      [
        "/*",
        ...Array.from({ length: 10 }, (_, index) => ` * note ${index}`),
        " */",
        "export const AFTER_COMMENT = 1;",
      ],
      MIN_SUMMARY_LINES + 10
    );
    const summary = requireSummary(
      (await summarize("comment.ts", lines)).summary
    );

    expect(summary.content).toContain("---- omitted lines 2-11 ----");
    expect(summary.content).toContain(" */");
    expect(summary.content).toContain("export const AFTER_COMMENT = 1;");
    expect(summary.elidedRanges).toEqual([{ endLine: 11, startLine: 2 }]);
  });

  it("finds only the outermost body, never a range inside a range", async () => {
    const lines = fillTo(
      [
        "export function outer(): void {",
        "  const before = 1;",
        "  function inner(): void {",
        ...Array.from(
          { length: 20 },
          (_, index) => `    const deep${index} = ${index};`
        ),
        "  }",
        "  inner();",
        "}",
      ],
      MIN_SUMMARY_LINES + 10
    );
    const summary = requireSummary(
      (await summarize("nested.ts", lines)).summary
    );

    expect(summary.elidedRanges).toEqual([{ endLine: 25, startLine: 2 }]);
    expect(summary.content).not.toContain("const deep0 = 0;");
  });

  it("elides a body of exactly the minimum size and not one line less", async () => {
    const atThreshold = fillTo(
      [
        "function atThreshold(): void {",
        ...Array.from(
          { length: MIN_BODY_LINES },
          (_, index) => `  const keep${index} = ${index};`
        ),
        "}",
      ],
      MIN_SUMMARY_LINES + 10
    );
    const belowThreshold = fillTo(
      [
        "function belowThreshold(): void {",
        ...Array.from(
          { length: MIN_BODY_LINES - 1 },
          (_, index) => `  const keep${index} = ${index};`
        ),
        "}",
      ],
      MIN_SUMMARY_LINES + 10
    );

    const summary = requireSummary(
      (await summarize("edge.ts", atThreshold)).summary
    );

    expect(summary.elidedRanges).toEqual([
      { endLine: MIN_BODY_LINES + 1, startLine: 2 },
    ]);
    expect(
      (await summarize("under.ts", belowThreshold)).summary
    ).toBeUndefined();
  });

  it("does not mistake a brace in a string, regex, or template for a body", async () => {
    const lines = fillTo(
      [
        "const literal = '{ not a body }';",
        "const pattern = /[{}]{2,}/;",
        "const template = `",
        "{",
        ...Array.from({ length: 12 }, (_, index) => `  pad${index}`),
        "}`;",
      ],
      MIN_SUMMARY_LINES + 10
    );

    // An unmasked template body would read as a block spanning twelve lines.
    expect((await summarize("literals.ts", lines)).summary).toBeUndefined();
  });
});

describe("what a summary refuses to touch", () => {
  it("returns nothing for a file below the size threshold", async () => {
    const { summary } = await summarize("small.ts", [
      "export function big(): number {",
      ...Array.from(
        { length: 60 },
        (_, index) => `  const inner${index} = ${index};`
      ),
      "  return 1;",
      "}",
    ]);

    expect(summary).toBeUndefined();
  });

  it("returns nothing for a large file with no body worth collapsing", async () => {
    const { summary } = await summarize(
      "flat.ts",
      fillTo([], MIN_SUMMARY_LINES + 10)
    );

    expect(summary).toBeUndefined();
  });

  it("returns nothing for a language it has no parser for", async () => {
    const lines: string[] = [];

    while (lines.length < MIN_SUMMARY_LINES + 20) {
      lines.push(`def fn_${lines.length}(value):`);
      lines.push(
        ...Array.from(
          { length: MIN_BODY_LINES + 2 },
          (_, step) => `    step_${step} = value + ${step}`
        )
      );
      lines.push("    return value", "");
    }

    const { summary } = await summarize("big.py", lines);

    expect(summary).toBeUndefined();
  });

  it("summarises the tree it is given instead of parsing the file", () => {
    const lines = fillTo([""], MIN_SUMMARY_LINES);
    const tree: SourceNode = {
      children: [{ children: [], endRow: 20, startRow: 10, type: "block" }],
      endRow: lines.length - 1,
      startRow: 0,
      type: "program",
    };

    const summary = summarizeSource(lines.join("\n"), "override.ts", {
      parse: () => tree,
    });

    expect(summary?.elidedRanges).toEqual([{ endLine: 20, startLine: 12 }]);
    expect(summary?.elidedLines).toBe(9);
  });
});

describe("the stated bound", () => {
  it("says how many bodies it elided and how many declarations it kept", async () => {
    const { summary: maybe } = await summarize("many.ts", manyBodiesFixture());
    const summary = requireSummary(maybe);
    const footer = summary.content.split("\n").at(-1) ?? "";

    expect(summary.elidedRanges).toHaveLength(MAX_FOOTER_SELECTORS + 2);
    expect(summary.elidedLines).toBe(110);
    expect(summary.keptBodies).toBe(MAX_FOOTER_SELECTORS + 2);
    expect(footer).toContain("10 bodies elided (110 lines)");
    expect(footer).toContain("10 declarations kept verbatim");
  });

  it("says how many further ranges it did not name, and how to read them", async () => {
    const { filePath, summary: maybe } = await summarize(
      "many.ts",
      manyBodiesFixture()
    );
    const summary = requireSummary(maybe);
    const footer = summary.content.split("\n").at(-1) ?? "";
    const hint = footerSelector(summary.content, filePath);

    expect(footer).toContain("2 further ranges elided");
    expect(footer).toContain(`read ${filePath}:1- for the whole file`);
    expect(selectorLineRanges(hint)).toEqual(
      summary.elidedRanges.slice(0, MAX_FOOTER_SELECTORS)
    );
  });

  it("caps its own length and names the tail it dropped", async () => {
    const lines = fillTo(
      [
        "export function big(): number {",
        ...Array.from(
          { length: 20 },
          (_, index) => `  const inner${index} = ${index};`
        ),
        "  return 1;",
        "}",
      ],
      MIN_SUMMARY_LINES + MAX_SUMMARY_LINES + 200
    );
    const { filePath, summary: maybe } = await summarize("huge.ts", lines);
    const summary = requireSummary(maybe);
    const tail = summary.elidedRanges.at(-1);
    const footer = summary.content.split("\n").at(-1) ?? "";
    const lastLine = lines.at(-1) ?? "";

    expect(summary.capped).toBe(true);
    expect(summary.content.split("\n").length).toBeLessThanOrEqual(
      MAX_SUMMARY_LINES
    );
    expect(tail?.endLine).toBe(lines.length);
    expect(summary.content).toContain(
      `---- omitted lines ${tail?.startLine}-${tail?.endLine} ----`
    );
    expect(footer).toContain(`summary capped at ${MAX_SUMMARY_LINES} lines`);
    expect(lastLine).not.toBe("");
    expect(summary.content).not.toContain(lastLine);
    expect(
      selectorLineRanges(footerSelector(summary.content, filePath))
    ).toEqual(summary.elidedRanges);
  });
});
