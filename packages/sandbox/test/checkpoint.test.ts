import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { BuildSessionId } from "@reasonateai/contracts/execution";
import type {
  OrganizationId,
  ProjectId,
  RunId,
} from "@reasonateai/contracts/identity";
import type {
  RunCommandRequest,
  RunCommandResult,
} from "@reasonateai/contracts/sandbox";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  type CheckpointSandbox,
  type CheckpointWriteResult,
  createGitCheckpointStore,
  restoreSandbox,
  snapshotSandbox,
} from "../src/checkpoint.js";

const execFileAsync = promisify(execFile);

const SANDBOX_WORKDIR = "/workspace";

const organizationId = "11111111-1111-4111-8111-111111111111" as OrganizationId;
const otherOrganizationId =
  "33333333-3333-4333-8333-333333333333" as OrganizationId;
const projectId = "22222222-2222-4222-8222-222222222222" as ProjectId;
const buildSessionId = "44444444-4444-4444-8444-444444444444" as BuildSessionId;
const runId = "55555555-5555-4555-8555-555555555555" as RunId;

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MALFORMED_PATTERN = /malformed/i;
const MISMATCH_PATTERN = /digest mismatch/i;
const NOT_FOUND_PATTERN = /not found/i;

const temporaryDirectories: string[] = [];

/**
 * A sandbox whose command API is a real shell over a host directory. Commands
 * and the bundle therefore cross the same boundary they cross in a container
 * — the bundle leaves as base64 text on stdout — while needing no daemon.
 */
class FixtureSandbox implements CheckpointSandbox {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  readonly runCommand = async (
    request: RunCommandRequest
  ): Promise<RunCommandResult> => {
    if (request.cwd !== undefined && request.cwd !== SANDBOX_WORKDIR) {
      throw new Error(`Unexpected sandbox working directory: ${request.cwd}`);
    }

    const startedAt = performance.now();
    try {
      const { stderr, stdout } = await execFileAsync(
        request.command,
        request.args,
        {
          cwd: this.directory,
          env: { ...process.env, ...request.env },
        }
      );
      return {
        durationMs: Math.round(performance.now() - startedAt),
        exitCode: 0,
        stderr: stderr.toString(),
        stdout: stdout.toString(),
        timedOut: false,
      };
    } catch (error) {
      const failure = error as {
        code?: number | string;
        stderr?: unknown;
        stdout?: unknown;
      };
      return {
        durationMs: Math.round(performance.now() - startedAt),
        exitCode: typeof failure.code === "number" ? failure.code : 1,
        stderr: String(failure.stderr ?? ""),
        stdout: String(failure.stdout ?? ""),
        timedOut: false,
      };
    }
  };

  readonly writeFile = async (
    relativePath: string,
    content: string | Uint8Array
  ): Promise<void> => {
    const target = resolve(this.directory, relativePath);
    if (
      target !== this.directory &&
      !target.startsWith(`${this.directory}${sep}`)
    ) {
      throw new Error("Path traversal detected outside sandbox workspace");
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  };
}

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

/** Asserts the stored bytes of every expected file in a restored directory. */
async function expectRestoredFiles(
  directory: string,
  files: Record<string, string>
): Promise<void> {
  await Promise.all(
    Object.entries(files).map(async ([path, expected]) => {
      const actual = await readFile(join(directory, path), "utf-8");
      // The host's git may check out CRLF; the stored bytes are what matter.
      expect(actual.replaceAll("\r\n", "\n"), path).toBe(expected);
    })
  );
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

describe("createGitCheckpointStore", () => {
  it("round-trips a checkpoint and reports it as the latest", async () => {
    const root = await createTemporaryDirectory("reasonate-checkpoints-");
    const store = createGitCheckpointStore({ root });
    const content = new TextEncoder().encode("first checkpoint bytes");

    const written = await store.write({
      buildSessionId,
      content,
      organizationId,
      projectId,
      runId,
    });

    expect(written.bytes).toBe(content.byteLength);
    expect(written.digest).toMatch(DIGEST_PATTERN);
    expect(written.checkpointId).toBe(
      `${organizationId}.${projectId}.${written.digest}`
    );
    await expect(store.read(written.checkpointId)).resolves.toEqual(
      Buffer.from(content)
    );
    await expect(store.latest({ organizationId, projectId })).resolves.toEqual({
      checkpointId: written.checkpointId,
      digest: written.digest,
    });
  });

  it("reports the most recently recorded checkpoint as the latest", async () => {
    const root = await createTemporaryDirectory("reasonate-checkpoints-");
    const store = createGitCheckpointStore({ root });

    const written: CheckpointWriteResult[] = [];
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      written.push(
        await store.write({
          buildSessionId,
          content: new TextEncoder().encode("earlier"),
          organizationId,
          projectId,
          runId,
        })
      );
      vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));
      written.push(
        await store.write({
          buildSessionId,
          content: new TextEncoder().encode("later"),
          organizationId,
          projectId,
          runId,
        })
      );
    } finally {
      vi.useRealTimers();
    }

    const [earlier, later] = written;
    const latest = await store.latest({ organizationId, projectId });
    expect(later?.checkpointId).not.toBe(earlier?.checkpointId);
    expect(latest?.checkpointId).toBe(later?.checkpointId);
  });

