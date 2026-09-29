import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BuildSessionId } from "@reasonateai/contracts/execution";
import type {
  OrganizationId,
  ProjectId,
} from "@reasonateai/contracts/identity";
import type {
  ISandbox,
  ISandboxProvider,
} from "@reasonateai/contracts/sandbox";
import {
  type CheckpointStore,
  createGitCheckpointStore,
  restoreSandbox,
} from "@reasonateai/sandbox/checkpoint";
import { DockerSandboxProvider } from "@reasonateai/sandbox/docker";

const execFileAsync = promisify(execFile);

import { z } from "zod";

/**
 * Previews: the project's latest checkpoint, running.
 *
 * A preview is not the build sandbox. The worker destroys its sandbox when a
 * run ends, and that sandbox has no network at all, so a preview allocates its
 * own sandbox from the restored checkpoint, on a bridge network, with one port
 * published on the host's loopback interface. The API then proxies that port,
 * which is what makes the running app framable without ever exposing a sandbox
 * port to the network the API itself listens on.
 *
 * The lifecycle is deliberately small. One live preview exists per build
 * session; a second `POST` adopts it rather than starting a second container.
 * A preview that nothing has read from or proxied for fifteen minutes is torn
 * down, and every sandbox this service created is destroyed when the process
 * exits.
 *
 * Nothing here logs a command's stdout, the checkpoint bytes, or a credential.
 * A failure is reported as a sentence the caller can act on, and a preview
 * whose sandbox is gone is reported `failed` rather than `ready`.
 */

/** Public path prefix of every preview URL. The route module builds on it. */
export const PREVIEW_PUBLIC_PATH_PREFIX = "/v1/previews";

export const PreviewIdSchema = z.uuid().brand<"PreviewId">();
export type PreviewId = z.infer<typeof PreviewIdSchema>;

export const previewStatuses = [
  "starting",
  "ready",
  "failed",
  // A preview is `stopped` only in the answer to the request that stopped it.
  "stopped",
] as const;
export const PreviewStatusSchema = z.enum(previewStatuses);
export type PreviewStatus = z.infer<typeof PreviewStatusSchema>;

/** How long a failed detail may be, which is also the error message budget. */
const DETAIL_MAX_LENGTH = 400;

export const PreviewViewSchema = z.strictObject({
  detail: z.string().max(DETAIL_MAX_LENGTH).nullable(),
  port: z.number().int().min(1).max(65_535).nullable(),
  previewId: PreviewIdSchema,
  status: PreviewStatusSchema,
  url: z.string().min(1).max(1024),
});
export type PreviewView = z.infer<typeof PreviewViewSchema>;

/**
 * What the proxy needs to serve one preview: the scope to authorize against,
 * read from the preview rather than from the request URL, and the loopback port
 * to forward to.
 */
export interface PreviewTarget {
  readonly detail: string | null;
  readonly hostPort: number | null;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly status: PreviewStatus;
}

export interface PreviewRequest {
  readonly buildSessionId: BuildSessionId;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
}

/**
 * A preview and the scope it belongs to. The scope travels with the preview so
 * the route that reports it authorizes against the preview's own tenant rather
 * than against anything the caller supplied.
 */
export interface PreviewStatusReport {
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly view: PreviewView;
}

export interface PreviewService {
  /** Stops the idle sweep and destroys every sandbox this service created. */
  readonly disposeAll: () => Promise<void>;
  readonly start: (request: PreviewRequest) => Promise<PreviewView>;
  readonly status: (
    previewId: PreviewId
  ) => Promise<PreviewStatusReport | undefined>;
  readonly stop: (previewId: PreviewId) => Promise<PreviewView | undefined>;
  /**
   * Removes the preview containers a previous process left behind. Called by
   * the composition root at boot, so a restart cleans up rather than waits for
   * someone to open a preview.
   */
  readonly sweepOrphans: () => Promise<void>;
  readonly target: (previewId: PreviewId) => Promise<PreviewTarget | undefined>;
}

