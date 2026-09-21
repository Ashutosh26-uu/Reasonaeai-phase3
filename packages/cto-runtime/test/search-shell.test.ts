import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noopObserve } from "@mastra/core/tools";
import { describe, expect, it } from "vitest";

import { createBashTool, runCommand } from "../src/tools/bash.js";
import { createGlobTool, globPaths } from "../src/tools/glob.js";
import { createGrepTool, grepContent } from "../src/tools/grep.js";

/** The refusal a pattern ripgrep cannot compile must produce. */
const INVALID_PATTERN_RE = /Invalid regular expression/;

/** The execution context the runtime always supplies to a tool. */
const TOOL_CONTEXT = { observe: noopObserve };

/** Absolute paths, spelled ripgrep's way on one side and the platform's on the
 * other, so the comparison is about the path and not the separator. */
function normalizePaths(paths: string[]): string[] {
  return paths.map((entry) => entry.split("\\").join("/"));
}

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "reasonate-search-"));

  await Promise.all(
    Object.entries(files).map(async ([relative, content]) => {
      const target = join(root, relative);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, content);
    })
  );

  return root;
}

/**
 * Write a program and return the command that runs it.
 *
 * The programs are files rather than `node -e` one-liners so that no part of
 * the test depends on how the platform's shell quotes an argument.
 */
async function script(
  root: string,
  name: string,
  source: string
): Promise<string> {
  const target = join(root, name);
  await writeFile(target, source);
  return `node "${target}"`;
}

const SUCCESS_SCRIPT = 'process.stdout.write("hello");\n';

const FAILURE_SCRIPT =
  'process.stdout.write("out");\nprocess.stderr.write("bad");\nprocess.exit(3);\n';

const SLEEP_SCRIPT = "setTimeout(() => {}, 60_000);\n";

const LONG_SCRIPT =
  "for (let index = 0; index < 4000; index += 1) {\n" +
  '  process.stdout.write("line " + index + "\\n");\n' +
  "}\n";

/** More output than the collector holds, so the ceiling has to be reported. */
const FLOOD_SCRIPT =
  'const line = "x".repeat(50_000);\n' +
  "for (let index = 0; index < 200; index += 1) {\n" +
  '  process.stdout.write(line + "\\n");\n' +
  "}\n";

describe("glob", () => {
  it("finds the paths matching the pattern", async () => {
    const root = await workspace({
      "a.ts": "",
      "b.ts": "",
      "notes.md": "",
      "sub/c.ts": "",
    });

    const found = await globPaths({ cwd: root, pattern: "**/*.ts" });

    expect(found.error).toBeUndefined();
    expect(found.truncated).toBe(false);
    expect(found.total).toBe(3);
    expect(normalizePaths(found.paths).sort()).toEqual(
      normalizePaths([
        join(root, "a.ts"),
        join(root, "b.ts"),
        join(root, "sub/c.ts"),
      ]).sort()
    );
  });

  it("searches the directory it was given", async () => {
    const root = await workspace({ "a.ts": "", "sub/c.ts": "" });

    const found = await globPaths({
      cwd: root,
      path: "sub",
      pattern: "**/*.ts",
    });

    expect(normalizePaths(found.paths)).toEqual([
      normalizePaths([join(root, "sub/c.ts")])[0],
    ]);
  });

  it("states the cap and the real total when it stops early", async () => {
    const root = await workspace({
      "a.ts": "",
      "b.ts": "",
      "c.ts": "",
      "d.ts": "",
      "e.ts": "",
    });

    const found = await globPaths({
      cwd: root,
      maxResults: 2,
      pattern: "**/*.ts",
    });

    expect(found.paths).toHaveLength(2);
    expect(found.total).toBe(5);
    expect(found.truncated).toBe(true);
    expect(found.notice).toContain("5 paths matched");
    expect(found.notice).toContain("the first 2");
    expect(found.notice).toContain("3 not shown");
  });

  it("says so when nothing matched", async () => {
    const root = await workspace({ "a.ts": "" });

    const found = await globPaths({ cwd: root, pattern: "**/*.nope" });

    expect(found.error).toBeUndefined();
    expect(found.paths).toEqual([]);
    expect(found.total).toBe(0);
    expect(found.notice).toBe("No files matched the pattern.");
  });

  it("refuses clearly when ripgrep is not installed", async () => {
    const root = await workspace({ "a.ts": "" });
    const path = process.env.PATH;
    process.env.PATH = "";

    try {
      const found = await globPaths({ cwd: root, pattern: "**/*.ts" });

      expect(found.error).toContain("ripgrep (rg) not found");
      expect(found.paths).toEqual([]);
    } finally {
      process.env.PATH = path;
    }
  });
});

