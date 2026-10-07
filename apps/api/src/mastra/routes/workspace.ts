import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { authorize } from "@reasonateai/auth/authorize";
import type { ApiErrorCode } from "@reasonateai/contracts/api-error";
import {
  type BuildSessionId,
  BuildSessionIdSchema,
} from "@reasonateai/contracts/execution";
import {
  CheckpointDiffSchema,
  type CheckpointFileChange,
  type RunCheckpoint,
  RunCheckpointSchema,
  type RunEventEnvelope,
  type WorkspaceRestoreRequest,
  WorkspaceRestoreRequestSchema,
  WorkspaceRestoreResponseSchema,
} from "@reasonateai/contracts/execution-protocol";
import {
  type OrganizationId,
  OrganizationIdSchema,
  type Permission,
  type ProjectId,
  ProjectIdSchema,
  type RunId,
  RunIdSchema,
  type UserPrincipal,
} from "@reasonateai/contracts/identity";
import {
  type ProjectStateStore,
  type TenantScope,
  WorkspaceRestoreBusyError,
} from "@reasonateai/project-state/postgres";
import {
  type CheckpointReference,
  type CheckpointSandbox,
  type CheckpointStore,
  createGitCheckpointStore,
  parseCheckpointId,
} from "@reasonateai/sandbox/checkpoint";
import { z } from "zod";
import { conversationCheckpoint } from "../conversation-checkpoint";
import { apiErrorResponse, unauthenticatedResponse } from "../principal";
import { checkpointSandboxFor, createBuildSandbox } from "../workspace";
import {
  restoreWorkspace,
  WorkspaceRestoreFailure,
} from "../workspace-restore";
import { auditEvent } from "./auth";
import type { HandlerContext } from "./build-sessions";

/**
 * Workspace source routes.
 *
 * A project's generated source is a private Git checkpoint, not a database
 * row, so this is the one route group that reads the execution plane's durable
 * output instead of the store. It still decides through the same centralized
 * policy as every other project read: a tenant-scoped directory on this host
 * is storage layout, never authorization, and a caller outside the
 * organization is refused rather than handed an empty listing that would read
 * as "this project has produced nothing".
 */

/**
 * Product routes live outside the `/api` prefix on purpose, the same as the
 * other product routes: the ingress denial blocks every built-in Mastra route
 * group under `/api`.
 */
export const WORKSPACE_TREE_PATH =
  "/v1/build-sessions/:buildSessionId/workspace/tree";
export const WORKSPACE_FILE_PATH =
  "/v1/build-sessions/:buildSessionId/workspace/file";
export const WORKSPACE_CHECKPOINT_DIFF_PATH =
  "/v1/build-sessions/:buildSessionId/workspace/checkpoint-diff";
export const WORKSPACE_RESTORE_PATH =
  "/v1/build-sessions/:buildSessionId/workspace/restore";

/**
 * Most entries a listing returns, so one large project cannot turn into an
 * unbounded response.
 */
const CHECKPOINT_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MAX_TREE_ENTRIES = 5000;

/** Largest body this route returns as text. Anything larger is reported binary. */
const MAX_TEXT_BYTES = 256 * 1024;

/**
 * Headroom over the text limit. The size is settled before the body is read;
 * the extra room leaves a read that races a size that changed underneath it to
 * be decided by the size check rather than by a killed process.
 */
const BLOB_READ_LIMIT = MAX_TEXT_BYTES + 64 * 1024;

/** Ceiling for command output that is a listing rather than a file body. */
const GIT_OUTPUT_LIMIT = 8 * 1024 * 1024;

/** Clones kept on this host. Each covers one checkpoint digest. */
const MAX_CLONE_COUNT = 4;

/**
 * The parent of every clone, and the root a deployment overrides so a host
 * with a small system drive can keep checkouts elsewhere.
 */
// Each API process owns its disposable Git-object cache. Checkpoint browsing on
// Windows must not check out filenames (for example npm's cache paths) onto the
// host filesystem, where valid sandbox paths can exceed Windows limits.
const CLONE_ROOT = join(
  tmpdir(),
  "reasonate-source-objects",
  String(process.pid)
);

/**
 * Paths a workspace never exposes: the checkout's own metadata, dependencies,
 * caches, and this product's own staging. A listing drops them and a single
 * file read refuses them, and both compare the path's first segment against
 * this table so the two answers cannot drift apart.
 */
const EXCLUDED_SEGMENTS: Record<string, true> = {
  ".cache": true,
  ".git": true,
  ".npm": true,
  ".reasonate": true,
  node_modules: true,
};

/** A path separator under either platform's spelling. */
const PATH_SEPARATOR = /[\\/]+/;

/** An absolute path under either platform's spelling. */
const ABSOLUTE_PATH = /^(?:[\\/]|[A-Za-z]:)/;

/**
 * The mode and size columns of one `ls-tree -l` record. A tree's size column
 * is `-`, so a directory carries no byte count.
 */
