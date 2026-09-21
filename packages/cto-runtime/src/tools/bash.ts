/**
 * The bash tool: run a shell command and report what it did.
 *
 * Ported from spectra (MIT; the author's own project) —
 * `packages/code/src/tools/shell.ts`. The tool wrapper is `createTool` + zod,
 * and the terminal-UI streaming display (`onUpdate`) is dropped: this product
 * has no terminal UI, and a partial-output callback is not part of the tool
 * result contract here.
 *
 * Guards carried over from the original, because each one is load-bearing:
 *
 * - every command gets a timeout, and the process *group* is killed, so a
 *   command that started children does not outlive the tool call;
 * - stdout and stderr are captured separately and never read from a TTY —
 *   stdin is closed, so a command that waits for input cannot hang forever;
 * - output is bounded, and the bound is stated with the real totals.
 *
 * Two defects in the original are fixed here, both of which reported the wrong
 * thing to the caller:
 *
 * - A timeout was usually reported as a plain exit code. The kill path let the
 *   ordinary exit handler win, so a command stopped by the timeout arrived as
 *   `exit code 1` with the timeout message missing entirely; the timeout notice
 *   only appeared when the command ignored the kill signal as well. The kill
 *   reason is now what decides the result.
 * - Output was collected without any in-memory ceiling, so a command producing
 *   gigabytes (`yes`, `cat` of a large file) held all of it, and the process
 *   killed the worker instead of the command. Collection is capped and the
 *   ceiling is reported when it is reached.
 *
 * One defect is carried over rather than fixed, because fixing it would change
 * the command that is actually run: on Windows, PowerShell flattens the exit
 * code of a failing native command to 1, so `exitCode` there means "non-zero",
 * not the command's own code. Propagating it needs `; exit $LASTEXITCODE`
 * appended to every command — which itself reports 0 for a failing cmdlet —
 * or a wrapper that captures `$?` before `$LASTEXITCODE` can clobber it. That
 * is a product decision about the shell contract, not part of this port.
 *
 * The original also wrote the full output of a truncated run into a shared
 * temp directory. That is replaced by the run's artifact store: `spill` is
 * injected here exactly as the resource layer injects it for reads, and when no
 * store is configured the truncation is stated without a handle rather than
 * being written to a path every tenant can read.
 */

