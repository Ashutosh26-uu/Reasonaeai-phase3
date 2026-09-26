import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BuildSessionId } from "@reasonateai/contracts/execution";
import {
  type OrganizationId,
  OrganizationIdSchema,
  type ProjectId,
  ProjectIdSchema,
  type RunId,
} from "@reasonateai/contracts/identity";
import type {
  ISandbox,
  RunCommandRequest,
  RunCommandResult,
} from "@reasonateai/contracts/sandbox";

/**
 * Durable Git checkpoints for a sandbox workspace.
 *
 * A checkpoint is a `git bundle` of the workspace, so a restore reproduces the
 * whole history rather than a file listing. Bundles are keyed by organization
 * and project and the key is part of the checkpoint id: another tenant's id
 * resolves outside this tenant's directory and therefore cannot be read.
 */

/** The slice of the sandbox contract a checkpoint operation needs. */
export type CheckpointSandbox = Pick<ISandbox, "runCommand" | "writeFile">;

export interface CheckpointScope {
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
}

export interface CheckpointWriteInput extends CheckpointScope {
  readonly buildSessionId: BuildSessionId;
  readonly content: Uint8Array;
  readonly runId: RunId;
}

export interface CheckpointReference {
  readonly checkpointId: string;
  readonly digest: string;
}

export interface CheckpointWriteResult extends CheckpointReference {
  readonly bytes: number;
}

export interface CheckpointStore {
  readonly latest: (
    input: CheckpointScope
  ) => Promise<CheckpointReference | undefined>;
  readonly read: (checkpointId: string) => Promise<Uint8Array>;
  readonly write: (
    input: CheckpointWriteInput
  ) => Promise<CheckpointWriteResult>;
}

/**
 * Written next to every bundle. The bytes are the checkpoint; the manifest is
 * what correlates it with the session and run that produced it.
 */
interface CheckpointManifest {
  readonly buildSessionId: string;
  readonly bytes: number;
  readonly digest: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly recordedAt: string;
  readonly runId: string;
}

export interface GitCheckpointStoreOptions {
  /** Directory that holds every tenant's bundles. */
  readonly root: string;
}

const BUNDLE_SUFFIX = ".bundle";
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MANIFEST_SUFFIX = ".json";

/** Default working directory of a build sandbox. */
const DEFAULT_WORKDIR = "/workspace";
/** Staging directory a restore writes into before the workspace owns it. */
const STAGING_DIRECTORY = ".reasonate";
const STAGED_BUNDLE_PATH = `${STAGING_DIRECTORY}/checkpoint.bundle`;
const CHECKPOINT_COMMIT_MESSAGE = "ReasonateAI workspace checkpoint";
const GIT_BUNDLE_HEADER = /^# v[23] git bundle/;
/**
 * The sandbox has no network, so the bundle leaves over stdout. `-w0` is not
 * portable across the `base64` builds an image may carry, so the newlines are
 * stripped instead.
 */
const GIT_BUNDLE_COMMAND = "git bundle create - --all | base64 | tr -d '\\n'";
/**
 * A commit without an identity is refused, and the sandbox has no configured
 * one; the values are the checkpoint's, not a person's.
 */
const GIT_IDENTITY_ENV = {
  GIT_AUTHOR_EMAIL: "checkpoints@reasonate.ai",
  GIT_AUTHOR_NAME: "ReasonateAI Checkpoints",
  GIT_COMMITTER_EMAIL: "checkpoints@reasonate.ai",
  GIT_COMMITTER_NAME: "ReasonateAI Checkpoints",
};

export function createGitCheckpointStore(
  options: GitCheckpointStoreOptions
): CheckpointStore {
  const root = resolve(options.root);

  return {
    latest: async (input) => {
      const directory = tenantDirectoryFor(root, input);
      const entries = await readDirectory(directory);
      if (entries === undefined) {
        return;
      }

      const newest = await newestManifestIn(directory, entries, 0, undefined);
      if (newest === undefined) {
        return;
      }
      return {
        checkpointId: checkpointIdFor(input, newest.digest),
        digest: newest.digest,
      };
    },

    read: async (checkpointId) => {
      const { digest, organizationId, projectId } =
        parseCheckpointId(checkpointId);
      const bundlePath = join(
        tenantDirectoryFor(root, { organizationId, projectId }),
        `${digest}${BUNDLE_SUFFIX}`
      );

      const content = await readBundle(bundlePath, checkpointId);
      const actualDigest = digestOf(content);
      if (actualDigest !== digest) {
        throw new Error(
          `Checkpoint digest mismatch for ${checkpointId}: expected ${digest}, found ${actualDigest}.`
        );
      }
      return content;
    },

    write: async (input) => {
      const digest = digestOf(input.content);
      const directory = tenantDirectoryFor(root, input);
      await mkdir(directory, { recursive: true });
      await writeAtomically(
        join(directory, `${digest}${BUNDLE_SUFFIX}`),
        input.content
      );

      const manifest: CheckpointManifest = {
        buildSessionId: input.buildSessionId,
        bytes: input.content.byteLength,
        digest,
        organizationId: input.organizationId,
        projectId: input.projectId,
        recordedAt: new Date().toISOString(),
        runId: input.runId,
      };
      await writeAtomically(
        join(directory, `${digest}${MANIFEST_SUFFIX}`),
        JSON.stringify(manifest)
      );

      return {
        bytes: input.content.byteLength,
        checkpointId: checkpointIdFor(input, digest),
        digest,
      };
    },
  };
}