export interface PreviewServiceDeps {
  /**
   * Host directory holding every tenant's Git checkpoint bundles. Defaults to
   * the deployment's configured root, then to the same working directory the
   * execution plane uses.
   */
  checkpointRoot?: string;
  /** Resolved lazily so a deployment without checkpoints starts normally. */
  checkpoints?: () => CheckpointStore;
  /** The sandbox image every preview runs in. */
  image?: string;
  /** The clock, injectable so the idle deadline can be observed directly. */
  nowMs?: () => number;
  /**
   * Called with how many containers a previous process left behind, so a
   * deployment can report what it cleaned rather than cleaning silently.
   */
  onOrphansRemoved?: (count: number) => void;
  provider?: () => ISandboxProvider;
  /** Where the process-exit teardown is registered; injectable for callers. */
  registerExitHook?: (teardown: () => void) => void;
}

/** The port a preview listens on inside its container. */
const PREVIEW_PORT = 3000;

/**
 * The container prefix every preview's sandbox carries.
 *
 * A preview's registry is process-local: an API restart drops it, and a
 * container nobody can address is an orphan that would otherwise hold memory
 * until someone noticed. The name is what makes them findable, so a fresh
 * process can remove what its predecessors left behind.
 */
const PREVIEW_CONTAINER_PREFIX = "reasonate-sbx-preview-";
/** Where the restored checkpoint is served from. */
const PREVIEW_WORKDIR = "/workspace";
/** The image the build sandbox uses, so a preview runs what the run produced. */
const PREVIEW_IMAGE = "node:22";
const PREVIEW_SANDBOX_CPU = 1;
const PREVIEW_SANDBOX_MEMORY_MB = 1024;
/** A checkpoint restore is a Git fetch of one project's history. */
const SANDBOX_COMMAND_TIMEOUT_MS = 120_000;
/** `npm install` is the one command that legitimately outlives a short budget. */
const INSTALL_TIMEOUT_MS = 300_000;
/** The launcher backgrounds the app and returns; this only bounds the launch. */
const LAUNCH_TIMEOUT_MS = 15_000;
/** The app gets a minute to listen before the preview is called failed. */
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_INTERVAL_MS = 1000;
/**
 * One probe is one request to the app; a refusal is retried once so a preview
 * is not declared dead by a momentarily closed listening socket.
 */
const PROBE_TIMEOUT_MS = 3000;
const PROBE_RETRY_DELAY_MS = 500;
const IDLE_TTL_MS = 15 * 60 * 1000;
const IDLE_SWEEP_INTERVAL_MS = 60 * 1000;
/** The served app's own log, inside its container. Never read, never logged. */
const PREVIEW_LOG_PATH = "/tmp/reasonate-preview.log";
/** The scripts a generated app may be started with, in preference order. */
const SCRIPT_NAMES = ["dev", "start", "preview"] as const;
const SCRIPT_NAME_PATTERN = /^[a-zA-Z0-9:_-]+$/;
/** What a `package.json` that npm parsed is expected to look like here. */
const PackageJsonSchema = z.object({
  scripts: z.record(z.string(), z.string()).optional(),
});

interface PreviewRecord {
  readonly buildSessionId: BuildSessionId;
  detail: string | null;
  hostPort: number | null;
  lastUsedAtMs: number;
  readonly organizationId: OrganizationId;
  readonly previewId: PreviewId;
  readonly projectId: ProjectId;
  sandbox: ISandbox | undefined;
  status: PreviewStatus;
}

/** How the app in a restored checkpoint is started. */
interface ServePlan {
  readonly args: string[];
  readonly command: string;
  readonly env: Record<string, string>;
}

type ServeChoice = { readonly detail: string } | { readonly plan: ServePlan };

/** `serving` is any HTTP answer, `refused` is a closed port, `unknown` a stall. */
type ProbeResult = "serving" | "refused" | "unknown";

/**
 * `Promise.withResolvers` is only in the ES2024 library, and this application
 * compiles against ES2023, so the executor form is what is available here.
 */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** The last non-empty stderr line, which is where a CLI states its own failure. */