const TREE_MODE_PATTERN = /^\d{6}$/;
const TREE_SIZE_PATTERN = /^(?:-|\d+)$/;

/** The space run between two of an `ls-tree` record's meta columns. */
const TREE_FIELD_SEPARATOR = /\s+/;

/**
 * The wordings `git` uses for a path that is not in the commit. Where it gave
 * up differs, but the client-visible answer is the same one for every one of
 * them.
 */
const MISSING_PATH_MESSAGES =
  /does not exist in|exists on disk, but not in|not a valid object name|invalid object name/i;

/**
 * Maps a contract denial reason to a client-facing code. Insufficient
 * authority and absent membership both surface as `forbidden`, so a denial
 * never reveals whether a resource exists in another tenant.
 */
const DENIAL_BY_REASON: Record<string, ApiErrorCode> = {
  CAPABILITY_EXPIRED: "unauthenticated",
  MEMBERSHIP_PRINCIPAL_MISMATCH: "forbidden",
  ORGANIZATION_MEMBERSHIP_INACTIVE: "forbidden",
  ORGANIZATION_MEMBERSHIP_REQUIRED: "forbidden",
  ORGANIZATION_SCOPE_MISMATCH: "forbidden",
  PERMISSION_DENIED: "forbidden",
  PROJECT_MEMBERSHIP_INACTIVE: "forbidden",
  PROJECT_MEMBERSHIP_REQUIRED: "forbidden",
  PROJECT_SCOPE_MISMATCH: "forbidden",
  SESSION_EXPIRED: "unauthenticated",
  SESSION_REVOKED: "unauthenticated",
  UNAUTHENTICATED: "unauthenticated",
};

const WorkspaceScopeSchema = z.strictObject({
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema,
});

/**
 * A workspace path as a caller states it: relative to the workspace root, with
 * no traversal, no NUL byte, and no first segment this route withholds. The
 * refusal happens here rather than at the checkout, so a crafted path never
 * reaches a command.
 */
function workspacePathSchema(maximum: number) {
  return z
    .string()
    .min(1)
    .max(maximum)
    .refine((path) => !path.includes("\u0000"), {
      message: "A workspace path may not contain a NUL byte.",
    })
    .refine((path) => !ABSOLUTE_PATH.test(path), {
      message: "A workspace path must be relative to the workspace root.",
    })
    .refine((path) => !path.split(PATH_SEPARATOR).includes(".."), {
      message: "A workspace path may not traverse upwards.",
    })
    .refine((path) => !EXCLUDED_SEGMENTS[path.split(PATH_SEPARATOR)[0] ?? ""], {
      message: "That part of the workspace is not exposed.",
    });
}
const WorkspacePathSchema = workspacePathSchema(1024);
const CheckpointPathSchema = workspacePathSchema(4096);

const WorkspaceFileQuerySchema = z.strictObject({
  organizationId: OrganizationIdSchema,
  path: WorkspacePathSchema,
  projectId: ProjectIdSchema,
});
const CheckpointDiffQuerySchema = WorkspaceFileQuerySchema.extend({
  path: CheckpointPathSchema,
  runId: RunIdSchema,
  sequence: z.coerce.number().int().positive(),
});

const WorkspaceEntrySchema = z.strictObject({
  bytes: z.number().int().nonnegative(),
  kind: z.enum(["directory", "file"]),
  path: z.string().min(1).max(4096),
});

const WorkspaceTreeSchema = z.strictObject({
  checkpointId: z.string().max(512),
  commit: z.string().max(128),
  files: z.array(WorkspaceEntrySchema),
  truncated: z.boolean(),
});

/**
 * The text answer. A file is either small enough and printable, or it is
 * reported as binary with no body at all: a partial body of an image or of a
 * minified bundle is not a preview, and a client that frames it as text would
 * be shown noise.
 */
const WorkspaceTextFileSchema = z.strictObject({
  binary: z.literal(false),
  bytes: z.number().int().nonnegative(),
  path: z.string().min(1).max(1024),
  text: z.string(),
  truncated: z.boolean(),
});

const WorkspaceBinaryFileSchema = z.strictObject({
  binary: z.literal(true),
  bytes: z.number().int().nonnegative(),
  path: z.string().min(1).max(1024),
  text: z.literal(""),
});

const WorkspaceFileSchema = z.discriminatedUnion("binary", [
  WorkspaceTextFileSchema,
  WorkspaceBinaryFileSchema,
]);

type WorkspaceFileAnswer = z.infer<typeof WorkspaceFileSchema>;

