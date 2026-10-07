import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  APP_PREVIEW_RELAY_PORT,
  AppPreviewConfigurationSchema,
  type BuildSessionId,
} from "@reasonateai/contracts/execution";
import type {
  OrganizationId,
  ProjectId,
  RunId,
} from "@reasonateai/contracts/identity";
import type { ISandbox } from "@reasonateai/contracts/sandbox";
import {
  createInMemoryPreviewRepository,
  type PreviewRepository,
  type StoredPreview,
} from "@reasonateai/project-state/previews";
import { connectPreviewApp, discoverPreviewApp } from "./preview-port.js";

const execFileAsync = promisify(execFile);

import { z } from "zod";

/**
 * Previews attach to the exact run sandbox selected by `open_preview`. The
 * sandbox publishes only its fixed relay port on loopback; the relay forwards
 * to the validated app port, and the API proxies that host binding. No second
 * sandbox is allocated and no checkpoint is needed to begin previewing.
 *
 * The lifecycle is deliberately small. One live preview exists per build
 * run; a second `POST` adopts its durable lease. A preview idle for fifteen
 * minutes releases its run sandbox after the run ends; active runs retain
 * ownership until worker teardown.
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
  readonly runId: RunId;
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
  /**
   * Recovers active previews from the persistent store across process restart,
   * retires dead or expired containers, and removes true orphans.
   */
  readonly recover: () => Promise<{
    orphansRemoved: number;
    recovered: number;
    retired: number;
  }>;
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
  /** Attaches to the authorized build sandbox; previews never allocate another one. */
  attachRunSandbox?: (scope: {
    buildSessionId: BuildSessionId;
    organizationId: OrganizationId;
    projectId: ProjectId;
    runId: RunId;
  }) => Promise<ISandbox | undefined>;
  isRunActive?: (runId: RunId) => Promise<boolean>;
  /** Isolates preview containers for independent development deployments. */
  namespace?: string | undefined;
  /** The clock, injectable so the idle deadline can be observed directly. */
  nowMs?: (() => number) | undefined;
  /**
   * Called with how many containers a previous process left behind, so a
   * deployment can report what it cleaned rather than cleaning silently.
   */
  onOrphansRemoved?: ((count: number) => void) | undefined;
  /** Called when a live preview is recovered across process restart. */
  onPreviewRecovered?:
    | ((previewId: PreviewId, port: number) => void)
    | undefined;
  /** Called when a preview is retired or marked failed during recovery. */
  onPreviewRetired?:
    | ((previewId: PreviewId, reason: string) => void)
    | undefined;
  /** Persistent preview repository backing the registry. */
  previewStore?: PreviewRepository | (() => PreviewRepository) | undefined;
}

/** The only sandbox port published for an app preview. */
const PREVIEW_PORT = APP_PREVIEW_RELAY_PORT;

/**
 * The container prefix every preview's sandbox carries.
 *
 * A preview's registry is process-local: an API restart drops it, and a
 * container nobody can address is an orphan that would otherwise hold memory
 * until someone noticed. The name is what makes them findable, so a fresh
 * process can remove what its predecessors left behind.
 */

/**
 * One probe is one request to the app; a refusal is retried once so a preview
 * is not declared dead by a momentarily closed listening socket.
 */
const PROBE_TIMEOUT_MS = 3000;
const PROBE_RETRY_DELAY_MS = 500;
const READY_TIMEOUT_MS = 5000;
const READY_POLL_INTERVAL_MS = 150;
const IDLE_TTL_MS = 15 * 60 * 1000;
const IDLE_SWEEP_INTERVAL_MS = 60 * 1000;
const PREVIEW_NAMESPACE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

interface PreviewRecord {
  appPort: number | null;
  beginPromise?: Promise<void> | undefined;
  readonly buildSessionId: BuildSessionId;
  detail: string | null;
  hostPort: number | null;
  lastUsedAtMs: number;
  readonly organizationId: OrganizationId;
  readonly previewId: PreviewId;
  readonly projectId: ProjectId;
  readonly runId: RunId | null;
  sandbox: ISandbox | undefined;
  status: PreviewStatus;
}

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

function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length === 0
    ? "The preview failed for a reason the sandbox did not report."
    : message;
}