function lastStderrLine(stderr: string): string | undefined {
  const line = stderr
    .split("\n")
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0)
    .at(-1);
  return line === undefined || line.length === 0
    ? undefined
    : line.slice(0, 200);
}

function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length === 0
    ? "The preview failed for a reason the sandbox did not report."
    : message;
}

/**
 * An HTTP answer of any status proves the app is listening; only a refused
 * connection says it is not. A stalled probe is inconclusive, so a preview is
 * never called failed because one request took too long.
 */
async function probePreview(hostPort: number | null): Promise<ProbeResult> {
  if (hostPort === null) {
    return "refused";
  }

  try {
    await fetch(`http://127.0.0.1:${hostPort}/`, {
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return "serving";
  } catch (error) {
    return error instanceof Error && error.name === "TimeoutError"
      ? "unknown"
      : "refused";
  }
}

export function createPreviewService(
  deps: PreviewServiceDeps = {}
): PreviewService {
  const nowMs = deps.nowMs ?? (() => Date.now());
  const image = deps.image ?? PREVIEW_IMAGE;

  let provider: ISandboxProvider | undefined;
  const sandboxes = (): ISandboxProvider => {
    provider ??= deps.provider ? deps.provider() : new DockerSandboxProvider();
    return provider;
  };

  let store: CheckpointStore | undefined;
  const checkpoints = (): CheckpointStore => {
    store ??=
      deps.checkpoints?.() ??
      createGitCheckpointStore({
        root:
          deps.checkpointRoot ??
          process.env.REASONATE_CHECKPOINT_ROOT ??
          join(homedir(), ".reasonateai", "checkpoints"),
      });
    return store;
  };

  const byId = new Map<PreviewId, PreviewRecord>();
  const bySession = new Map<BuildSessionId, PreviewRecord>();

  const live = (record: PreviewRecord): boolean =>
    byId.get(record.previewId) === record;

  const touched = (record: PreviewRecord): PreviewRecord => {
    record.lastUsedAtMs = nowMs();
    return record;
  };

  const viewOf = (record: PreviewRecord): PreviewView =>
    PreviewViewSchema.parse({
      detail: record.detail,
      port: record.hostPort,
      previewId: record.previewId,
      status: record.status,
      url: `${PREVIEW_PUBLIC_PATH_PREFIX}/${record.previewId}/`,
    });

  const destroySandbox = async (record: PreviewRecord): Promise<void> => {
    const { sandbox } = record;
    record.sandbox = undefined;
    if (sandbox === undefined) {
      return;
    }
    try {
      await sandbox.destroy();
    } catch {
      // Teardown is best effort: the exit hook and Docker's own orphan cleanup
      // are the backstops, and a sandbox that is already gone is not a failure.
    }
  };

  /** A failed preview has nothing left to serve, so its sandbox goes with it. */
  const fail = async (record: PreviewRecord, detail: string): Promise<void> => {
    record.status = "failed";
    record.detail = detail.slice(0, DETAIL_MAX_LENGTH);
    record.hostPort = null;
    await destroySandbox(record);
  };

  const teardown = async (record: PreviewRecord): Promise<void> => {
    if (byId.get(record.previewId) === record) {
      byId.delete(record.previewId);
    }
    if (bySession.get(record.buildSessionId) === record) {
      bySession.delete(record.buildSessionId);
    }
    await destroySandbox(record);
  };
  /**
   * How to start what the checkpoint contains: a declared npm script first,
   * because that is what the project's own author chose, then the directory
   * itself. Nothing here reaches the network for a tool that is not installed.
   */
  const planServing = async (sandbox: ISandbox): Promise<ServeChoice> => {
    const packageJson = await sandbox
      .readFile("package.json")
      .catch(() => undefined);

    if (packageJson !== undefined) {
      const choice = await planFromPackageJson(sandbox, packageJson);
      if (choice !== undefined) {
        return choice;
      }
    }

    if (await exists(sandbox, "index.html")) {
      return await planStatic(sandbox);
    }

    return {
      detail: packageJson
        ? "The checkpoint's package.json declares no dev, start, or preview script, and there is no index.html to serve."
        : "The checkpoint has neither a package.json nor an index.html to serve.",
    };
  };

  /**
   * The npm path: install once, then run the project's own script. The script
   * name comes from the checkpoint, so it is validated before it reaches a
   * shell, and `HOST`/`PORT` are what the app is told to bind.
   */
  const planFromPackageJson = async (
    sandbox: ISandbox,
    packageJson: string
  ): Promise<ServeChoice | undefined> => {
    let parsed: z.infer<typeof PackageJsonSchema>;
    try {
      const candidate = PackageJsonSchema.safeParse(JSON.parse(packageJson));
      if (!candidate.success) {
        return { detail: "The checkpoint's package.json is not an object." };
      }
      parsed = candidate.data;
    } catch {
      return { detail: "The checkpoint's package.json is not valid JSON." };
    }

    const scripts = parsed.scripts ?? {};
    const script = SCRIPT_NAMES.find((name) => scripts[name] !== undefined);
    if (script === undefined) {
      return;
    }
    if (!SCRIPT_NAME_PATTERN.test(script)) {
      return {
        detail: `The checkpoint's package.json declares a ${script} script name that cannot be run.`,
      };
    }

    if (!(await exists(sandbox, "node_modules"))) {
      const installed = await sandbox.runCommand({
        args: ["install", "--no-audit", "--no-fund"],
        command: "npm",
        timeoutMs: INSTALL_TIMEOUT_MS,
      });
      if (installed.exitCode !== 0) {
        const tail = lastStderrLine(installed.stderr);
        return {
          detail: `npm install failed with exit code ${installed.exitCode}${tail === undefined ? "" : `: ${tail}`}.`,
        };
      }
    }

    return {
      plan: {
        args: [
          "-c",
          `nohup npm run ${script} > ${PREVIEW_LOG_PATH} 2>&1 </dev/null &`,
        ],
        command: "sh",
        env: { HOST: "0.0.0.0", PORT: String(PREVIEW_PORT) },
      },
    };
  };

  /**
   * The static path: the directory as it is. The image carries Python, so this
   * is a real server rather than a promise of one; a checkpoint whose static
   * site cannot be served is reported as failed instead of looking ready.
   */
  const planStatic = async (sandbox: ISandbox): Promise<ServeChoice> => {
    const python = await sandbox.runCommand({
      args: ["--version"],
      command: "python3",
    });
    if (python.exitCode !== 0) {
      return { detail: "no static server available" };
    }

    return {
      plan: {
        args: [
          "-c",
          `nohup python3 -m http.server ${PREVIEW_PORT} --bind 0.0.0.0 > ${PREVIEW_LOG_PATH} 2>&1 </dev/null &`,
        ],
        command: "sh",
        env: {},
      },
    };
  };

  /**
   * Polls the app until it answers. The sandbox's own state is checked on the
   * same beat, so a container that died during startup fails immediately
   * instead of spending the whole minute on a port that cannot come up. Each
   * beat is awaited before the next is scheduled, which is a recursion here
   * because a loop cannot await between its iterations.
   */
  const awaitServing = async (
    sandbox: ISandbox,
    hostPort: number,
    deadlineMs: number
  ): Promise<string | undefined> => {
    if ((await probePreview(hostPort)) === "serving") {
      return;
    }

    const state = await sandbox.getState().catch(() => undefined);
    if (state !== undefined && state.status !== "running") {
      return `The preview's sandbox is ${state.status}.`;
    }

    if (nowMs() >= deadlineMs) {
      return `The app did not start serving on port ${PREVIEW_PORT} within ${READY_TIMEOUT_MS / 1000} seconds.`;
    }

    await sleep(READY_POLL_INTERVAL_MS);
    return await awaitServing(sandbox, hostPort, deadlineMs);
  };

  /** Restores, starts, and reports readiness. Nothing here rejects. */
  const begin = async (record: PreviewRecord): Promise<void> => {
    try {
      const latest = await checkpoints().latest({
        organizationId: record.organizationId,
        projectId: record.projectId,
      });
      if (latest === undefined) {
        await fail(
          record,
          "This project has no saved checkpoint to preview yet."
        );
        return;
      }

      const sandbox = await sandboxes().create({
        cpuLimit: PREVIEW_SANDBOX_CPU,
        id: `preview-${record.previewId}`,
        image,
        memoryLimitMb: PREVIEW_SANDBOX_MEMORY_MB,
        // A preview is reached through its published port, which needs an
        // interface to publish on; the build sandbox's `none` has none.
        networkMode: "bridge",
        ports: [PREVIEW_PORT],
        projectId: record.projectId,
        runId: null,
        timeoutMs: SANDBOX_COMMAND_TIMEOUT_MS,
        workdir: PREVIEW_WORKDIR,
      });
      record.sandbox = sandbox;
      if (!live(record)) {
        await destroySandbox(record);
        return;
      }

      if (sandbox.exposePort === undefined) {
        await fail(record, "This sandbox provider cannot publish a port.");
        return;
      }
      const hostPort = await sandbox.exposePort(PREVIEW_PORT);
      record.hostPort = hostPort;

      await restoreSandbox({
        checkpointId: latest.checkpointId,
        sandbox,
        store: checkpoints(),
        workdir: PREVIEW_WORKDIR,
      });

      const choice = await planServing(sandbox);
      if ("detail" in choice) {
        await fail(record, choice.detail);
        return;
      }

      const launched = await sandbox.runCommand({
        args: choice.plan.args,
        command: choice.plan.command,
        env: choice.plan.env,
        timeoutMs: LAUNCH_TIMEOUT_MS,
      });
      if (launched.exitCode !== 0) {
        await fail(
          record,
          `The preview process could not be started (exit code ${launched.exitCode}).`
        );
        return;
      }

      const failure = await awaitServing(
        sandbox,
        hostPort,
        nowMs() + READY_TIMEOUT_MS
      );
      if (failure !== undefined) {
        await fail(record, failure);
        return;
      }

      if (!live(record)) {
        return;
      }
      record.status = "ready";
      record.detail = null;
    } catch (error) {
      if (!live(record)) {
        return;
      }
      await fail(record, describeFailure(error));
    }
  };

  /** Confirms a preview still is what it says it is, then reports it. */
  const refresh = async (record: PreviewRecord): Promise<void> => {
    if (record.status !== "ready" && record.status !== "starting") {
      return;
    }

    if (record.sandbox !== undefined) {
      const state = await record.sandbox.getState().catch(() => undefined);
      if (state !== undefined && state.status !== "running") {
        await fail(record, `The preview's sandbox is ${state.status}.`);
        return;
      }
    }

    if (record.status !== "ready") {
      return;
    }

    if ((await probePreview(record.hostPort)) === "refused") {
      await sleep(PROBE_RETRY_DELAY_MS);
      if ((await probePreview(record.hostPort)) === "refused") {
        await fail(record, "The preview stopped answering its published port.");
      }
    }
  };

  /**
   * Removes the preview containers a previous process left behind.
   *
   * A preview's registry does not survive a restart, so every container this
   * process did not create is one nobody can address: it holds memory, serves
   * nothing, and would only be found by looking. This runs once, before the
   * first preview of the process, and it never touches a run's sandbox — those
   * carry a different name.
   */
  let swept = false;
  const sweepOrphans = async (): Promise<void> => {
    if (swept) {
      return;
    }
    swept = true;
    try {
      const listed = await execFileAsync("docker", [
        "ps",
        "-a",
        "--filter",
        `name=${PREVIEW_CONTAINER_PREFIX}`,
        "--format",
        "{{.Names}}",
      ]);
      const orphans = listed.stdout
        .split("\n")
        .map((line: string) => line.trim())
        .filter((name: string) => name.startsWith(PREVIEW_CONTAINER_PREFIX));
      await Promise.all(
        orphans.map((name: string) =>
          execFileAsync("docker", ["rm", "-f", "-v", name]).catch(
            () => undefined
          )
        )
      );
      if (orphans.length > 0) {
        deps.onOrphansRemoved?.(orphans.length);
      }
    } catch {
      // Docker being unavailable is not this service's failure to report: the
      // first preview will fail on its own terms and say so.
    }
  };

  const start = async (request: PreviewRequest): Promise<PreviewView> => {
    await sweepOrphans();
    const existing = bySession.get(request.buildSessionId);
    if (existing !== undefined) {
      // A live preview is adopted: the panel retries a dropped request, and a
      // retry must not leave the first container running behind it.
      if (existing.status !== "failed") {
        return viewOf(touched(existing));
      }
      await teardown(existing);
    }

    const previewId = PreviewIdSchema.parse(randomUUID());
    const record: PreviewRecord = {
      buildSessionId: request.buildSessionId,
      detail: null,
      hostPort: null,
      lastUsedAtMs: nowMs(),
      organizationId: request.organizationId,
      previewId,
      projectId: request.projectId,
      sandbox: undefined,
      status: "starting",
    };
    byId.set(previewId, record);
    bySession.set(record.buildSessionId, record);

    // The caller gets the id and `starting` now; the container, the restore,
    // and the app all happen behind it, and a failure lands in `detail`.
    // `begin` reports its own failures, so there is nothing to await here.
    begin(record).catch(() => undefined);

    return viewOf(record);
  };

  const status = async (
    previewId: PreviewId
  ): Promise<PreviewStatusReport | undefined> => {
    const record = byId.get(previewId);
    if (record === undefined) {
      return;
    }

    touched(record);
    await refresh(record);
    return {
      organizationId: record.organizationId,
      projectId: record.projectId,
      view: viewOf(record),
    };
  };

  const stop = async (
    previewId: PreviewId
  ): Promise<PreviewView | undefined> => {
    const record = byId.get(previewId);
    if (record === undefined) {
      return;
    }

    await teardown(record);
    record.status = "stopped";
    record.detail = null;
    record.hostPort = null;
    return viewOf(record);
  };

  /**
   * What the proxy needs. The scope comes from the preview, never from the
   * request, and a proxied request counts as use so a preview being watched
   * never expires under the viewer.
   */
  const target = (previewId: PreviewId): Promise<PreviewTarget | undefined> => {
    const record = byId.get(previewId);
    if (record === undefined) {
      return Promise.resolve(undefined);
    }

    touched(record);
    return Promise.resolve({
      detail: record.detail,
      hostPort: record.hostPort,
      organizationId: record.organizationId,
      projectId: record.projectId,
      status: record.status,
    });
  };

  /** Idle previews cost a container each, so the sweep is not optional. */
  const sweep = (): void => {
    const cutoff = nowMs() - IDLE_TTL_MS;
    for (const record of byId.values()) {
      if (record.lastUsedAtMs <= cutoff) {
        teardown(record).catch(() => undefined);
      }
    }
  };

  const timer = setInterval(sweep, IDLE_SWEEP_INTERVAL_MS);
  // The sweep must never be the reason the process stays alive.
  timer.unref();

  const disposeAll = async (): Promise<void> => {
    clearInterval(timer);
    await Promise.all(Array.from(byId.values(), (record) => teardown(record)));
  };

  const registerExitHook =
    deps.registerExitHook ??
    ((teardownAll: () => void): void => {
      process.once("exit", teardownAll);
    });

  registerExitHook(() => {
    for (const record of byId.values()) {
      const { sandbox } = record;
      if (sandbox === undefined) {
        continue;
      }
      // `exit` cannot await, so the synchronous teardown is what actually runs
      // here; `disposeAll` and the sweep are the graceful paths.
      if (sandbox.destroySync === undefined) {
        sandbox.destroy().catch(() => undefined);
      } else {
        sandbox.destroySync();
      }
    }
  });

  return { disposeAll, start, status, stop, sweepOrphans, target };
}

/** Whether a path exists in the sandbox, file or directory. */
async function exists(
  sandbox: ISandbox,
  relativePath: string
): Promise<boolean> {
  const result = await sandbox.runCommand({
    args: ["-e", relativePath],
    command: "test",
  });
  return result.exitCode === 0;
}