export interface WorkspaceRouteDeps {
  /**
   * The checkpoint store the workspace reads. Defaults to the host store the
   * worker writes with, so a deployment that changes one changes both.
   */
  checkpoints?: CheckpointStore;
  resolvePrincipal: (input: {
    cookieHeader: string | undefined;
  }) => Promise<UserPrincipal | undefined>;
  resolveSandbox?: (scope: {
    buildSessionId: BuildSessionId;
    organizationId: OrganizationId;
    projectId: ProjectId;
  }) => Promise<CheckpointSandbox> | CheckpointSandbox;
  /**
   * Resolved per request so the store is created only when the authoritative
   * database is configured, and so tests can inject their own.
   */
  store: () => ProjectStateStore;
}

/**
 * Runs `git` through `execFile` with an argument array, never through a shell
 * string, so a path taken from a request can never be read as shell syntax. A
 * non-zero exit is an answer rather than an exception — "this path is not in
 * HEAD" is one of the answers this route owes a caller — so it is returned.
 */
function runGit(
  args: string[],
  maxBuffer: number
): Promise<{ code: number | string; stderr: string; stdout: Buffer }> {
  // `Promise.withResolvers` needs the ES2024 library, which this package does
  // not compile against, so the executor form is the one available here.
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      args,
      { encoding: "buffer", maxBuffer, timeout: 15_000, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({
          code: error?.code ?? 0,
          stderr: stderr.toString("utf8"),
          stdout,
        });
      }
    );
    child.stdin?.end();
  });
}

interface WorkspaceEntry {
  bytes: number;
  kind: "directory" | "file";
  path: string;
}

/**
 * Parses a `ls-tree` listing into the entries the contract carries. The
 * listing is NUL-terminated rather than newline-terminated, so a path is never
 * quoted or escaped and cannot be confused with a record boundary, and the
 * record's own fields are then split on the tab git puts before the path.
 */
function parseTreeRecords(output: string): WorkspaceEntry[] {
  const entries: WorkspaceEntry[] = [];

  for (const record of output.split("\u0000")) {
    if (record.length === 0) {
      continue;
    }

    const separator = record.indexOf("\t");
    if (separator < 0) {
      throw new Error(`Unparseable Git tree record: ${record}`);
    }

    // The meta columns are `<mode> <type> <object> <size>`, space padded. A
    // tree reports `-` for its size, since a directory carries no byte count.
    const [mode, , , size] = record
      .slice(0, separator)
      .split(TREE_FIELD_SEPARATOR);
    const path = record.slice(separator + 1);
    if (
      !(TREE_MODE_PATTERN.test(mode) && TREE_SIZE_PATTERN.test(size)) ||
      path.length === 0
    ) {
      throw new Error(`Unparseable Git tree record: ${record}`);
    }

    entries.push({
      bytes: size === "-" ? 0 : Number(size),
      kind: mode === "040000" ? "directory" : "file",
      path,
    });
  }

  return entries;
}

/**
 * One materialized checkout per checkpoint digest. A bundle is content
 * addressed, so two reads of the same checkpoint share a clone and a different
 * project with the same bytes would share identical content. The cache is
 * bounded: past four clones the oldest is evicted, which keeps the temp
 * directory from growing with every checkpoint this host has ever read. A
 * clone still in flight is never evicted under its own reader.
 */
const clones = new Map<string, { done: () => boolean; job: Promise<string> }>();

/**
 * Seeds a checkout from the stored bundle. The bundle is written to a private
 * temporary directory and removed in the same turn; only the clone outlives
 * the request.
 */
async function cloneFromBundle(input: {
  checkpoints: CheckpointStore;
  checkpointId: string;
  digest: string;
}): Promise<string> {
  const content = await input.checkpoints.read(input.checkpointId);
  await mkdir(CLONE_ROOT, { recursive: true });

  const staging = await mkdtemp(join(tmpdir(), "reasonate-bundle-"));
  const directory = join(CLONE_ROOT, input.digest);

  try {
    const bundlePath = join(staging, `${input.digest}.bundle`);
    await writeFile(bundlePath, content);

    // A directory left by an interrupted clone is replaced rather than
    // adopted: git refuses to clone into a directory that is not empty.
    await rm(directory, { force: true, recursive: true });
    const cloned = await runGit(
      ["clone", "--bare", "--quiet", "--no-hardlinks", bundlePath, directory],
      GIT_OUTPUT_LIMIT
    );
    if (cloned.code !== 0) {
      throw new Error(
        `Cloning checkpoint ${input.checkpointId} failed: ${cloned.stderr.trim()}`
      );
    }

    return directory;
  } finally {
    await rm(staging, { force: true, recursive: true }).catch(() => undefined);
  }
}

/**
 * Keeps the clone cache bounded. Only settled clones are evicted, oldest
 * first. A directory the filesystem refuses to release stays where it is and
 * is reclaimed the next time this digest is cloned.
 */