export interface SnapshotSandboxInput extends CheckpointScope {
  readonly buildSessionId: BuildSessionId;
  readonly runId: RunId;
  readonly sandbox: CheckpointSandbox;
  readonly store: CheckpointStore;
  readonly workdir?: string;
}

/**
 * Commits the workspace inside the sandbox and stores the resulting bundle.
 * The history is created here rather than on the host because the workspace
 * only exists inside the sandbox.
 */
export async function snapshotSandbox(
  input: SnapshotSandboxInput
): Promise<CheckpointWriteResult> {
  const workdir = input.workdir ?? DEFAULT_WORKDIR;
  const { sandbox } = input;

  // A restore that failed midway can leave staging behind; committing it would
  // put a checkpoint's own staging file into the next checkpoint.
  await runChecked(sandbox, workdir, "rm", ["-rf", STAGING_DIRECTORY]);
  await runChecked(sandbox, workdir, "git", ["init", "-q"]);
  await runChecked(sandbox, workdir, "git", ["add", "-A"]);
  await runChecked(
    sandbox,
    workdir,
    "git",
    ["commit", "--allow-empty", "-q", "-m", CHECKPOINT_COMMIT_MESSAGE],
    GIT_IDENTITY_ENV
  );
  const bundled = await runChecked(sandbox, workdir, "sh", [
    "-c",
    GIT_BUNDLE_COMMAND,
  ]);

  return input.store.write({
    buildSessionId: input.buildSessionId,
    content: decodeBundle(bundled.stdout),
    organizationId: input.organizationId,
    projectId: input.projectId,
    runId: input.runId,
  });
}

export interface RestoreSandboxInput {
  readonly checkpointId: string;
  readonly sandbox: CheckpointSandbox;
  readonly store: CheckpointStore;
  readonly workdir?: string;
}

/**
 * Materializes a stored bundle into a freshly created sandbox. The bundle is
 * fetched rather than cloned so the workspace stays the sandbox's working
 * directory, and the working tree is reset onto the fetched commit so the
 * history stays reachable from a branch.
 */
export async function restoreSandbox(
  input: RestoreSandboxInput
): Promise<void> {
  const workdir = input.workdir ?? DEFAULT_WORKDIR;
  const { sandbox } = input;
  const stagedPath = toWorkspaceRelativePath(STAGED_BUNDLE_PATH);

  const content = await input.store.read(input.checkpointId);
  await sandbox.writeFile(stagedPath, content);

  try {
    await runChecked(sandbox, workdir, "git", ["init", "-q"]);
    // Fetching the bundle's HEAD rather than its branches leaves the working
    // tree on the sandbox's own branch, which is also the branch the next
    // snapshot has to commit to.
    await runChecked(sandbox, workdir, "git", [
      "fetch",
      "-q",
      stagedPath,
      "HEAD",
    ]);
    await runChecked(sandbox, workdir, "git", [
      "reset",
      "-q",
      "--hard",
      "FETCH_HEAD",
    ]);
  } finally {
    await runChecked(sandbox, workdir, "rm", ["-rf", STAGING_DIRECTORY]);
  }
}

/** The id carries the tenant, which is what scopes a read to one directory. */
function checkpointIdFor(scope: CheckpointScope, digest: string): string {
  return `${scope.organizationId}.${scope.projectId}.${digest}`;
}

function parseCheckpointId(checkpointId: string): {
  digest: string;
  organizationId: OrganizationId;
  projectId: ProjectId;
} {
  const segments = checkpointId.split(".");
  const [rawOrganizationId, rawProjectId, digest] = segments;
  if (
    segments.length !== 3 ||
    rawOrganizationId === undefined ||
    rawProjectId === undefined ||
    digest === undefined
  ) {
    throw new Error(`Malformed checkpoint id: ${checkpointId}`);
  }

  const organizationId = OrganizationIdSchema.safeParse(rawOrganizationId);
  const projectId = ProjectIdSchema.safeParse(rawProjectId);
  if (
    !(
      organizationId.success &&
      projectId.success &&
      DIGEST_PATTERN.test(digest)
    )
  ) {
    throw new Error(`Malformed checkpoint id: ${checkpointId}`);
  }

  return {
    digest,
    organizationId: organizationId.data,
    projectId: projectId.data,
  };
}