describe("grep", () => {
  it("finds matches with their line numbers", async () => {
    const root = await workspace({ "a.txt": "alpha\nbeta\nalpha\n" });

    const found = await grepContent({ cwd: root, pattern: "alpha" });

    expect(found.error).toBeUndefined();
    expect(found.total).toBe(2);
    expect(found.truncated).toBe(false);
    expect(normalizePaths(found.lines)).toEqual([
      `${normalizePaths([join(root, "a.txt")])[0]}:1:alpha`,
      `${normalizePaths([join(root, "a.txt")])[0]}:3:alpha`,
    ]);
  });

  it("scopes the search to the files it was told to include", async () => {
    const root = await workspace({
      "a.md": "needle\n",
      "b.txt": "needle\n",
    });

    const found = await grepContent({
      cwd: root,
      include: "*.md",
      pattern: "needle",
    });

    expect(found.total).toBe(1);
    expect(found.lines[0]).toContain("a.md");
  });

  it("refuses an invalid regular expression instead of throwing", async () => {
    const root = await workspace({ "a.txt": "alpha\n" });

    const found = await grepContent({ cwd: root, pattern: "alpha(" });

    expect(found.lines).toEqual([]);
    expect(found.total).toBe(0);
    expect(found.error).toMatch(INVALID_PATTERN_RE);
  });

  it("says so when nothing matched", async () => {
    const root = await workspace({ "a.txt": "alpha\n" });

    const found = await grepContent({ cwd: root, pattern: "zzz" });

    expect(found.error).toBeUndefined();
    expect(found.lines).toEqual([]);
    expect(found.total).toBe(0);
    expect(found.notice).toBe("No matches found.");
  });

  it("states the cap and how many matches were withheld", async () => {
    const root = await workspace({
      "a.txt": "needle\nneedle\nneedle\nneedle\nneedle\n",
    });

    const found = await grepContent({
      cwd: root,
      maxResults: 2,
      pattern: "needle",
    });

    expect(found.lines).toHaveLength(2);
    expect(found.total).toBe(5);
    expect(found.truncated).toBe(true);
    expect(found.notice).toContain("5 matches found");
    expect(found.notice).toContain("3 withheld");
  });
});