async function evictOldestClone(protectedDigest: string): Promise<void> {
  const evicted: string[] = [];

  for (const [digest, entry] of clones) {
    if (clones.size <= MAX_CLONE_COUNT) {
      break;
    }
    if (digest === protectedDigest || !entry.done()) {
      continue;
    }

    clones.delete(digest);
    evicted.push(digest);
  }

  await Promise.all(
    evicted.map((digest) =>
      rm(join(CLONE_ROOT, digest), { force: true, recursive: true }).catch(
        () => undefined
      )
    )
  );
}

/**
 * The checkout for one checkpoint, cloned on first use and reused afterwards.
 * A clone that failed leaves nothing usable behind, so its entry is dropped
 * and the next read of that digest tries again rather than adopting the
 * failure.
 */
async function materializeCheckout(input: {
  checkpoints: CheckpointStore;
  checkpoint: CheckpointReference & { commit?: string };
}): Promise<string> {
  const cacheKey = `${input.checkpoint.digest}:${input.checkpoint.commit ?? "HEAD"}`;
  const cached = clones.get(cacheKey);
  if (cached) {
    return await cached.job;
  }

  let finished = false;
  const job = cloneFromBundle({
    checkpointId: input.checkpoint.checkpointId,
    checkpoints: input.checkpoints,
    digest: input.checkpoint.digest,
  }).then(async (directory) => {
    if (input.checkpoint.commit) {
      const head = await runGit(
        ["-C", directory, "symbolic-ref", "HEAD"],
        GIT_OUTPUT_LIMIT
      );
      if (head.code !== 0) {
        throw new Error(
          "The checkpoint bundle's default branch could not be resolved."
        );
      }
      const selected = await runGit(
        [
          "-C",
          directory,
          "update-ref",
          head.stdout.toString("utf8").trim(),
          input.checkpoint.commit,
        ],
        GIT_OUTPUT_LIMIT
      );
      if (selected.code !== 0) {
        throw new Error(
          "The requested checkpoint commit is unavailable in its verified bundle."
        );
      }
    }
    finished = true;
    return directory;
  });
  const tracked = job.catch((error: unknown) => {
    clones.delete(cacheKey);
    throw error;
  });

  clones.set(cacheKey, { done: () => finished, job: tracked });
  await evictOldestClone(cacheKey);

  return await tracked;
}

async function authorizeProjectAction(input: {
  action: Permission;
  deps: WorkspaceRouteDeps;
  organizationId: OrganizationId;
  principal: UserPrincipal;
  projectId: ProjectId;
}) {
  const organizationMembership = await input.deps
    .store()
    .memberships.getOrganizationMembership({
      organizationId: input.organizationId,
      userId: input.principal.userId,
    });

  const projectMembership = await input.deps
    .store()
    .memberships.getProjectMembership({
      organizationId: input.organizationId,
      projectId: input.projectId,
      userId: input.principal.userId,
    });

  return authorize({
    action: input.action,
    now: new Date().toISOString(),
    organizationMembership: organizationMembership ?? null,
    principal: input.principal,
    projectMembership: projectMembership ?? null,
    resource: {
      kind: "project",
      organizationId: input.organizationId,
      projectId: input.projectId,
      resourceId: null,
    },
  });
}

/**
 * Everything both workspace reads settle before a checkout is touched: the
 * centralized `project:read` decision, and whether the session exists in the
 * caller's scope. Returns the typed refusal, or undefined once the read may
 * proceed.
 */
async function guardWorkspaceRead(input: {
  buildSessionId: BuildSessionId;
  deps: WorkspaceRouteDeps;
  principal: UserPrincipal;
  requestId: string;
  scope: TenantScope;
}): Promise<Response | undefined> {
  const decision = await authorizeProjectAction({
    action: "project:read",
    deps: input.deps,
    organizationId: input.scope.organizationId,
    principal: input.principal,
    projectId: input.scope.projectId,
  });

  if (!decision.allowed) {
    return apiErrorResponse({
      code: DENIAL_BY_REASON[decision.reason] ?? "forbidden",
      message: "You are not authorized to read this project.",
      requestId: input.requestId,
    });
  }

  const buildSession = await input.deps
    .store()
    .getBuildSession(input.scope, input.buildSessionId);
  if (!buildSession) {
    return apiErrorResponse({
      code: "not_found",
      message: "No such build session.",
      requestId: input.requestId,
    });
  }

  return undefined;
}

async function guardWorkspaceRestore(input: {
  buildSessionId: BuildSessionId;
  deps: WorkspaceRouteDeps;
  principal: UserPrincipal;
  requestId: string;
  scope: TenantScope;
}): Promise<Response | undefined> {
  const decision = await authorizeProjectAction({
    action: "checkpoint:restore",
    deps: input.deps,
    organizationId: input.scope.organizationId,
    principal: input.principal,
    projectId: input.scope.projectId,
  });

  if (!decision.allowed) {
    return apiErrorResponse({
      code: DENIAL_BY_REASON[decision.reason] ?? "forbidden",
      message:
        "You are not authorized to restore checkpoints for this project.",
      requestId: input.requestId,
    });
  }

  const buildSession = await input.deps
    .store()
    .getBuildSession(input.scope, input.buildSessionId);
  if (!buildSession) {
    return apiErrorResponse({
      code: "not_found",
      message: "No such build session.",
      requestId: input.requestId,
    });
  }

  return undefined;
}

