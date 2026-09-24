/**
 * Per-run artifact storage.
 *
 * When a tool produces more output than is useful to put in the model's context,
 * the full text is written here and the model receives a short preview plus an
 * `artifact://<id>` handle. The model can then read the parts it needs, one page
 * at a time, instead of every later turn carrying output it has already finished
 * with.
 *
 * Two properties are load-bearing:
 *
 * 1. **Run-scoped, path-nested.** The directory is derived from the verified run
 *    scope and nests organization, project, build session, and run as separate
 *    path segments. Nesting means a lookup bug cannot cross a tenant boundary:
 *    there is no sibling directory that another organization's artifacts could
 *    be reached through. The run identifier is part of the path because the same
 *    build session runs repeatedly, and one run's spilled output must not be
 *    mistaken for another's.
 * 2. **Identifiers are per-run counters.** Ids are dense integers assigned in
 *    write order, so `artifact://0` is unambiguous and the error for a missing id
 *    can list exactly which ids exist.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { RunScope } from "../run-scope.js";

/** Content read back from a store. The identifier is the caller's, not the stored value's. */
export interface StoredArtifact {
  content: string;
  path: string;
}

export interface ArtifactStore {
  /** Absolute directory holding this run's artifacts. */
  readonly directory: string;
  /** Identifiers present, ascending. */
  list: () => Promise<number[]>;
  /** Read one artifact by identifier, or `undefined` when it does not exist. */
  read: (id: number) => Promise<StoredArtifact | undefined>;
  /** Write text and return the identifier assigned to it. */
  write: (content: string, extension?: string) => Promise<number>;
}

/** Filesystem-safe form of a scope identifier. */
function segment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_.-]/g, "-");
}

/**
 * The artifact directory for one run.
 *
 * Exported so the route layer, the sandbox, and retention jobs all agree on the
 * same location rather than each deriving it.
 */
export function runArtifactsDir(root: string, scope: RunScope): string {
  return resolve(
    root,
    "artifacts",
    segment(scope.organizationId),
    segment(scope.projectId),
    segment(scope.buildSessionId),
    segment(scope.runId)
  );
}

const DEFAULT_EXTENSION = "txt";
const LEADING_DOT_RE = /^\./;
const SAFE_EXTENSION_RE = /^[a-zA-Z0-9]+$/;
const AGENT_OUTPUT_FILE_RE = /^([A-Za-z0-9_-]+)\.md$/;
const ARTIFACT_FILE_RE = /^(\d+)\.([a-zA-Z0-9]+)$/;

/** Reject an extension that could escape the filename or hide the real type. */
function normalizeExtension(extension: string | undefined): string {
  const candidate = (extension ?? DEFAULT_EXTENSION).replace(
    LEADING_DOT_RE,
    ""
  );
  if (!SAFE_EXTENSION_RE.test(candidate)) {
    return DEFAULT_EXTENSION;
  }
  return candidate;
}

/**
 * Create the artifact store for a run.
 *
 * The directory is created lazily on first write, so starting a run does not
 * create empty directories for work that never happens.
 */
export function createArtifactStore(
  root: string,
  scope: RunScope
): ArtifactStore {
  const directory = runArtifactsDir(root, scope);

  const listIds = async (): Promise<{ id: number; name: string }[]> => {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      // An absent directory means nothing has been spilled yet, which is the
      // normal state at the start of a run.
      return [];
    }

    const ids: { id: number; name: string }[] = [];
    for (const name of names) {
      const match: RegExpExecArray | null = ARTIFACT_FILE_RE.exec(name);
      if (match !== null) {
        ids.push({ id: Number.parseInt(match[1] as string, 10), name });
      }
    }
    return ids.sort((left, right) => left.id - right.id);
  };

  return {
    directory,

    async list(): Promise<number[]> {
      return (await listIds()).map((entry) => entry.id);
    },

    async read(id: number): Promise<StoredArtifact | undefined> {
      const match = (await listIds()).find((entry) => entry.id === id);
      if (match === undefined) {
        return undefined;
      }
      const path = join(directory, match.name);
      return { content: await readFile(path, "utf-8"), path };
    },

    async write(content: string, extension?: string): Promise<number> {
      await mkdir(directory, { recursive: true });

      const existing = await listIds();
      let nextId = 0;
      for (const entry of existing) {
        if (entry.id >= nextId) {
          nextId = entry.id + 1;
        }
      }
      const name = `${nextId}.${normalizeExtension(extension)}`;

      await writeFile(join(directory, name), content, "utf-8");
      return nextId;
    },
  };
}

/**
 * Agent outputs: what a delegated worker produced, addressed by output id.
 *
 * Kept in its own directory rather than mixed with spilled tool output, so an
 * `agent://` id and an `artifact://` id can never resolve to each other's file
 * and the two namespaces stay independently enumerable.
 *
 * Ids here are names, not counters, because a worker is addressed by the label
 * the orchestrator gave it (`reviewer_0`), which is what a person reading a
 * transcript will recognise.
 */
export interface AgentOutputStore {
  readonly directory: string;
  list: () => Promise<string[]>;
  read: (id: string) => Promise<StoredArtifact | undefined>;
  write: (id: string, content: string) => Promise<void>;
}

/** Filesystem-safe form of an agent output id. */
function outputId(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_-]/g, "-");
}

/** The agent-output directory for one run. */
export function runAgentOutputsDir(root: string, scope: RunScope): string {
  return join(runArtifactsDir(root, scope), "agents");
}

export function createAgentOutputStore(
  root: string,
  scope: RunScope
): AgentOutputStore {
  const directory = runAgentOutputsDir(root, scope);

  const listIds = async (): Promise<string[]> => {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      return [];
    }

    const ids: string[] = [];
    for (const name of names) {
      const match: RegExpExecArray | null = AGENT_OUTPUT_FILE_RE.exec(name);
      if (match !== null) {
        ids.push(match[1] as string);
      }
    }
    return ids.sort((left, right) => left.localeCompare(right));
  };

  return {
    directory,

    async list(): Promise<string[]> {
      return await listIds();
    },

    async read(id: string): Promise<StoredArtifact | undefined> {
      const safe = outputId(id);
      if (!(await listIds()).includes(safe)) {
        return undefined;
      }
      const path = join(directory, `${safe}.md`);
      return { content: await readFile(path, "utf-8"), path };
    },

    async write(id: string, content: string): Promise<void> {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `${outputId(id)}.md`), content, "utf-8");
    },
  };
}