  it("rejects a bundle whose bytes no longer match its digest", async () => {
    const root = await createTemporaryDirectory("reasonate-checkpoints-");
    const store = createGitCheckpointStore({ root });
    const written = await store.write({
      buildSessionId,
      content: new TextEncoder().encode("untampered"),
      organizationId,
      projectId,
      runId,
    });

    await writeFile(
      join(root, organizationId, projectId, `${written.digest}.bundle`),
      "tampered"
    );

    await expect(store.read(written.checkpointId)).rejects.toThrow(
      MISMATCH_PATTERN
    );
  });

  it("keeps one organization's checkpoints outside another's scope", async () => {
    const root = await createTemporaryDirectory("reasonate-checkpoints-");
    const store = createGitCheckpointStore({ root });
    const written = await store.write({
      buildSessionId,
      content: new TextEncoder().encode("private to the first tenant"),
      organizationId,
      projectId,
      runId,
    });

    await expect(
      store.latest({ organizationId: otherOrganizationId, projectId })
    ).resolves.toBeUndefined();
    await expect(
      store.read(`${otherOrganizationId}.${projectId}.${written.digest}`)
    ).rejects.toThrow(NOT_FOUND_PATTERN);
    await expect(store.read("../escape")).rejects.toThrow(MALFORMED_PATTERN);
    await expect(
      store.read(`not-a-uuid.${projectId}.${written.digest}`)
    ).rejects.toThrow(MALFORMED_PATTERN);
  });
});

const shellAvailable = await execFileAsync("sh", [
  "-c",
  "git --version > /dev/null && command -v base64 > /dev/null",
]).then(
  () => true,
  () => false
);

describe.skipIf(!shellAvailable)("snapshotSandbox and restoreSandbox", () => {
  it("moves a workspace through a real git bundle into a fresh sandbox", async () => {
    const sourceDirectory = await createTemporaryDirectory("reasonate-source-");
    const restoredDirectory = await createTemporaryDirectory(
      "reasonate-restored-"
    );
    const chainedDirectory = await createTemporaryDirectory("reasonate-chain-");
    const root = await createTemporaryDirectory("reasonate-checkpoints-");
    const store = createGitCheckpointStore({ root });
    const source = new FixtureSandbox(sourceDirectory);

    const expectedFiles = {
      "docs/notes with spaces.txt": "spaced\n",
      "README.md": "reasonate\n",
      "src/index.ts": "export const answer = 42;\n",
    };
    await Promise.all(
      Object.entries(expectedFiles).map(([path, content]) =>
        source.writeFile(path, content)
      )
    );

    const written = await snapshotSandbox({
      buildSessionId,
      organizationId,
      projectId,
      runId,
      sandbox: source,
      store,
      workdir: SANDBOX_WORKDIR,
    });

    expect(written.bytes).toBeGreaterThan(0);
    const bundle = await store.read(written.checkpointId);
    expect(Buffer.from(bundle).toString("utf-8", 0, 20)).toContain(
      "git bundle"
    );

    const restored = new FixtureSandbox(restoredDirectory);
    await restoreSandbox({
      checkpointId: written.checkpointId,
      sandbox: restored,
      store,
      workdir: SANDBOX_WORKDIR,
    });

    await expectRestoredFiles(restoredDirectory, expectedFiles);
    await expect(stat(join(restoredDirectory, ".reasonate"))).rejects.toThrow();

    // A restored workspace must be checkpointable again, so the snapshot of a
    // restored tree has to reach the history it just fetched.
    await restored.writeFile("CHANGELOG.md", "second generation\n");
    const chained = await snapshotSandbox({
      buildSessionId,
      organizationId,
      projectId,
      runId,
      sandbox: restored,
      store,
      workdir: SANDBOX_WORKDIR,
    });

    const chainedSandbox = new FixtureSandbox(chainedDirectory);
    await restoreSandbox({
      checkpointId: chained.checkpointId,
      sandbox: chainedSandbox,
      store,
      workdir: SANDBOX_WORKDIR,
    });

    await expectRestoredFiles(chainedDirectory, {
      ...expectedFiles,
      "CHANGELOG.md": "second generation\n",
    });
    await expect(
      execFileAsync("git", ["log", "--oneline"], { cwd: chainedDirectory })
    ).resolves.toMatchObject({
      stdout: expect.stringContaining("ReasonateAI workspace checkpoint"),
    });
  });
});