import { type ChildProcessByStdio, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";

import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/** Spectra's default and ceiling for a single command, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;

/** Bytes of a stream held in memory before later output is discarded. */
const MAX_COLLECT_BYTES = 8 * 1024 * 1024;

/** How much of each stream is returned inline, matching spectra's bound. */
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2000;

/** Grace between the polite kill and SIGKILL on POSIX, as in spectra. */
const SIGKILL_GRACE_MS = 200;

/** How long a killed command gets before the tool answers without it. */
const FORCE_FINALIZE_MS = 3100;

/** Extra time for the exit event after that SIGKILL. */
const FORCE_SETTLE_MS = 500;

/** Exit code reported when the tool stopped the command itself. */
const STOPPED_EXIT_CODE = -1;

const PWSH_RE = /^pwsh(\.exe)?$/i;
const POWERSHELL_RE = /^powershell(\.exe)?$/i;

/** Writes spilled text and returns its artifact id, like the readers do. */
export type Spill = (content: string, extension: string) => Promise<number>;

export interface BashOptions {
  command: string;
  cwd?: string | undefined;
  signal?: AbortSignal | undefined;
  /** Stores the full output of a truncated run. Omit to skip the spill. */
  spill?: Spill | undefined;
  timeoutMs?: number | undefined;
  workdir?: string | undefined;
}

const BashInputSchema = z.strictObject({
  command: z.string().min(1).describe("The shell command to execute"),
  // Descriptive only: the original used it for its display name, and the
  // runtime records the arguments it was called with regardless.
  description: z
    .string()
    .optional()
    .describe("Brief description of what this command does"),
  timeout: z
    .number()
    .int()
    .min(1)
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(
      `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})`
    ),
  workdir: z
    .string()
    .optional()
    .describe("Working directory for the command, absolute or relative to cwd"),
});

const BashResultSchema = z.strictObject({
  command: z.string(),
  error: z
    .string()
    .optional()
    .describe("Set when the command could not be run, or was cancelled."),
  exitCode: z
    .number()
    .describe("The command's exit code, or -1 when the tool stopped it."),
  notice: z
    .string()
    .optional()
    .describe("Timeout, truncation, and spill statements, when they apply."),
  stderr: z.string(),
  stdout: z.string(),
  timedOut: z.boolean(),
  timeoutMs: z.number().describe("The timeout that was applied to this run."),
  truncated: z
    .boolean()
    .describe("True when either stream was cut to the inline bound."),
  wallTimeMs: z.number(),
});

export type BashResult = z.infer<typeof BashResultSchema>;

interface BoundedStream {
  /** Bytes in the stream before the bound was applied. */
  bytes: number;
  /** Lines in the stream before the bound was applied. */
  lines: number;
  /** The tail that fits the inline bound. */
  text: string;
  /** True when something was dropped. */
  truncated: boolean;
}

interface CollectedRun {
  exitCode: number;
  /** Set when the tool stopped the command rather than the command ending. */
  killedBy?: "abort" | "timeout" | undefined;
  /** Set when the command could not be started at all. */
  spawnError?: string | undefined;
  stderr: string;
  stderrDropped: boolean;
  stdout: string;
  stdoutDropped: boolean;
  wallTimeMs: number;
}

/**
 * The last `maxBytes` of `line`, moved forward to a character boundary.
 *
 * Continuation bytes are 0x80-0xBF: skipping them means the cut never lands in
 * the middle of a character, so the result is still decodable text.
 */
function tailBytes(line: string, maxBytes: number): string {
  const buf = Buffer.from(line, "utf-8");
  let start = Math.max(0, buf.length - maxBytes);

  while (start < buf.length) {
    const byte = buf[start] ?? 0;
    if (byte < 0x80 || byte > 0xbf) {
      break;
    }
    start += 1;
  }

  return buf.subarray(start).toString("utf-8");
}

/**
 * The tail of `text` that fits `maxLines` and `maxBytes`.
 *
 * The tail rather than the head: the end of a command's output is where its
 * verdict is.
 */
function tailText(
  text: string,
  maxLines: number,
  maxBytes: number
): { cut: boolean; text: string } {
  const lines = text.split("\n");

  if (
    lines.length <= maxLines &&
    Buffer.byteLength(text, "utf-8") <= maxBytes
  ) {
    return { cut: false, text };
  }

  const kept: string[] = [];
  let bytes = 0;

  for (
    let index = lines.length - 1;
    index >= 0 && kept.length < maxLines;
    index -= 1
  ) {
    const line = lines[index] ?? "";
    const size = Buffer.byteLength(line, "utf-8") + (kept.length === 0 ? 0 : 1);

    if (bytes + size > maxBytes) {
      if (kept.length === 0) {
        kept.unshift(tailBytes(line, maxBytes));
      }
      break;
    }

    kept.unshift(line);
    bytes += size;
  }

  return { cut: true, text: kept.join("\n") };
}

/** Lines in `text`: an empty stream has none, and a stream that does not end
 * with a newline still has one more line. */
function countLines(text: string): number {
  if (text === "") {
    return 0;
  }

  let count = text.endsWith("\n") ? 0 : 1;
  let index = text.indexOf("\n");

  while (index !== -1) {
    count += 1;
    index = text.indexOf("\n", index + 1);
  }

  return count;
}

function boundStream(text: string): BoundedStream {
  const tail = tailText(text, MAX_OUTPUT_LINES, MAX_OUTPUT_BYTES);

  return {
    bytes: Buffer.byteLength(text, "utf-8"),
    lines: countLines(text),
    text: tail.text,
    truncated: tail.cut,
  };
}

/**
 * The shell spectra resolved, in spectra's order.
 *
 * Windows gets `pwsh.exe` when it is installed, then `powershell.exe`, then
 * `%COMSPEC%`, so that the command always reaches a shell that has not been
 * customised by whichever terminal started the worker.
 */
function resolveWindowsShell(): string {
  const dirs = (process.env.PATH || "").split(";");

  for (const name of ["pwsh.exe", "powershell.exe"]) {
    for (const dir of dirs) {
      if (existsSync(dir === "" ? name : join(dir, name))) {
        return name;
      }
    }
  }

  return process.env.COMSPEC || "cmd.exe";
}

function spawnCommand(input: {
  command: string;
  cwd: string;
}): ChildProcessByStdio<null, Readable, Readable> {
  if (process.platform !== "win32") {
    // Detached puts the command in its own process group, which is what makes
    // killing the whole tree possible. stdin stays closed: there is no
    // interactive terminal behind this tool.
    return spawn(input.command, [], {
      cwd: input.cwd,
      detached: true,
      env: process.env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  }

  const shell = resolveWindowsShell();
  const windowsShell =
    PWSH_RE.test(shell) || POWERSHELL_RE.test(shell) ? shell : "powershell.exe";

  return spawn(
    windowsShell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", input.command],
    {
      cwd: input.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );
}

/** Kill the command and everything it started. */
function killProcessTree(pid: number): Promise<void> {
  return new Promise<void>((settle) => {
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(pid), "/f", "/t"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("exit", () => settle());
      killer.once("error", () => settle());
      return;
    }

    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // Already gone.
    }

    const timer = setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      settle();
    }, SIGKILL_GRACE_MS);
    timer.unref();
  });
}

