/**
 * The environment block: what the agent knows about where it is running.
 *
 * This is deliberately narrow. It carries facts the agent cannot discover for
 * itself cheaply and that change what a sane action looks like: which directory
 * is the workspace root, whether that root is a Git repository, the platform and
 * shell so commands are written for the right one, and both wall-clock times, so
 * a relative instruction ("last week") and a timestamp in a log can be
 * reconciled.
 *
 * What is deliberately absent: token or context usage, spend, tool result
 * details, and source paths. Those either invite the model to optimise the wrong
 * thing or leak internals it has no use for.
 *
 * ReasonateAI addition over the reference harness: the run identity and the
 * sandbox's capacity. A run that knows it has a shared, resource-bounded sandbox
 * will choose a different strategy than one that assumes unlimited local
 * capacity, and knowing which build session it is serving prevents it from
 * describing another run's state.
 */

import { existsSync } from "node:fs";
import { homedir, arch as hostArch, platform as hostPlatform } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { RunScope } from "../run-scope.js";

/** Measured capacity of the sandbox this run executes in. */
export interface SandboxCapacity {
  /** Logical CPUs available to the sandbox. */
  cpus: number;
  /** Writable space available in bytes, when a quota is enforced. */
  diskBytes?: number | undefined;
  /** Total memory in bytes. */
  memoryBytes: number;
}

/** Platform facts probed once per process: they cannot change during a run. */
export interface PlatformFacts {
  arch: string;
  homeDir: string;
  os: string;
  shell: string;
}

export interface EnvironmentFacts {
  /** Measured sandbox capacity, when the platform can report it. */
  capacity?: SandboxCapacity | undefined;
  /** Directory the run operates in. */
  cwd: string;
  /** Whether `workspaceRoot` is a Git repository. */
  isGitRepo: boolean;
  /** Model identifier as the run configured it. */
  model: string;
  /** Current wall-clock time, injected so the block is deterministic in tests. */
  now: Date;
  /** Provider identifier, so the exact model id can be named. Absent when the run configures a bare model id. */
  provider?: string | undefined;
  /** Sandbox identifier, correlating this environment with its container. */
  sandboxId: string;
  /** Verified identities this environment belongs to. */
  scope: RunScope;
  /** When this build session's run began. */
  sessionStartedAt: Date;
  /** Repository root, when `cwd` is inside one. */
  workspaceRoot?: string | undefined;
}

/** Probe the facts that are constant for the process. */
export function probePlatformFacts(): PlatformFacts {
  return {
    arch: hostArch(),
    homeDir: homedir(),
    os: normalizeOsName(hostPlatform()),
    shell:
      process.env.SHELL ??
      process.env.ComSpec ??
      (hostPlatform() === "win32" ? "cmd.exe" : "/bin/sh"),
  };
}

function normalizeOsName(platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return "windows";
  }
  if (platform === "darwin") {
    return "macos";
  }
  return platform;
}

/**
 * Walk up from `cwd` to the nearest directory containing `.git`.
 *
 * Returns `undefined` when there is none, which is a real state for a sandbox
 * restored from an archive rather than cloned.
 */
export function findWorkspaceRoot(cwd: string): string | undefined {
  let current = resolve(cwd);

  for (;;) {
    if (existsSync(join(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function formatLocalDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatCapacity(capacity: SandboxCapacity): string[] {
  const lines = [
    `  Sandbox CPUs: ${capacity.cpus}`,
    `  Sandbox memory: ${formatGiB(capacity.memoryBytes)} GiB`,
  ];

  if (capacity.diskBytes !== undefined) {
    lines.push(
      `  Sandbox writable space: ${formatGiB(capacity.diskBytes)} GiB`
    );
  }

  return lines;
}

function formatGiB(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

/**
 * Render the environment block.
 *
 * Capacity lines are omitted rather than defaulted when the platform cannot
 * measure them: a guessed capacity is worse than none, because the agent will
 * size its plan to a number that is not real.
 */
export function renderEnvironment(
  facts: EnvironmentFacts,
  platform: PlatformFacts = probePlatformFacts()
): string {
  const workspaceRoot = facts.workspaceRoot ?? facts.cwd;

  const lines = [
    facts.provider === undefined
      ? `You are powered by the model with ID ${facts.model}.`
      : `You are powered by the model named ${facts.model}. The exact model ID is ${facts.provider}/${facts.model}.`,
    "Here is useful information about the environment you are running in:",
    "<env>",
    `  Working directory: ${facts.cwd}`,
    `  Workspace root folder: ${workspaceRoot}`,
    `  Is directory a git repo: ${facts.isGitRepo ? "yes" : "no"}`,
    `  Platform: ${platform.os} (${platform.arch})`,
    `  Default shell: ${platform.shell}`,
    `  Home directory: ${platform.homeDir}`,
    `  Session began: ${facts.sessionStartedAt.toISOString()}`,
    `  Today's date: ${formatLocalDate(facts.now)}`,
    `  Organization: ${facts.scope.organizationId}`,
    `  Project: ${facts.scope.projectId}`,
    `  Build session: ${facts.scope.buildSessionId}`,
    `  Run: ${facts.scope.runId}`,
    `  Sandbox: ${facts.sandboxId}`,
  ];

  if (facts.capacity !== undefined) {
    lines.push(...formatCapacity(facts.capacity));
  }

  lines.push("</env>");

  return lines.join("\n");
}