describe("bash", () => {
  it("returns stdout and the exit code of a successful command", async () => {
    const root = await workspace({});
    const command = await script(root, "ok.js", SUCCESS_SCRIPT);

    const result = await runCommand({ command });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it("returns a non-zero exit code and stderr as a result, not a throw", async () => {
    const root = await workspace({});
    const command = await script(root, "fail.js", FAILURE_SCRIPT);

    const result = await runCommand({ command });

    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("bad");
    expect(result.error).toBeUndefined();
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);

    // Windows PowerShell flattens a failing native command's exit code to 1,
    // so the command's own code is only observable where the shell passes it
    // through. See the module note in `bash.ts`.
    if (process.platform !== "win32") {
      expect(result.exitCode).toBe(3);
    }
  });

  it("reports a timeout as a timeout", async () => {
    const root = await workspace({});
    const command = await script(root, "sleep.js", SLEEP_SCRIPT);

    const result = await runCommand({ command, timeoutMs: 300 });

    expect(result.timedOut).toBe(true);
    expect(result.timeoutMs).toBe(300);
    expect(result.exitCode).toBe(-1);
    expect(result.notice).toContain("300 ms timeout");
  });

  it("stops the command and says so when the run is cancelled", async () => {
    const root = await workspace({});
    const command = await script(root, "sleep.js", SLEEP_SCRIPT);
    const controller = new AbortController();

    // The abort is raised against a command that is genuinely still running in
    // a real child process, so there is no window to fake: the sleep script
    // runs for a minute, and the abort lands while it is alive.
    const running = runCommand({
      command,
      signal: controller.signal,
      timeoutMs: 60_000,
    });
    controller.abort();

    const result = await running;

    expect(result.error).toBe("The command was cancelled.");
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(-1);
  });

  it("answers an already-cancelled run as cancelled", async () => {
    const root = await workspace({});
    const command = await script(root, "sleep.js", SLEEP_SCRIPT);
    const controller = new AbortController();
    controller.abort();

    const result = await runCommand({
      command,
      signal: controller.signal,
      timeoutMs: 60_000,
    });

    expect(result.error).toBe("The command was cancelled.");
    expect(result.exitCode).toBe(-1);
  });

  it("states the bound when it cuts long output", async () => {
    const root = await workspace({});
    const command = await script(root, "long.js", LONG_SCRIPT);

    const result = await runCommand({ command });

    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.notice).toContain("stdout truncated: 4000 lines");
    // The tail is what is kept: the end of a command's output is its verdict.
    expect(result.stdout).toContain("line 3999");
    expect(result.stdout.split("\n").length).toBeLessThanOrEqual(2001);
  });

  it("states the ceiling when a command floods the collector", async () => {
    const root = await workspace({});
    const command = await script(root, "flood.js", FLOOD_SCRIPT);

    const result = await runCommand({ command });

    expect(result.truncated).toBe(true);
    expect(result.notice).toContain("in-memory limit");
  });

  it("hands the full output of a truncated run to the caller's store", async () => {
    const root = await workspace({});
    const command = await script(root, "long.js", LONG_SCRIPT);
    let spilled = "";

    const result = await runCommand({
      command,
      spill: (content) => {
        spilled = content;
        return Promise.resolve(7);
      },
    });

    expect(result.notice).toContain("Full output: artifact://7");
    expect(spilled.split("\n").length).toBeGreaterThan(2000);
  });
});

/**
 * The three tools are also the deliverable, so each is called once through the
 * tool object the runtime will hold, not only through the logic underneath it.
 */
describe("the tools the runtime holds", () => {
  it("lists through the glob tool", async () => {
    const root = await workspace({ "a.ts": "", "b.ts": "" });
    const tool = createGlobTool({ cwd: root });

    if (tool.execute === undefined) {
      throw new Error("the glob tool must be executable");
    }

    const result = await tool.execute({ pattern: "**/*.ts" }, TOOL_CONTEXT);

    expect(result).toMatchObject({ total: 2, truncated: false });
  });

  it("searches through the grep tool", async () => {
    const root = await workspace({ "a.txt": "needle\n" });
    const tool = createGrepTool({ cwd: root });

    if (tool.execute === undefined) {
      throw new Error("the grep tool must be executable");
    }

    const result = await tool.execute({ pattern: "needle" }, TOOL_CONTEXT);

    expect(result).toMatchObject({ total: 1, truncated: false });
  });

  it("runs a command through the bash tool", async () => {
    const root = await workspace({});
    const command = await script(root, "ok.js", SUCCESS_SCRIPT);
    const tool = createBashTool();

    if (tool.execute === undefined) {
      throw new Error("the bash tool must be executable");
    }

    const result = await tool.execute({ command }, TOOL_CONTEXT);

    expect(result).toMatchObject({
      exitCode: 0,
      stderr: "",
      stdout: "hello",
      timedOut: false,
    });
  });
});