/** The exit code to report: a signalled command has none of its own. */
function exitCodeOf(
  code: number | null,
  signal: NodeJS.Signals | null
): number {
  if (code !== null) {
    return code;
  }

  return signal === null ? 0 : 1;
}

/** Node prefixes a spawn failure with the command; the caller has it. */
function cleanSpawnError(message: string, command: string): string {
  const prefix = `Command failed: ${command}`;

  if (!message.startsWith(prefix)) {
    return message || "The command could not be started.";
  }

  return message.slice(prefix.length).trim();
}

/**
 * Run the command and collect its streams, ending when it exits, when the
 * timeout fires, or when the caller's signal aborts.
 */
function collectCommand(input: {
  command: string;
  cwd: string;
  signal: AbortSignal | undefined;
  timeoutMs: number;
}): Promise<CollectedRun> {
  return new Promise<CollectedRun>((settle) => {
    const child = spawnCommand({ command: input.command, cwd: input.cwd });
    const started = Date.now();

    let killedBy: "abort" | "timeout" | undefined;
    let settled = false;
    let stderr = "";
    let stderrBytes = 0;
    let stderrDropped = false;
    let stdout = "";
    let stdoutBytes = 0;
    let stdoutDropped = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;

    const onAbort = () => stop("abort");

    const conclude = (exitCode: number, spawnError?: string) => {
      if (settled) {
        return;
      }
      settled = true;

      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
      }
      if (forceTimer !== undefined) {
        clearTimeout(forceTimer);
      }
      input.signal?.removeEventListener("abort", onAbort);

      settle({
        exitCode,
        killedBy,
        spawnError,
        stderr,
        stderrDropped,
        stdout,
        stdoutDropped,
        wallTimeMs: Date.now() - started,
      });
    };

    const stop = (reason: "abort" | "timeout") => {
      if (killedBy !== undefined) {
        return;
      }
      killedBy = reason;

      if (child.pid === undefined) {
        conclude(STOPPED_EXIT_CODE);
        return;
      }

      killProcessTree(child.pid);

      // A command that ignores the kill signals must not hold the run open.
      forceTimer = setTimeout(() => {
        child.kill("SIGKILL");
        forceTimer = setTimeout(
          () => conclude(STOPPED_EXIT_CODE),
          FORCE_SETTLE_MS
        );
      }, FORCE_FINALIZE_MS);
    };

    timeoutTimer = setTimeout(() => stop("timeout"), input.timeoutMs);

    if (input.signal !== undefined) {
      if (input.signal.aborted) {
        stop("abort");
      } else {
        input.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= MAX_COLLECT_BYTES) {
        stdoutDropped = true;
        return;
      }
      stdout += chunk.toString("utf-8");
      stdoutBytes += chunk.byteLength;
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= MAX_COLLECT_BYTES) {
        stderrDropped = true;
        return;
      }
      stderr += chunk.toString("utf-8");
      stderrBytes += chunk.byteLength;
    });

    // `exit` can fire before the last of stdout is drained, so the result is
    // built on `close`, which fires once both streams are done.
    child.once("close", (code, signal) => {
      if (killedBy === undefined) {
        conclude(exitCodeOf(code, signal));
        return;
      }

      // The command did not end on its own, so its own exit code is not the
      // answer the caller needs: the tool stopping it is.
      conclude(STOPPED_EXIT_CODE);
    });

    child.once("error", (error: NodeJS.ErrnoException) => {
      conclude(1, cleanSpawnError(error.message, input.command));
    });
  });
}