function resolveRestoreCheckpoint(
  scope: TenantScope,
  body: WorkspaceRestoreRequest
): { checkpointId: string; digest: string } | undefined {
  const rawCheckpointId =
    body.checkpointId ??
    (body.checkpointDigest
      ? `${scope.organizationId}.${scope.projectId}.${body.checkpointDigest}`
      : undefined);

  if (!rawCheckpointId) {
    return undefined;
  }

  const normalized = rawCheckpointId.replaceAll("/", ".");
  try {
    const parsed = parseCheckpointId(normalized);
    if (
      parsed.organizationId !== scope.organizationId ||
      parsed.projectId !== scope.projectId
    ) {
      return undefined;
    }
    return { checkpointId: normalized, digest: parsed.digest };
  } catch {
    return undefined;
  }
}

async function parseRestoreScopeAndBody(c: HandlerContext) {
  const buildSessionId = BuildSessionIdSchema.safeParse(
    c.req.param("buildSessionId")
  );
  const bodyJson = await c.req.json().catch(() => ({}));
  const body = WorkspaceRestoreRequestSchema.safeParse(bodyJson);
  const scope = WorkspaceScopeSchema.safeParse({
    organizationId:
      c.req.query("organizationId") ??
      (body.success ? body.data.organizationId : undefined),
    projectId:
      c.req.query("projectId") ??
      (body.success ? body.data.projectId : undefined),
  });
  if (!(buildSessionId.success && scope.success && body.success)) {
    return;
  }
  return {
    body: body.data,
    buildSessionId: buildSessionId.data,
    scope: scope.data,
  };
}

async function resolveWorkspaceSandbox(
  deps: WorkspaceRouteDeps,
  scope: TenantScope,
  buildSessionId: BuildSessionId,
  runId: RunId
): Promise<{ sandbox: CheckpointSandbox; dispose?: () => Promise<void> }> {
  if (deps.resolveSandbox) {
    const sandbox = await deps.resolveSandbox({
      buildSessionId,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
    });
    return { sandbox };
  }
  const createdSandbox = createBuildSandbox({
    buildSessionId,
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    runId,
  });
  await createdSandbox.start();
  return {
    dispose: async () => {
      await createdSandbox.destroy();
    },
    sandbox: checkpointSandboxFor(createdSandbox),
  };
}

function workspaceRestoreError(
  cause: unknown,
  requestId: string
): Response | undefined {
  if (cause instanceof WorkspaceRestoreBusyError) {
    return apiErrorResponse({
      code: "conflict",
      message: cause.message,
      requestId,
    });
  }
  if (cause instanceof WorkspaceRestoreFailure) {
    return apiErrorResponse({
      code: "internal",
      message: cause.message,
      requestId,
    });
  }
}

/**
 * The answer for a `git` call that did not produce a listing or a body. A path
 * that is not in the commit is the caller's mistake; anything else means this
 * host could not read the source, which is this service's problem and not the
 * caller's.
 */
function gitFailure(requestId: string, stderr: string): Response {
  if (MISSING_PATH_MESSAGES.test(stderr)) {
    return apiErrorResponse({
      code: "not_found",
      message: "No such file in this project's source.",
      requestId,
    });
  }

  return apiErrorResponse({
    code: "internal",
    message: "This project's source could not be read.",
    requestId,
  });
}

/**
 * The body of one file. Its size is settled before the content is read, so an
 * oversized asset is answered from the size alone and never pulled into memory
 * just to be discarded. A file that is oversized or carries a NUL byte is
 * reported as binary with no body, because a partial read of an image or a
 * minified bundle is not a preview.
 */
async function readWorkspaceFile(input: {
  directory: string;
  path: string;
  requestId: string;
}): Promise<{ answer: WorkspaceFileAnswer } | { failed: Response }> {
  const size = await runGit(
    ["-C", input.directory, "cat-file", "-s", `HEAD:${input.path}`],
    GIT_OUTPUT_LIMIT
  );
  if (size.code !== 0) {
    return { failed: gitFailure(input.requestId, size.stderr) };
  }

  const bytes = Number(size.stdout.toString("utf8").trim());
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    return {
      failed: apiErrorResponse({
        code: "internal",
        message: "This project's source could not be read.",
        requestId: input.requestId,
      }),
    };
  }
  if (bytes > MAX_TEXT_BYTES) {
    return { answer: { binary: true, bytes, path: input.path, text: "" } };
  }

  const body = await runGit(
    ["-C", input.directory, "show", `HEAD:${input.path}`],
    BLOB_READ_LIMIT
  );
  if (body.code !== 0) {
    return { failed: gitFailure(input.requestId, body.stderr) };
  }
  if (body.stdout.byteLength > MAX_TEXT_BYTES || body.stdout.includes(0)) {
    return {
      answer: {
        binary: true,
        bytes: body.stdout.byteLength,
        path: input.path,
        text: "",
      },
    };
  }

  return {
    answer: {
      binary: false,
      bytes: body.stdout.byteLength,
      path: input.path,
      text: body.stdout.toString("utf8"),
      truncated: false,
    },
  };
}

