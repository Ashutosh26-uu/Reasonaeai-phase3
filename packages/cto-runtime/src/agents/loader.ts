import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, normalize, relative, resolve } from "node:path";
import { parseAgentFrontmatter, parseModelRef } from "./frontmatter.js";
import type { AgentDefinition, AgentDiagnostic } from "./types.js";

export interface LoadedAgentFile {
  definition: AgentDefinition;
  sourcePath: string;
}

export interface LoadAgentsFromDirsResult {
  agents: LoadedAgentFile[];
  diagnostics: AgentDiagnostic[];
}

const MARKDOWN_EXTENSION = ".md";
const MARKDOWN_SUFFIX_PATTERN = /\.md$/i;

/** Windows path comparison is case-insensitive. */
function pathKey(value: string): string {
  const key = normalize(value);
  return process.platform === "win32" ? key.toLowerCase() : key;
}

async function collectMarkdownFiles(dir: string): Promise<string[]> {
  let entries: Dirent[];

  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // A missing directory is normal: most projects have no agents of their own.
    return [];
  }

  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        return await collectMarkdownFiles(full);
      }
      if (
        entry.isFile() &&
        entry.name.toLowerCase().endsWith(MARKDOWN_EXTENSION)
      ) {
        return [full];
      }
      return [];
    })
  );

  return nested.flat();
}

/** Every directory from the start directory up to the home directory. */
function ancestorBases(startDir: string): string[] {
  const dirs: string[] = [];
  const home = resolve(homedir());
  let current = resolve(startDir);

  for (;;) {
    dirs.push(current);
    if (current === home) {
      break;
    }
    const parent = resolve(current, "..");
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return dirs;
}

/** Where the user's globally installed agents live. */
function globalAgentsDir(): string {
  return join(homedir(), ".reasonate", "agents");
}

/**
 * Discovery order, lowest priority first:
 *
 * 1. `~/.reasonate/agents`
 * 2. `.claude/agents`, outermost directory inward, so agents authored for
 *    another harness still load
 * 3. `.reasonate/agents`, outermost directory inward
 *
 * Later entries win a name collision, so the nearest project definition wins
 * over a parent's, and this harness's own directory wins over the
 * compatibility one at the same depth.
 */
export function discoverAgentDirs(cwd: string): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();

  const push = (path: string) => {
    const key = pathKey(path);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    dirs.push(path);
  };

  push(globalAgentsDir());

  // `ancestorBases` walks inward to outward; reversing makes the working
  // directory the last entry, which is the one that wins.
  const outward = [...ancestorBases(cwd)].reverse();

  for (const base of outward) {
    push(join(base, ".claude", "agents"));
  }
  for (const base of outward) {
    push(join(base, ".reasonate", "agents"));
  }

  return dirs;
}

interface ReadAgentFileResult {
  agent?: LoadedAgentFile;
  diagnostics: AgentDiagnostic[];
}

async function readAgentFile(filePath: string): Promise<ReadAgentFileResult> {
  let raw: string;

  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      return { diagnostics: [] };
    }
    raw = await readFile(filePath, "utf-8");
  } catch {
    // An unreadable file is skipped; one bad file must not abort discovery.
    return { diagnostics: [] };
  }

  const parsed = parseAgentFrontmatter(raw, filePath);
  const { frontmatter } = parsed;

  // A definition without a name or description cannot be selected or explained,
  // so it is not a usable agent.
  if (!(frontmatter?.name && frontmatter.description)) {
    return { diagnostics: parsed.diagnostics };
  }

  return {
    agent: {
      definition: {
        blocking: frontmatter.blocking,
        color: frontmatter.color,
        description: frontmatter.description,
        disallowedTools: frontmatter.disallowedTools,
        hidden: frontmatter.hidden,
        maxTurns: frontmatter.maxTurns,
        mode: frontmatter.mode ?? "subagent",
        model: parseModelRef(frontmatter.model),
        name: frontmatter.name,
        output: frontmatter.output,
        prompt: parsed.body,
        readSummarize: frontmatter.readSummarize,
        reporting: frontmatter.reporting,
        source: filePath,
        spawns: frontmatter.spawns,
        temperature: frontmatter.temperature,
        thinkingLevel: frontmatter.thinkingLevel,
        tools: frontmatter.tools,
      },
      sourcePath: filePath,
    },
    diagnostics: parsed.diagnostics,
  };
}

export async function loadAgentsFromDir(
  dir: string
): Promise<LoadAgentsFromDirsResult> {
  const files = await collectMarkdownFiles(dir);
  const results = await Promise.all(
    files.map(async (filePath) => await readAgentFile(filePath))
  );

  const agents: LoadedAgentFile[] = [];
  const diagnostics: AgentDiagnostic[] = [];

  for (const result of results) {
    diagnostics.push(...result.diagnostics);
    if (result.agent) {
      agents.push(result.agent);
    }
  }

  return { agents, diagnostics };
}

/** Loads every discovered agent, with the nearest directory winning a name. */
export async function loadDiscoveredAgents(
  cwd: string
): Promise<LoadAgentsFromDirsResult> {
  const perDir = await Promise.all(
    discoverAgentDirs(cwd).map(async (dir) => await loadAgentsFromDir(dir))
  );

  const diagnostics: AgentDiagnostic[] = [];
  const byName = new Map<string, LoadedAgentFile>();

  // Applied in discovery order, so the last directory to define a name wins.
  for (const result of perDir) {
    diagnostics.push(...result.diagnostics);
    for (const agent of result.agents) {
      byName.set(agent.definition.name, agent);
    }
  }

  return { agents: [...byName.values()], diagnostics };
}

/** Derives an agent name from its path, for files that omit `name`. */
export function agentNameFromPath(
  filePath: string,
  agentsRoot: string
): string {
  return relative(agentsRoot, filePath)
    .replaceAll("\\", "/")
    .replace(MARKDOWN_SUFFIX_PATTERN, "");
}