/**
 * The tenant is a path segment, so it is revalidated here: a caller that
 * forged a branded identifier must not be able to aim a write or a read at
 * another organization's directory.
 */
function tenantDirectoryFor(root: string, scope: CheckpointScope): string {
  const organizationId = OrganizationIdSchema.safeParse(scope.organizationId);
  const projectId = ProjectIdSchema.safeParse(scope.projectId);
  if (!(organizationId.success && projectId.success)) {
    throw new Error(
      "A checkpoint requires a valid organization and project identifier."
    );
  }
  return join(root, organizationId.data, projectId.data);
}

function digestOf(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

async function writeAtomically(
  targetPath: string,
  content: string | Uint8Array
): Promise<void> {
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content);
  await rename(temporaryPath, targetPath);
}

async function readBundle(
  bundlePath: string,
  checkpointId: string
): Promise<Uint8Array> {
  try {
    return await readFile(bundlePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Checkpoint not found: ${checkpointId}`, {
        cause: error,
      });
    }
    throw error;
  }
}

async function readDirectory(directory: string): Promise<string[] | undefined> {
  try {
    return await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/**
 * Walks a tenant directory one manifest at a time, keeping the newest seen; a
 * tenant directory grows with every checkpoint, so the reads stay sequential.
 */
async function newestManifestIn(
  directory: string,
  entries: readonly string[],
  index: number,
  newest: CheckpointManifest | undefined
): Promise<CheckpointManifest | undefined> {
  const entry = entries[index];
  if (entry === undefined) {
    return newest;
  }

  let found: CheckpointManifest | undefined;
  if (entry.endsWith(MANIFEST_SUFFIX)) {
    const path = join(directory, entry);
    found = parseManifest(await readFile(path, "utf-8"), path);
  }

  const next =
    found !== undefined && (newest === undefined || isNewer(found, newest))
      ? found
      : newest;
  return newestManifestIn(directory, entries, index + 1, next);
}

function isNewer(candidate: CheckpointManifest, current: CheckpointManifest) {
  if (candidate.recordedAt !== current.recordedAt) {
    return candidate.recordedAt > current.recordedAt;
  }
  // Two checkpoints can share a millisecond; the digest keeps the choice stable.
  return candidate.digest > current.digest;
}

function parseManifest(raw: string, source: string): CheckpointManifest {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Malformed checkpoint manifest: ${source}`);
  }

  const record = parsed as Record<string, unknown>;
  const {
    buildSessionId,
    bytes,
    digest,
    organizationId,
    projectId,
    recordedAt,
    runId,
  } = record;
  if (
    typeof buildSessionId !== "string" ||
    typeof bytes !== "number" ||
    typeof digest !== "string" ||
    !DIGEST_PATTERN.test(digest) ||
    typeof organizationId !== "string" ||
    typeof projectId !== "string" ||
    typeof recordedAt !== "string" ||
    typeof runId !== "string"
  ) {
    throw new Error(`Malformed checkpoint manifest: ${source}`);
  }

  return {
    buildSessionId,
    bytes,
    digest,
    organizationId,
    projectId,
    recordedAt,
    runId,
  };
}

async function runChecked(
  sandbox: CheckpointSandbox,
  workdir: string,
  command: string,
  args: string[],
  env?: Record<string, string>
): Promise<RunCommandResult> {
  const request: RunCommandRequest =
    env === undefined
      ? { args, command, cwd: workdir }
      : { args, command, cwd: workdir, env };

  const result = await sandbox.runCommand(request);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "no output";
    throw new Error(
      `Sandbox command failed: ${command} ${args.join(" ")}\n${detail}`
    );
  }
  return result;
}

function decodeBundle(stdout: string): Uint8Array {
  const encoded = stdout.replaceAll(/\s/g, "");
  if (encoded === "") {
    throw new Error("The sandbox returned an empty workspace bundle.");
  }

  const content = Buffer.from(encoded, "base64");
  if (!GIT_BUNDLE_HEADER.test(content.toString("utf-8", 0, 32))) {
    throw new Error(
      "The sandbox did not return a Git bundle on the command's stdout."
    );
  }
  return content;
}

/**
 * Checkpoint paths are written through the sandbox contract, which resolves
 * them against the workspace. Rejecting anything that is not a plain relative
 * path keeps a crafted path from reaching outside that workspace.
 */
function toWorkspaceRelativePath(relativePath: string): string {
  if (relativePath.startsWith("/") || relativePath.includes("\\")) {
    throw new Error(`Unsafe workspace path: ${relativePath}`);
  }

  const segments = relativePath.split("/");
  const unsafe = segments.some(
    (segment) => segment === "" || segment === "." || segment === ".."
  );
  if (unsafe) {
    throw new Error(`Unsafe workspace path: ${relativePath}`);
  }
  return segments.join("/");
}