function recordedCheckpoint(
  event: RunEventEnvelope | undefined,
  sequence: number,
  scope: TenantScope,
  path: string
):
  | {
      checkpoint: Extract<RunCheckpoint, { status: "available" }>;
      file: CheckpointFileChange;
      digest: string;
    }
  | undefined {
  const parsed = RunCheckpointSchema.safeParse(event?.payload.checkpoint);
  if (
    !event ||
    event.sequence !== sequence ||
    !["run.completed", "run.failed", "run.cancelled"].includes(event.type) ||
    !parsed.success ||
    parsed.data.status !== "available"
  ) {
    return;
  }
  const checkpoint = parsed.data;
  const [organization, project, digest] = checkpoint.checkpointId.split(".");
  if (
    organization !== scope.organizationId ||
    project !== scope.projectId ||
    !digest ||
    !CHECKPOINT_DIGEST_PATTERN.test(digest) ||
    checkpoint.checkpointId.split(".").length !== 3
  ) {
    return;
  }
  const file = checkpoint.files.find((entry) => entry.path === path);
  if (
    !file ||
    (file.previousPath !== undefined &&
      !CheckpointPathSchema.safeParse(file.previousPath).success)
  ) {
    return;
  }
  return { checkpoint, digest, file };
}

async function readCheckpointDiff({
  c,
  checkpoints,
  checkpoint,
  file,
  digest,
  rid,
}: {
  c: HandlerContext;
  checkpoints: CheckpointStore;
  checkpoint: Extract<RunCheckpoint, { status: "available" }>;
  file: CheckpointFileChange;
  digest: string;
  rid: string;
}): Promise<Response> {
  const answer = (patchText: string, unavailable: "oversized" | null = null) =>
    c.json(
      CheckpointDiffSchema.parse({
        binary: file.added === null || file.removed === null,
        checkpointId: checkpoint.checkpointId,
        patch: patchText,
        path: file.path,
        unavailable,
      }),
      200
    );
  if (file.added === null || file.removed === null) {
    return answer("");
  }
  const directory = await materializeCheckout({
    checkpoint: { checkpointId: checkpoint.checkpointId, digest },
    checkpoints,
  });
  const head = await runGit(
    ["-C", directory, "rev-parse", "HEAD"],
    GIT_OUTPUT_LIMIT
  );
  if (
    head.code !== 0 ||
    head.stdout.toString("utf8").trim() !== checkpoint.commit
  ) {
    return apiErrorResponse({
      code: "internal",
      message: "The saved checkpoint commit could not be verified.",
      requestId: rid,
    });
  }
  const emptyTree =
    checkpoint.baseCommit === null
      ? await runGit(
          ["-C", directory, "hash-object", "-t", "tree", "--stdin"],
          GIT_OUTPUT_LIMIT
        )
      : undefined;
  const base =
    checkpoint.baseCommit ?? emptyTree?.stdout.toString("utf8").trim();
  if (!base || (emptyTree && emptyTree.code !== 0)) {
    return apiErrorResponse({
      code: "internal",
      message: "The checkpoint comparison base could not be read.",
      requestId: rid,
    });
  }
  const patch = await runGit(
    [
      "--literal-pathspecs",
      "-C",
      directory,
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=all",
      "--find-renames",
      base,
      checkpoint.commit,
      "--",
      ...(file.previousPath === undefined ? [] : [file.previousPath]),
      file.path,
    ],
    BLOB_READ_LIMIT
  );
  if (
    patch.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
    patch.stdout.byteLength > MAX_TEXT_BYTES
  ) {
    return answer("", "oversized");
  }
  if (patch.code !== 0) {
    return gitFailure(rid, patch.stderr);
  }
  return answer(patch.stdout.toString("utf8"));
}

