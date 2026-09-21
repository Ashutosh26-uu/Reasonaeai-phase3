/**
 * The glob tool: list paths matching a glob pattern.
 *
 * Ported from spectra (MIT; the author's own project) —
 * `packages/code/src/tools/glob.ts` — which lists with ripgrep. The tool
 * wrapper is `createTool` + zod here, and the terminal-UI display is dropped.
 *
 * One deliberate change from the original: the bound on the listing is always
 * stated together with the real total. A listing that silently stops reads as a
 * complete one, so a model that was shown 100 of 4000 paths has to be told that
 * 3900 were withheld, or it will conclude the file it wanted does not exist.
 *
 * ripgrep must be on `PATH`; spectra accepted that dependency and reported its
 * absence with an install hint, which is preserved here.
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/** Spectra's default: enough paths to orient a model without flooding it. */
const DEFAULT_MAX_RESULTS = 100;

/** Largest listing a caller may ask for. Retention is bounded by this. */
const MAX_MAX_RESULTS = 10_000;

/** ripgrep exits 0 for matches, 1 for none, and above 1 for a failure. */
const RIPGREP_FAILURE_EXIT = 1;

const RIPGREP_BINARY = process.platform === "win32" ? "rg.exe" : "rg";

/** Spectra excluded the repository's own metadata from every listing. */
const RIPGREP_IGNORE_GIT = "--glob=!.git/*";

/** Bounds on the error text, so one bad path cannot produce a huge message. */
const STDERR_LIMIT_BYTES = 4096;

const CANCELLED_MESSAGE = "The search was cancelled.";

const MISSING_RIPGREP_MESSAGE =
  "ripgrep (rg) not found. Install it: https://github.com/BurntSushi/ripgrep#installation";

const NO_MATCHES_MESSAGE = "No files matched the pattern.";

const GlobInputSchema = z.strictObject({
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(MAX_MAX_RESULTS)
    .optional()
    .describe(
      `Maximum number of paths to return (default ${DEFAULT_MAX_RESULTS}, max ${MAX_MAX_RESULTS})`
    ),
  path: z
    .string()
    .optional()
    .describe("Directory to search in (defaults to cwd)"),
  pattern: z
    .string()
    .min(1)
    .describe("Glob pattern to match files (e.g. '**/*.ts', 'src/**/*.css')"),
});

/**
 * The outcome of one glob.
 *
 * `total` is what ripgrep matched and `paths` is what the bound left; a caller
 * can always tell how much of the answer it was given.
 */
const GlobOutcomeSchema = z.strictObject({
  error: z
    .string()
    .optional()
    .describe("Set when the listing could not be produced at all."),
  limit: z.number().describe("The bound applied to `paths`."),
  notice: z
    .string()
    .optional()
    .describe("Set when the result is empty or was cut."),
  paths: z.array(z.string()),
  total: z.number().describe("Paths matched in total, before the bound."),
  truncated: z.boolean(),
});

export type GlobOutcome = z.infer<typeof GlobOutcomeSchema>;

export interface GlobOptions {
  /** Base for a relative `path`. Defaults to the process working directory. */
  cwd?: string | undefined;
  maxResults?: number | undefined;
  path?: string | undefined;
  pattern: string;
  signal?: AbortSignal | undefined;
}

interface RipgrepRun {
  /** Set when the caller's abort signal stopped the search. */
  cancelled: boolean;
  exitCode: number;
  /** Lines ripgrep wrote, including any past the retention window. */
  lineCount: number;
  /** At most `retainLines` lines, in the order ripgrep wrote them. */
  lines: string[];
  /** Set when ripgrep could not be spawned at all. */
  missing: boolean;
  stderr: string;
}

/**
 * Run ripgrep, keeping the first `retainLines` lines of output and counting the
 * rest.
 *
 * Counting rather than buffering is what lets the caller state the real total
 * without holding a listing of arbitrary size in memory.
 */