/** What went wrong for the caller: nothing to run, or a cancelled run. */
function errorFor(run: CollectedRun): string | undefined {
  if (run.spawnError !== undefined) {
    return run.spawnError;
  }

  if (run.killedBy === "abort") {
    return "The command was cancelled.";
  }

  return undefined;
}

/**
 * State the cut, with the real totals and a handle to the full text.
 *
 * A silent cut is the failure this guards against: the caller must know that
 * what it is reading is a fragment of something longer.
 */
async function truncationNotice(
  stream: "stderr" | "stdout",
  bound: BoundedStream,
  full: string,
  spill: Spill | undefined
): Promise<string> {
  const kept = Buffer.byteLength(bound.text, "utf-8");
  const artifactUrl =
    spill === undefined ? undefined : `artifact://${await spill(full, "txt")}`;

  return [
    `${stream} truncated: ${bound.lines} lines / ${bound.bytes} bytes total; the last ${kept} bytes are shown (at most ${MAX_OUTPUT_LINES} lines and ${MAX_OUTPUT_BYTES} bytes).`,
    artifactUrl === undefined
      ? "Re-run the command with narrower output to see the rest."
      : `Full output: ${artifactUrl}.`,
  ].join(" ");
}

function collectionNotice(stream: "stderr" | "stdout"): string {
  return `${stream} produced more than the ${MAX_COLLECT_BYTES}-byte in-memory limit; output past that was discarded.`;
}

async function summarize(
  run: CollectedRun,
  input: { command: string; spill: Spill | undefined; timeoutMs: number }
): Promise<BashResult> {
  const stdoutBound = boundStream(run.stdout);
  const stderrBound = boundStream(run.stderr);
  const notices: string[] = [];

  if (run.killedBy === "timeout") {
    notices.push(
      `The command was terminated after exceeding the ${input.timeoutMs} ms timeout. If it is expected to take longer, retry with a larger timeout value.`
    );
  }
  if (run.stdoutDropped) {
    notices.push(collectionNotice("stdout"));
  }
  if (run.stderrDropped) {
    notices.push(collectionNotice("stderr"));
  }
  if (stdoutBound.truncated) {
    notices.push(
      await truncationNotice("stdout", stdoutBound, run.stdout, input.spill)
    );
  }
  if (stderrBound.truncated) {
    notices.push(
      await truncationNotice("stderr", stderrBound, run.stderr, input.spill)
    );
  }

  return {
    command: input.command,
    error: errorFor(run),
    exitCode: run.exitCode,
    notice: notices.length === 0 ? undefined : notices.join("\n"),
    stderr: stderrBound.text,
    stdout: stdoutBound.text,
    timedOut: run.killedBy === "timeout",
    timeoutMs: input.timeoutMs,
    truncated:
      stdoutBound.truncated ||
      stderrBound.truncated ||
      run.stdoutDropped ||
      run.stderrDropped,
    wallTimeMs: run.wallTimeMs,
  };
}

/**
 * Run one command to completion, a timeout, or an abort.
 *
 * A non-zero exit code is an ordinary result: the caller asked for a command to
 * be run, and "it failed, here is why" is the answer, not an exception.
 */
export async function runCommand(options: BashOptions): Promise<BashResult> {
  const cwd = options.cwd ?? process.cwd();
  const timeoutMs = Math.min(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS
  );

  const run = await collectCommand({
    command: options.command,
    cwd: options.workdir === undefined ? cwd : resolve(cwd, options.workdir),
    signal: options.signal,
    timeoutMs,
  });

  return await summarize(run, {
    command: options.command,
    spill: options.spill,
    timeoutMs,
  });
}

export function createBashTool(
  input: { cwd?: string | undefined; spill?: Spill | undefined } = {}
) {
  return createTool({
    description: `Execute shell commands on the user's system.
Supports any command available in the system shell.
Returns stdout, stderr, and the exit code; a non-zero exit is a result, not an error.
Non-interactive: stdin is closed, so a command that waits for input cannot be answered.
Every command is bounded by a timeout, and long output is truncated with the bound stated.
Be careful with destructive commands — seek permission for rm -rf, sudo, etc.`,
    execute: async (args, context) =>
      await runCommand({
        command: args.command,
        cwd: input.cwd,
        signal: context.abortSignal,
        spill: input.spill,
        timeoutMs: args.timeout,
        workdir: args.workdir,
      }),
    id: "bash",
    inputSchema: BashInputSchema,
    outputSchema: BashResultSchema,
  });
}
