/**
 * The grep tool: search file contents with a regular expression.
 *
 * Ported from spectra (MIT; the author's own project) —
 * `packages/code/src/tools/grep.ts` — which searches with ripgrep. The tool
 * wrapper is `createTool` + zod here, and the terminal-UI display is dropped.
 *
 * Two deliberate changes from the original:
 *
 * - An invalid pattern is refused with a clear message. Ripgrep reports it as a
 *   parse error on stderr with a failure exit code, and the original surfaced
 *   that only as a generic failure; a caller that cannot tell "your regex is
 *   broken" from "the search could not run" spends a turn guessing.
 * - The cap is applied to the matches that are returned, and the number
 *   withheld is stated. The original passed `--max-count`, which caps matches
 *   *per file*, so its output could exceed the cap it was reporting and it
 *   announced truncation without ever having truncated.
 *
 * ripgrep must be on `PATH`; spectra accepted that dependency and reported its
 * absence with an install hint, which is preserved here.
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/** Spectra's default: enough matches to act on without flooding the context. */
const DEFAULT_MAX_RESULTS = 50;

/** Largest number of matches a caller may ask for. */
const MAX_MAX_RESULTS = 10_000;

/** ripgrep exits 0 for matches, 1 for none, and above 1 for a failure. */
const RIPGREP_FAILURE_EXIT = 1;

const RIPGREP_BINARY = process.platform === "win32" ? "rg.exe" : "rg";

/** Spectra excluded the repository's own metadata from every search. */
const RIPGREP_IGNORE_GIT = "--glob=!.git/*";

/** Ripgrep's stderr for a pattern it cannot compile. */
const RIPGREP_REGEX_ERROR_RE = /regex parse error/;

/** Bounds on the error text, so one bad path cannot produce a huge message. */
const STDERR_LIMIT_BYTES = 4096;

const CANCELLED_MESSAGE = "The search was cancelled.";

const MISSING_RIPGREP_MESSAGE =
  "ripgrep (rg) not found. Install it: https://github.com/BurntSushi/ripgrep#installation";

const NO_MATCHES_MESSAGE = "No matches found.";

const GrepInputSchema = z.strictObject({
  include: z
    .string()
    .optional()
    .describe("File pattern to include (e.g. '*.ts', '*.{ts,js}')"),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(MAX_MAX_RESULTS)
    .optional()
    .describe(
      `Maximum number of matches to return (default ${DEFAULT_MAX_RESULTS}, max ${MAX_MAX_RESULTS})`
    ),
  path: z
    .string()
    .optional()
    .describe("Directory to search in (defaults to cwd)"),
  pattern: z.string().min(1).describe("The regex pattern to search for"),
});

/**
 * The outcome of one search.
 *
 * `lines` is ripgrep's own match format, `path:line:text`, kept verbatim: it is
 * the line-numbered shape the original returned, and parsing it would break on
 * the Windows paths this runs on, where the separator is also `:`.
 */
const GrepOutcomeSchema = z.strictObject({
  error: z
    .string()
    .optional()
    .describe("Set when the search could not be run, e.g. an invalid pattern."),
  limit: z.number().describe("The bound applied to `lines`."),
  lines: z.array(z.string()),
  notice: z
    .string()
    .optional()
    .describe("Set when the result is empty or was cut."),
  total: z.number().describe("Matches found in total, before the bound."),
  truncated: z.boolean(),
});

export type GrepOutcome = z.infer<typeof GrepOutcomeSchema>;

export interface GrepOptions {
  /** Base for a relative `path`. Defaults to the process working directory. */
  cwd?: string | undefined;
  include?: string | undefined;
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
 * Counting rather than buffering is what lets the caller state how many matches
 * were withheld without holding a match list of arbitrary size in memory.
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

/**
 * A failure ripgrep reported, named for what the caller can do about it.
 *
 * A pattern it cannot compile is a caller mistake with a one-word fix; anything
 * else is an environment failure. Both keep ripgrep's own detail, so the fix is
 * visible either way.
 */
function failureFor(stderr: string): string {
  const detail = stderr.trim() || "unknown error";

  if (RIPGREP_REGEX_ERROR_RE.test(detail)) {
    return `Invalid regular expression: ${detail}`;
  }

  return `ripgrep error: ${detail}`;
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

  return `${total} matches found; showing the first ${limit}. ${total - shown} withheld — narrow the pattern or raise maxResults to see them.`;
}

function refusal(limit: number, error: string): GrepOutcome {
  return { error, limit, lines: [], total: 0, truncated: false };
}

/**
 * Search file contents for `pattern`.
 *
 * Ripgrep does the matching, so the pattern language is ripgrep's, and every
 * match carries its line number.
 */
export async function grepContent(options: GrepOptions): Promise<GrepOutcome> {
  const cwd = options.cwd ?? process.cwd();
  const searchDir = options.path ? resolve(cwd, options.path) : cwd;
  const limit = options.maxResults ?? DEFAULT_MAX_RESULTS;

  const args = [
    "-n",
    "--no-heading",
    "--hidden",
    "--no-config",
    RIPGREP_IGNORE_GIT,
  ];

  if (options.include !== undefined) {
    args.push(`--glob=${options.include}`);
  }

  args.push("--", options.pattern, searchDir);

  const run = await runRipgrep(args, {
    retainLines: limit,
    signal: options.signal,
  });

  if (run.missing) {
    return refusal(limit, MISSING_RIPGREP_MESSAGE);
  }

  if (run.cancelled) {
    return refusal(limit, CANCELLED_MESSAGE);
  }

  if (run.exitCode > RIPGREP_FAILURE_EXIT) {
    return refusal(limit, failureFor(run.stderr));
  }

  const lines = run.lines.slice(0, limit);

  return {
    limit,
    lines,
    notice: noticeFor(lines.length, run.lineCount, limit),
    total: run.lineCount,
    truncated: run.lineCount > lines.length,
  };
}

export function createGrepTool(input: { cwd?: string | undefined } = {}) {
  return createTool({
    description: `Search file contents using regular expressions.
Uses ripgrep (rg) for fast searching, so paths ignored by .gitignore are not searched and hidden paths are.
Returns matching file paths, line numbers, and the matched lines.
Results are capped; the cap and the number of matches withheld are always reported.`,
    execute: async (args, context) =>
      await grepContent({
        cwd: input.cwd,
        include: args.include,
        maxResults: args.maxResults,
        path: args.path,
        pattern: args.pattern,
        signal: context.abortSignal,
      }),
    id: "grep",
    inputSchema: GrepInputSchema,
    outputSchema: GrepOutcomeSchema,
  });
}