function runRipgrep(
  args: readonly string[],
  options: { retainLines: number; signal?: AbortSignal | undefined }
): Promise<RipgrepRun> {
  return new Promise<RipgrepRun>((settle) => {
    const child = spawn(RIPGREP_BINARY, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let cancelled = false;
    let held = "";
    let heldLines = 0;
    let holding = true;
    let lineCount = 0;
    let midLine = false;
    let missing = false;
    let settled = false;
    let stderr = "";
    let stderrBytes = 0;

    const onAbort = () => {
      cancelled = true;
      child.kill("SIGKILL");
    };

    const finish = (exitCode: number) => {
      if (settled) {
        return;
      }
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      settle({
        cancelled,
        exitCode,
        // A stream that ended without a newline still ended with a line.
        lineCount: midLine ? lineCount + 1 : lineCount,
        lines: retainedLines(held),
        missing,
        stderr,
      });
    };

    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.once("error", (error: NodeJS.ErrnoException) => {
      missing = error.code === "ENOENT";
      stderr = error.message;
      finish(RIPGREP_FAILURE_EXIT + 1);
    });

    // `exit` can fire before the last of stdout is drained, so the result is
    // built on `close`, which fires once both streams are done.
    child.once("close", (code) => finish(code ?? RIPGREP_FAILURE_EXIT));

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      lineCount += countNewlines(text);
      midLine = !text.endsWith("\n");

      if (!holding) {
        return;
      }

      held += text;
      heldLines += countNewlines(text);
      if (heldLines > options.retainLines) {
        held = firstLines(held, options.retainLines);
        holding = false;
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= STDERR_LIMIT_BYTES) {
        return;
      }
      stderr += chunk.toString("utf-8");
      stderrBytes += chunk.byteLength;
    });
  });
}

/** The retained lines, without the empty element a trailing newline leaves. */
function retainedLines(held: string): string[] {
  if (held === "") {
    return [];
  }

  const lines = held.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }

  return lines;
}

function countNewlines(text: string): number {
  let count = 0;
  let index = text.indexOf("\n");

  while (index !== -1) {
    count += 1;
    index = text.indexOf("\n", index + 1);
  }

  return count;
}

/** The first `count` lines of `text`, without the trailing newline. */
function firstLines(text: string, count: number): string {
  let index = -1;
  let seen = 0;

  while (seen < count) {
    index = text.indexOf("\n", index + 1);
    if (index === -1) {
      return text;
    }
    seen += 1;
  }

  return text.slice(0, index);
}

function noticeFor(
  shown: number,
  total: number,
  limit: number
): string | undefined {
  if (total === 0) {
    return NO_MATCHES_MESSAGE;
  }

  if (total <= shown) {
    return undefined;
  }

  return `${total} paths matched; showing the first ${limit}. ${total - shown} not shown — narrow the pattern or raise maxResults to see them.`;
}

function refusal(limit: number, error: string): GlobOutcome {
  return { error, limit, paths: [], total: 0, truncated: false };
}

/**
 * List the paths under `path` that match `pattern`.
 *
 * Ripgrep does the matching, so the pattern language is ripgrep's: everything
 * `.gitignore` covers is skipped, and `--hidden` means dot-paths are listed.
 */
export async function globPaths(options: GlobOptions): Promise<GlobOutcome> {
  const cwd = options.cwd ?? process.cwd();
  const searchDir = options.path ? resolve(cwd, options.path) : cwd;
  const limit = options.maxResults ?? DEFAULT_MAX_RESULTS;

  const run = await runRipgrep(
    [
      "--no-config",
      "--files",
      "--hidden",
      RIPGREP_IGNORE_GIT,
      `--glob=${options.pattern}`,
      searchDir,
    ],
    { retainLines: limit, signal: options.signal }
  );

  if (run.missing) {
    return refusal(limit, MISSING_RIPGREP_MESSAGE);
  }

  if (run.cancelled) {
    return refusal(limit, CANCELLED_MESSAGE);
  }

  if (run.exitCode > RIPGREP_FAILURE_EXIT) {
    return refusal(
      limit,
      `ripgrep error: ${run.stderr.trim() || "unknown error"}`
    );
  }

  const paths = run.lines.slice(0, limit);

  return {
    limit,
    notice: noticeFor(paths.length, run.lineCount, limit),
    paths,
    total: run.lineCount,
    truncated: run.lineCount > paths.length,
  };
}

export function createGlobTool(input: { cwd?: string | undefined } = {}) {
  return createTool({
    description: `Find files matching a glob pattern.
Uses ripgrep (rg) for fast file listing, so paths ignored by .gitignore are not listed and hidden paths are.
Supports common glob patterns like **/*.ts, src/**/*.css, etc.
Results are capped; the cap and the real total are always reported.`,
    execute: async (args, context) =>
      await globPaths({
        cwd: input.cwd,
        maxResults: args.maxResults,
        path: args.path,
        pattern: args.pattern,
        signal: context.abortSignal,
      }),
    id: "glob",
    inputSchema: GlobInputSchema,
    outputSchema: GlobOutcomeSchema,
  });
}