function parsePublishedPortOutput(stdout: string): number | null {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const colonIndex = trimmed.lastIndexOf(":");
    if (colonIndex !== -1) {
      const port = Number.parseInt(trimmed.slice(colonIndex + 1), 10);
      if (!Number.isNaN(port) && port > 0 && port <= 65_535) {
        return port;
      }
    }
  }
  return null;
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
    const response = await fetch(`http://127.0.0.1:${hostPort}/`, {
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return response.headers.get("x-reasonate-preview-upstream") ===
      "unavailable"
      ? "refused"
      : "serving";
  } catch (error) {
    return error instanceof Error && error.name === "TimeoutError"
      ? "unknown"
      : "refused";
  }
}

async function waitForRelay(hostPort: number, deadline: number): Promise<void> {
  const state = await probePreview(hostPort);
  if (state === "serving") {
    return;
  }
  if (state === "refused" && Date.now() >= deadline) {
    throw new Error("The preview relay did not become ready.");
  }
  if (Date.now() < deadline) {
    await sleep(READY_POLL_INTERVAL_MS);
    return waitForRelay(hostPort, deadline);
  }
  throw new Error("The preview relay readiness check timed out.");
}

export function createPreviewService(
  deps: PreviewServiceDeps = {}
): PreviewService {
  const nowMs = deps.nowMs ?? (() => Date.now());
  const namespace = z
    .string()
    .regex(PREVIEW_NAMESPACE_PATTERN)
    .optional()
    .parse(deps.namespace);
  const sandboxPrefix = namespace ? `preview-${namespace}-` : "preview-";
  const containerPrefix = `reasonate-sbx-${sandboxPrefix}`;

  const byId = new Map<PreviewId, PreviewRecord>();
  const bySession = new Map<BuildSessionId, PreviewRecord>();

  let previewStoreInstance: PreviewRepository | undefined;
  const getPreviewStore = (): PreviewRepository => {
    if (!previewStoreInstance) {
      try {
        previewStoreInstance =
          typeof deps.previewStore === "function"
            ? deps.previewStore()
            : (deps.previewStore ?? createInMemoryPreviewRepository());
      } catch {
        previewStoreInstance = createInMemoryPreviewRepository();
      }
    }
    return previewStoreInstance;
  };

  const attachSandbox = async (
    stored: StoredPreview
  ): Promise<ISandbox | undefined> => {
    if (!(stored.runId && deps.attachRunSandbox)) {
      return;
    }
    return await deps
      .attachRunSandbox({
        buildSessionId: stored.buildSessionId,
        organizationId: stored.organizationId,
        projectId: stored.projectId,
        runId: stored.runId,
      })
      .catch(() => undefined);
  };

  const live = (record: PreviewRecord): boolean =>
    byId.get(record.previewId) === record;

  const touched = (record: PreviewRecord): PreviewRecord => {
    record.lastUsedAtMs = nowMs();
    getPreviewStore()
      .touch(record.previewId)
      .catch(() => undefined);
    return record;
  };

  const viewOf = (record: PreviewRecord): PreviewView =>
    PreviewViewSchema.parse({
      detail: record.detail,
      port: record.appPort,
      previewId: record.previewId,
      status: record.status,
      url: `${PREVIEW_PUBLIC_PATH_PREFIX}/${record.previewId}/`,
    });

  const selectedAppPort = async (
    sandbox: ISandbox | undefined
  ): Promise<number | null> => {
    if (!sandbox) {
      return null;
    }
    try {
      const configuration = AppPreviewConfigurationSchema.parse(
        JSON.parse(await sandbox.readFile(".reasonate/preview.json"))
      );
      return configuration.port ?? null;
    } catch {
      return null;
    }
  };

  const destroySandbox = async (record: PreviewRecord): Promise<void> => {
    if (record.runId !== null && deps.isRunActive) {
      try {
        if (await deps.isRunActive(record.runId)) {
          return;
        }
      } catch {
        return;
      }
    }
    const { sandbox } = record;
    record.sandbox = undefined;
    if (sandbox === undefined) {
      const containerName = `${containerPrefix}${record.previewId}`;
      await execFileAsync("docker", ["rm", "-f", "-v", containerName]).catch(
        () => undefined
      );
    } else {
      try {
        await sandbox.destroy();
      } catch {
        // Teardown is best effort: the exit hook and Docker's own orphan cleanup
        // are the backstops, and a sandbox that is already gone is not a failure.
      }
    }
  };

  const preparePreview = async (
    record: PreviewRecord
  ): Promise<{ appPort: number; hostPort: number; sandbox: ISandbox }> => {
    if (record.runId === null || !deps.attachRunSandbox) {
      throw new Error("The selected run sandbox is no longer available.");
    }
    const sandbox =
      record.sandbox ??
      (await deps.attachRunSandbox({
        buildSessionId: record.buildSessionId,
        organizationId: record.organizationId,
        projectId: record.projectId,
        runId: record.runId,
      }));
    if (!sandbox) {
      throw new Error("The selected run sandbox is no longer available.");
    }
    record.sandbox = sandbox;
    if (!live(record)) {
      throw new Error("This preview request has been stopped.");
    }

    const configuration = AppPreviewConfigurationSchema.parse(
      JSON.parse(await sandbox.readFile(".reasonate/preview.json"))
    );
    if (configuration.port === undefined) {
      throw new Error("The selected app port was not saved by open_preview.");
    }
    const appPort = configuration.port;
    record.appPort = appPort;
    const app = await discoverPreviewApp(sandbox, appPort, configuration.host);
    if (!app || app.port !== appPort) {
      throw new Error(`The selected app is not listening on port ${appPort}.`);
    }
    if (!sandbox.exposePort) {
      throw new Error("This sandbox provider cannot expose the private relay.");
    }
    const hostPort = await sandbox.exposePort(PREVIEW_PORT);
    record.hostPort = hostPort;
    getPreviewStore()
      .update(record.previewId, { hostPort })
      .catch(() => undefined);
    const selectedBasePath = `${PREVIEW_PUBLIC_PATH_PREFIX}/${record.previewId}/`;
    await connectPreviewApp(sandbox, app, PREVIEW_PORT, selectedBasePath);
    await waitForRelay(hostPort, nowMs() + READY_TIMEOUT_MS);
    return { appPort, hostPort, sandbox };
  };

  /** A failed preview has nothing left to serve, so its sandbox goes with it. */
  const fail = async (record: PreviewRecord, detail: string): Promise<void> => {
    record.status = "failed";
    record.detail = detail.slice(0, DETAIL_MAX_LENGTH);
    record.hostPort = null;
    await destroySandbox(record);
    getPreviewStore()
      .update(record.previewId, {
        detail: record.detail,
        hostPort: null,
        status: "failed",
      })
      .catch(() => undefined);
  };

  const teardown = async (record: PreviewRecord): Promise<void> => {
    if (byId.get(record.previewId) === record) {
      byId.delete(record.previewId);
    }
    if (bySession.get(record.buildSessionId) === record) {
      bySession.delete(record.buildSessionId);
    }
    await destroySandbox(record);
    getPreviewStore()
      .update(record.previewId, {
        status: "stopped",
      })
      .catch(() => undefined);
  };
  /** Connects the relay to the exact app port selected by `open_preview`. */
  const begin = async (record: PreviewRecord): Promise<void> => {
    try {
      if (!live(record)) {
        return;
      }
      const { appPort, hostPort, sandbox } = await preparePreview(record);
      if (!live(record)) {
        return;
      }
      record.appPort = appPort;
      record.hostPort = hostPort;
      record.sandbox = sandbox;
      record.status = "ready";
      record.detail = null;
      getPreviewStore()
        .update(record.previewId, {
          detail: null,
          hostPort: record.hostPort,
          status: "ready",
        })
        .catch(() => undefined);
    } catch (error) {
      if (!live(record)) {
        return;
      }
      await fail(record, describeFailure(error));
    }
  };

  const launch = (record: PreviewRecord): void => {
    if (record.status !== "starting" || record.beginPromise) {
      return;
    }
    record.beginPromise = begin(record).finally(() => {
      record.beginPromise = undefined;
    });
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
  type RecoverItemResult =
    | {
        containerName: string;
        hostPort: number | null;
        outcome: "recovered";
        previewId: PreviewId;
        record: PreviewRecord;
      }
    | {
        outcome: "retired";
        previewId: PreviewId;
        reason: "idle_expired" | "container_exited" | "probe_refused";
      };

  const retireExpiredPreview = async (
    item: StoredPreview,
    runId: RunId,
    cutoff: number,
    previewRepo: PreviewRepository
  ): Promise<RecoverItemResult | undefined> => {
    if (item.lastUsedAt.getTime() > cutoff) {
      return undefined;
    }
    const active = deps.isRunActive
      ? await deps.isRunActive(runId).catch(() => true)
      : false;
    if (active) {
      await previewRepo.touch(item.previewId);
      return undefined;
    }
    const sandbox = await attachSandbox(item);
    await sandbox?.destroy().catch(() => undefined);
    await previewRepo.update(item.previewId, {
      detail: "Preview retired after idle expiration during service restart.",
      status: "stopped",
    });
    return {
      outcome: "retired",
      previewId: item.previewId,
      reason: "idle_expired",
    };
  };

  const isRunSandboxRunning = async (
    containerName: string
  ): Promise<boolean> => {
    try {
      const inspectRes = await execFileAsync("docker", [
        "inspect",
        "--format",
        "{{.State.Running}}",
        containerName,
      ]);
      return inspectRes.stdout.trim() === "true";
    } catch {
      return false;
    }
  };

  const getPublishedPreviewPort = async (
    containerName: string,
    fallback: number | null
  ): Promise<number | null> => {
    try {
      const portRes = await execFileAsync("docker", [
        "port",
        containerName,
        String(PREVIEW_PORT),
      ]);
      return parsePublishedPortOutput(portRes.stdout) ?? fallback;
    } catch {
      return fallback;
    }
  };

  const recoveredRecord = async (
    item: StoredPreview,
    sandbox: ISandbox | undefined,
    hostPort: number | null,
    recoveredStatus: "ready" | "starting"
  ): Promise<PreviewRecord> => ({
    appPort: await selectedAppPort(sandbox),
    buildSessionId: item.buildSessionId,
    detail: null,
    hostPort,
    lastUsedAtMs: nowMs(),
    organizationId: item.organizationId,
    previewId: item.previewId,
    projectId: item.projectId,
    runId: item.runId,
    sandbox,
    status: recoveredStatus,
  });

  const recoverPreviewItem = async (
    item: StoredPreview,
    cutoff: number,
    previewRepo: PreviewRepository
  ): Promise<RecoverItemResult> => {
    const { containerName, previewId } = item;

    if (item.runId === null) {
      await execFileAsync("docker", ["rm", "-f", "-v", containerName]).catch(
        () => undefined
      );
      await previewRepo.update(previewId, {
        detail: "The legacy isolated preview sandbox was retired.",
        status: "stopped",
      });
      return { outcome: "retired", previewId, reason: "container_exited" };
    }

    const expired = await retireExpiredPreview(
      item,
      item.runId,
      cutoff,
      previewRepo
    );
    if (expired) {
      return expired;
    }
    if (!(await isRunSandboxRunning(containerName))) {
      await previewRepo.update(previewId, {
        detail:
          "The preview container exited while the service was restarting.",
        status: "failed",
      });
      return { outcome: "retired", previewId, reason: "container_exited" };
    }

    const hostPort = await getPublishedPreviewPort(
      containerName,
      item.hostPort
    );

    const attached = await attachSandbox(item);
    const runIsActive = item.runId
      ? await deps.isRunActive?.(item.runId).catch(() => true)
      : false;
    const probe = await probePreview(hostPort);
    if (runIsActive && probe !== "serving" && attached) {
      await previewRepo.touch(previewId);
      if (hostPort !== item.hostPort) {
        await previewRepo.update(previewId, { hostPort, status: "starting" });
      }
      const record = await recoveredRecord(
        item,
        attached,
        hostPort,
        "starting"
      );
      return {
        containerName,
        hostPort,
        outcome: "recovered",
        previewId,
        record,
      };
    }
    if (probe !== "serving") {
      await previewRepo.update(previewId, {
        detail:
          "The preview stopped answering its published port during service restart.",
        status: "failed",
      });
      return { outcome: "retired", previewId, reason: "probe_refused" };
    }

    const record = await recoveredRecord(item, attached, hostPort, "ready");

    if (hostPort !== item.hostPort) {
      await previewRepo.update(previewId, {
        hostPort,
        status: "ready",
      });
    }

    return {
      containerName,
      hostPort,
      outcome: "recovered",
      previewId,
      record,
    };
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
  const recover = async (): Promise<{
    orphansRemoved: number;
    recovered: number;
    retired: number;
  }> => {
    const recoveredContainers = new Set<string>();
    let recoveredCount = 0;
    let retiredCount = 0;
    let orphansRemovedCount = 0;

    const previewRepo = getPreviewStore();
    const cutoff = nowMs() - IDLE_TTL_MS;

    try {
      const active = await previewRepo.listActive();
      const results = await Promise.all(
        active.map((item) => recoverPreviewItem(item, cutoff, previewRepo))
      );

      for (const res of results) {
        if (res.outcome === "retired") {
          retiredCount += 1;
          deps.onPreviewRetired?.(res.previewId, res.reason);
        } else {
          byId.set(res.previewId, res.record);
          bySession.set(res.record.buildSessionId, res.record);
          recoveredContainers.add(res.containerName);
          recoveredCount += 1;
          if (deps.onPreviewRecovered) {
            deps.onPreviewRecovered(res.previewId, res.hostPort ?? 0);
          }
        }
      }
    } catch {
      // Ignored
    }

    try {
      const listed = await execFileAsync("docker", [
        "ps",
        "-a",
        "--filter",
        `name=${containerPrefix}`,
        "--format",
        "{{.Names}}",
      ]);
      const allPreviewContainers = listed.stdout
        .split("\n")
        .map((l: string) => l.trim())
        .filter(
          (n: string) =>
            n.startsWith(containerPrefix) &&
            PreviewIdSchema.safeParse(n.slice(containerPrefix.length)).success
        );

      const trueOrphans = allPreviewContainers.filter(
        (name: string) => !recoveredContainers.has(name)
      );

      await Promise.all(
        trueOrphans.map((name: string) =>
          execFileAsync("docker", ["rm", "-f", "-v", name]).catch(
            () => undefined
          )
        )
      );
      orphansRemovedCount = trueOrphans.length;
      if (orphansRemovedCount > 0) {
        deps.onOrphansRemoved?.(orphansRemovedCount);
      }
    } catch {
      // Ignored
    }

    return {
      orphansRemoved: orphansRemovedCount,
      recovered: recoveredCount,
      retired: retiredCount,
    };
  };

  let swept = false;
  const sweepOrphans = async (): Promise<void> => {
    if (swept) {
      return;
    }
    swept = true;
    await recover();
  };

  const start = async (request: PreviewRequest): Promise<PreviewView> => {
    await sweepOrphans();
    const persisted = await getPreviewStore().getByRun(request.runId);
    let existing = persisted ? byId.get(persisted.previewId) : undefined;
    if (existing === undefined) {
      try {
        const dbExisting = persisted;
        if (
          dbExisting &&
          (dbExisting.status === "ready" || dbExisting.status === "starting")
        ) {
          const sandbox = await attachSandbox(dbExisting);
          const appPort = await selectedAppPort(sandbox);
          existing = {
            appPort,
            buildSessionId: dbExisting.buildSessionId,
            detail: dbExisting.detail,
            hostPort: dbExisting.hostPort,
            lastUsedAtMs: nowMs(),
            organizationId: dbExisting.organizationId,
            previewId: dbExisting.previewId,
            projectId: dbExisting.projectId,
            runId: dbExisting.runId,
            sandbox,
            status: dbExisting.status,
          };
          byId.set(existing.previewId, existing);
          bySession.set(existing.buildSessionId, existing);
        }
      } catch {
        // Best effort
      }
    }

    if (existing !== undefined) {
      // A live preview is adopted: the panel retries a dropped request, and a
      // retry must not leave the first container running behind it.
      if (existing.status !== "failed") {
        launch(existing);
        return viewOf(touched(existing));
      }
      await teardown(existing);
    }

    const previewId = PreviewIdSchema.parse(randomUUID());
    const sandboxId =
      `reasonate-${request.organizationId}-${request.projectId}-${request.buildSessionId}`.replaceAll(
        /[^a-zA-Z0-9_.-]/g,
        "-"
      );
    const record: PreviewRecord = {
      appPort: null,
      buildSessionId: request.buildSessionId,
      detail: null,
      hostPort: null,
      lastUsedAtMs: nowMs(),
      organizationId: request.organizationId,
      previewId,
      projectId: request.projectId,
      runId: request.runId,
      sandbox: undefined,
      status: "starting",
    };
    byId.set(previewId, record);
    bySession.set(record.buildSessionId, record);

    await getPreviewStore().record({
      buildSessionId: request.buildSessionId,
      containerName: sandboxId,
      organizationId: request.organizationId,
      previewId,
      projectId: request.projectId,
      runId: request.runId,
      sandboxId,
      status: "starting",
    });

    // The caller gets the id and `starting` now; the container, the restore,
    // and the app all happen behind it, and a failure lands in `detail`.
    // `begin` reports its own failures, so there is nothing to await here.
    launch(record);

    return viewOf(record);
  };

  const status = async (
    previewId: PreviewId
  ): Promise<PreviewStatusReport | undefined> => {
    let record = byId.get(previewId);
    if (record === undefined) {
      try {
        const stored = await getPreviewStore().get(previewId);
        if (stored) {
          const sandbox = await attachSandbox(stored);
          record = {
            appPort: await selectedAppPort(sandbox),
            buildSessionId: stored.buildSessionId,
            detail: stored.detail,
            hostPort: stored.hostPort,
            lastUsedAtMs: stored.lastUsedAt.getTime(),
            organizationId: stored.organizationId,
            previewId: stored.previewId,
            projectId: stored.projectId,
            runId: stored.runId,
            sandbox,
            status: stored.status,
          };
          byId.set(previewId, record);
          bySession.set(record.buildSessionId, record);
        }
      } catch {
        // Ignore
      }
    }
    if (record === undefined) {
      return undefined;
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
    let record = byId.get(previewId);
    if (record === undefined) {
      try {
        const stored = await getPreviewStore().get(previewId);
        if (stored) {
          const sandbox = await attachSandbox(stored);
          record = {
            appPort: await selectedAppPort(sandbox),
            buildSessionId: stored.buildSessionId,
            detail: stored.detail,
            hostPort: stored.hostPort,
            lastUsedAtMs: stored.lastUsedAt.getTime(),
            organizationId: stored.organizationId,
            previewId: stored.previewId,
            projectId: stored.projectId,
            runId: stored.runId,
            sandbox,
            status: stored.status,
          };
        }
      } catch {
        // Ignore
      }
    }
    if (record === undefined) {
      return undefined;
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
  const target = async (
    previewId: PreviewId
  ): Promise<PreviewTarget | undefined> => {
    let record = byId.get(previewId);
    if (record === undefined) {
      try {
        const stored = await getPreviewStore().get(previewId);
        if (stored) {
          const sandbox = await attachSandbox(stored);
          record = {
            appPort: await selectedAppPort(sandbox),
            buildSessionId: stored.buildSessionId,
            detail: stored.detail,
            hostPort: stored.hostPort,
            lastUsedAtMs: stored.lastUsedAt.getTime(),
            organizationId: stored.organizationId,
            previewId: stored.previewId,
            projectId: stored.projectId,
            runId: stored.runId,
            sandbox,
            status: stored.status,
          };
          byId.set(previewId, record);
          bySession.set(record.buildSessionId, record);
        }
      } catch {
        // Ignore
      }
    }
    if (record === undefined) {
      return undefined;
    }

    touched(record);
    return {
      detail: record.detail,
      hostPort: record.hostPort,
      organizationId: record.organizationId,
      projectId: record.projectId,
      status: record.status,
    };
  };

  /** Idle previews cost a container each, so the sweep is not optional. */
  const sweep = (): void => {
    const cutoff = nowMs() - IDLE_TTL_MS;
    for (const record of byId.values()) {
      if (record.lastUsedAtMs <= cutoff) {
        teardown(record).catch(() => undefined);
      }
    }
    const backgroundSweep = async (): Promise<void> => {
      try {
        const expired = await getPreviewStore().listExpired(new Date(cutoff));
        await Promise.all(
          expired
            .filter((item) => !byId.has(item.previewId))
            .map(async (item) => {
              if (item.runId && deps.isRunActive) {
                const active = await deps
                  .isRunActive(item.runId)
                  .catch(() => true);
                if (active) {
                  await getPreviewStore().touch(item.previewId);
                  return;
                }
              }
              const sandbox = await attachSandbox(item);
              if (sandbox) {
                await sandbox.destroy().catch(() => undefined);
              } else if (item.runId === null) {
                await execFileAsync("docker", [
                  "rm",
                  "-f",
                  "-v",
                  item.containerName,
                ]).catch(() => undefined);
              }
              await getPreviewStore().update(item.previewId, {
                status: "stopped",
              });
            })
        );
      } catch {
        // Ignore background sweep failure
      }
    };
    backgroundSweep().catch(() => undefined);
  };

  const timer = setInterval(sweep, IDLE_SWEEP_INTERVAL_MS);
  // The sweep must never be the reason the process stays alive.
  timer.unref();

  const disposeAll = async (): Promise<void> => {
    clearInterval(timer);
    await Promise.all(Array.from(byId.values(), (record) => teardown(record)));
  };

  return { disposeAll, recover, start, status, stop, sweepOrphans, target };
}