export function createWorkspaceHandlers(deps: WorkspaceRouteDeps) {
  const checkpoints =
    deps.checkpoints ??
    createGitCheckpointStore({
      root:
        process.env.REASONATE_CHECKPOINT_ROOT ??
        join(homedir(), ".reasonateai", "checkpoints"),
    });

  return {
    checkpointDiff: async (c: HandlerContext): Promise<Response> => {
      const rid = c.req.header("x-request-id") ?? crypto.randomUUID();
      const principal = await deps.resolvePrincipal({
        cookieHeader: c.req.header("cookie"),
      });
      if (!principal) {
        return unauthenticatedResponse(rid);
      }
      const buildSessionId = BuildSessionIdSchema.safeParse(
        c.req.param("buildSessionId")
      );
      const query = CheckpointDiffQuerySchema.safeParse({
        organizationId: c.req.query("organizationId"),
        path: c.req.query("path"),
        projectId: c.req.query("projectId"),
        runId: c.req.query("runId"),
        sequence: c.req.query("sequence"),
      });
      if (!(buildSessionId.success && query.success)) {
        return apiErrorResponse({
          code: "invalid_request",
          message:
            "A scoped run, saved event sequence and workspace path are required.",
          requestId: rid,
        });
      }
      const scope = {
        organizationId: query.data.organizationId,
        projectId: query.data.projectId,
      };
      const refusal = await guardWorkspaceRead({
        buildSessionId: buildSessionId.data,
        deps,
        principal,
        requestId: rid,
        scope,
      });
      if (refusal) {
        return refusal;
      }
      const run = await deps
        .store()
        .getRun({ ...scope, runId: query.data.runId });
      if (
        !(
          run &&
          (await deps
            .store()
            .history.contains(scope, buildSessionId.data, query.data.runId))
        )
      ) {
        return apiErrorResponse({
          code: "not_found",
          message: "No such run in this build session.",
          requestId: rid,
        });
      }
      const [event] = await deps.store().listRunEvents({
        afterSequence: query.data.sequence - 1,
        limit: 1,
        runId: query.data.runId,
        scope,
      });
      const recorded = recordedCheckpoint(
        event,
        query.data.sequence,
        scope,
        query.data.path
      );
      if (!recorded) {
        return apiErrorResponse({
          code: "not_found",
          message: "This turn has no available diff for that file.",
          requestId: rid,
        });
      }
      return await readCheckpointDiff({ c, checkpoints, ...recorded, rid });
    },

    /**
     * One file's content from the same checkpoint. A binary or oversized file
     * is reported as such with no body: the answer is about the file, not a
     * partial read of it.
     */
    file: async (c: HandlerContext): Promise<Response> => {
      const rid = c.req.header("x-request-id") ?? crypto.randomUUID();

      const principal = await deps.resolvePrincipal({
        cookieHeader: c.req.header("cookie"),
      });
      if (!principal) {
        return unauthenticatedResponse(rid);
      }

      const buildSessionId = BuildSessionIdSchema.safeParse(
        c.req.param("buildSessionId")
      );
      const query = WorkspaceFileQuerySchema.safeParse({
        organizationId: c.req.query("organizationId"),
        path: c.req.query("path"),
        projectId: c.req.query("projectId"),
      });
      if (!(buildSessionId.success && query.success)) {
        return apiErrorResponse({
          code: "invalid_request",
          message:
            "A build session id, both scope identifiers, and a workspace-relative path are required.",
          requestId: rid,
        });
      }

      const refusal = await guardWorkspaceRead({
        buildSessionId: buildSessionId.data,
        deps,
        principal,
        requestId: rid,
        scope: {
          organizationId: query.data.organizationId,
          projectId: query.data.projectId,
        },
      });
      if (refusal) {
        return refusal;
      }

      const checkpoint = await conversationCheckpoint({
        buildSessionId: buildSessionId.data,
        checkpoints,
        scope: {
          organizationId: query.data.organizationId,
          projectId: query.data.projectId,
        },
        store: deps.store(),
      });
      if (!checkpoint) {
        return apiErrorResponse({
          code: "not_found",
          message: "This project has no generated source yet.",
          requestId: rid,
        });
      }

      const { path } = query.data;
      if (checkpoint.empty) {
        return apiErrorResponse({
          code: "not_found",
          message: "This file did not exist before the selected turn.",
          requestId: rid,
        });
      }
      const directory = await materializeCheckout({ checkpoint, checkpoints });
      const read = await readWorkspaceFile({ directory, path, requestId: rid });
      if ("failed" in read) {
        return read.failed;
      }

      return c.json(WorkspaceFileSchema.parse(read.answer), 200);
    },
    /**
     * Restores the project workspace from a Git checkpoint bundle into the build sandbox.
     */
    restore: async (c: HandlerContext): Promise<Response> => {
      const rid = c.req.header("x-request-id") ?? crypto.randomUUID();

      const principal = await deps.resolvePrincipal({
        cookieHeader: c.req.header("cookie"),
      });
      if (!principal) {
        return unauthenticatedResponse(rid);
      }

      const parsedRequest = await parseRestoreScopeAndBody(c);
      if (!parsedRequest) {
        return apiErrorResponse({
          code: "invalid_request",
          message:
            "A build session id, scope identifiers, and valid checkpointId are required.",
          requestId: rid,
        });
      }
      const { body, buildSessionId, scope } = parsedRequest;

      const refusal = await guardWorkspaceRestore({
        buildSessionId,
        deps,
        principal,
        requestId: rid,
        scope,
      });
      if (refusal) {
        return refusal;
      }

      const resolved = resolveRestoreCheckpoint(scope, body);
      if (!resolved) {
        return apiErrorResponse({
          code: "not_found",
          message: "No such checkpoint exists.",
          requestId: rid,
        });
      }
      const { checkpointId, digest } = resolved;

      try {
        await checkpoints.read(checkpointId);
      } catch {
        return apiErrorResponse({
          code: "not_found",
          message: "No such checkpoint exists.",
          requestId: rid,
        });
      }

      try {
        const restored = await deps.store().restoreWorkspaceCheckpoint({
          audit: auditEvent({
            action: "checkpoint.restored",
            actor: principal,
            metadata: { buildSessionId, checkpointId },
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            requestId: rid,
          }),
          buildSessionId,
          restore: async (session) => {
            const workspaceHandle = await resolveWorkspaceSandbox(
              deps,
              scope,
              buildSessionId,
              session.runId
            );
            try {
              return await restoreWorkspace({
                checkpointId,
                digest,
                sandbox: workspaceHandle.sandbox,
                scope,
                session,
                store: checkpoints,
              });
            } finally {
              await workspaceHandle.dispose?.();
            }
          },
          scope,
        });
        if (!restored) {
          return apiErrorResponse({
            code: "not_found",
            message: "No such build session.",
            requestId: rid,
          });
        }
        return c.json(WorkspaceRestoreResponseSchema.parse(restored), 200);
      } catch (cause) {
        const failure = workspaceRestoreError(cause, rid);
        if (failure) {
          return failure;
        }
        throw cause;
      }
    },
    /**
     * The project's generated source as a path listing, read from the latest
     * checkpoint. A project that has not produced one yet is an empty
     * workspace, not a missing one.
     */
    tree: async (c: HandlerContext): Promise<Response> => {
      const rid = c.req.header("x-request-id") ?? crypto.randomUUID();

      const principal = await deps.resolvePrincipal({
        cookieHeader: c.req.header("cookie"),
      });
      if (!principal) {
        return unauthenticatedResponse(rid);
      }

      const buildSessionId = BuildSessionIdSchema.safeParse(
        c.req.param("buildSessionId")
      );
      const scope = WorkspaceScopeSchema.safeParse({
        organizationId: c.req.query("organizationId"),
        projectId: c.req.query("projectId"),
      });
      if (!(buildSessionId.success && scope.success)) {
        return apiErrorResponse({
          code: "invalid_request",
          message:
            "A build session id and both scope identifiers are required.",
          requestId: rid,
        });
      }

      const refusal = await guardWorkspaceRead({
        buildSessionId: buildSessionId.data,
        deps,
        principal,
        requestId: rid,
        scope: scope.data,
      });
      if (refusal) {
        return refusal;
      }

      const checkpoint = await conversationCheckpoint({
        buildSessionId: buildSessionId.data,
        checkpoints,
        scope: scope.data,
        store: deps.store(),
      });
      if (!checkpoint) {
        return c.json(
          WorkspaceTreeSchema.parse({
            checkpointId: "",
            commit: "",
            files: [],
            truncated: false,
          }),
          200
        );
      }

      if (checkpoint.empty) {
        return c.json(
          WorkspaceTreeSchema.parse({
            checkpointId: checkpoint.checkpointId,
            commit: "",
            files: [],
            truncated: false,
          }),
          200
        );
      }

      const directory = await materializeCheckout({ checkpoint, checkpoints });
      const [head, listing] = await Promise.all([
        runGit(["-C", directory, "rev-parse", "HEAD"], GIT_OUTPUT_LIMIT),
        runGit(
          [
            "-C",
            directory,
            "ls-tree",
            "-r",
            "-l",
            "-t",
            "-z",
            "--full-tree",
            "HEAD",
          ],
          GIT_OUTPUT_LIMIT
        ),
      ]);
      if (head.code !== 0) {
        return gitFailure(rid, head.stderr);
      }
      if (listing.code !== 0) {
        return gitFailure(rid, listing.stderr);
      }

      // Sorting before the cap makes the cut deterministic: the same
      // checkpoint always reports the same first entries.
      const files = parseTreeRecords(listing.stdout.toString("utf8"))
        .filter(
          (entry) =>
            !EXCLUDED_SEGMENTS[entry.path.split(PATH_SEPARATOR)[0] ?? ""]
        )
        .sort((left, right) =>
          left.path < right.path ? -1 : Number(left.path > right.path)
        );
      const truncated = files.length > MAX_TREE_ENTRIES;

      return c.json(
        WorkspaceTreeSchema.parse({
          checkpointId: checkpoint.checkpointId,
          commit: head.stdout.toString("utf8").trim(),
          files: truncated ? files.slice(0, MAX_TREE_ENTRIES) : files,
          truncated,
        }),
        200
      );
    },
  };
}
