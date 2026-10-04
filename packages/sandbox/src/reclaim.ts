import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  type BuildSessionId,
  BuildSessionIdSchema,
} from "@reasonateai/contracts/execution";
import {
  type OrganizationId,
  OrganizationIdSchema,
  type ProjectId,
  ProjectIdSchema,
  RunIdSchema,
} from "@reasonateai/contracts/identity";
import {
  type CheckpointSandbox,
  type CheckpointStore,
  snapshotSandbox,
} from "./checkpoint.js";

const execFileAsync = promisify(execFile);

/**
 * Strict regex matching only Reasonate workspace volumes.
 * Format: reasonate-<organizationId>-<projectId>-<buildSessionId>-workspace
 * Guarantees that non-Reasonate host volumes (system, database, third-party) are NEVER touched.
 */
export const REASONATE_WORKSPACE_VOLUME_RE =
  /^reasonate-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-workspace$/;

export interface ParsedWorkspaceVolumeScope {
  readonly buildSessionId: BuildSessionId;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly volumeName: string;
}

export interface RetainedVolumeInfo {
  readonly activeContainers: readonly string[];
  readonly ageMs: number;
  readonly createdAt: Date;
  readonly scope: ParsedWorkspaceVolumeScope;
  readonly stoppedContainers: readonly string[];
  readonly volumeName: string;
}

export type ReclaimStatus =
  | "dry_run"
  | "error"
  | "reclaimed"
  | "recovered_and_reclaimed"
  | "skipped_active_container"
  | "skipped_no_checkpoint"
  | "skipped_unexpired";

export interface ReclaimVolumeResult {
  readonly ageMs?: number | undefined;
  readonly error?: string | undefined;
  readonly reason: string;
  readonly recoveryCheckpointId?: string | undefined;
  readonly scope?: ParsedWorkspaceVolumeScope | undefined;
  readonly status: ReclaimStatus;
  readonly volumeName: string;
}

export interface ReclaimVolumesSummary {
  readonly errors: number;
  readonly reclaimed: number;
  readonly results: readonly ReclaimVolumeResult[];
  readonly skipped: number;
  readonly totalInspected: number;
}

export type DockerExecutor = (
  file: string,
  args: readonly string[]
) => Promise<{ stderr: string; stdout: string }>;

export interface ReclaimPolicyOptions {
  /** Checkpoint store to verify existing checkpoints or save recovery snapshots. */
  readonly checkpointStore?: CheckpointStore | undefined;
  /** If true, evaluate without deleting volumes or containers. */
  readonly dryRun?: boolean | undefined;
  /** Custom docker executor for testing or custom host environments. */
  readonly execDocker?: DockerExecutor | undefined;
  /** If true, reclaim even if no checkpoint exists in the store (as long as maxAgeMs expired or force is true). */
  readonly force?: boolean | undefined;
  /** Maximum age in milliseconds before an unmounted volume is considered expired and reclaimable. */
  readonly maxAgeMs?: number | undefined;
  /** Filter reclamation to a specific organization. */
  readonly organizationId?: OrganizationId | undefined;
  /** Filter reclamation to a specific project. */
  readonly projectId?: ProjectId | undefined;
  /** If true, attempt to snapshot uncheckpointed volume data into the store before deleting the volume. */
  readonly recoverBeforeReclaim?: boolean | undefined;
}

/**
 * Validates and extracts tenant identifiers from a Docker volume name.
 * Returns undefined for any volume that does not conform to the Reasonate workspace specification.
 */
export function parseWorkspaceVolumeName(
  volumeName: string
): ParsedWorkspaceVolumeScope | undefined {
  const match: RegExpExecArray | null = REASONATE_WORKSPACE_VOLUME_RE.exec(
    volumeName.trim()
  );
  if (match === null) {
    return undefined;
  }

  const orgResult = OrganizationIdSchema.safeParse(match[1]);
  const projResult = ProjectIdSchema.safeParse(match[2]);
  const sessionResult = BuildSessionIdSchema.safeParse(match[3]);

  if (!(orgResult.success && projResult.success && sessionResult.success)) {
    return undefined;
  }

  return {
    buildSessionId: sessionResult.data,
    organizationId: orgResult.data,
    projectId: projResult.data,
    volumeName: volumeName.trim(),
  };
}

function parseContainerIdLines(output: string): string[] {
  return output
    .trim()
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Inspects a specific Reasonate workspace volume, retrieving its scope, creation date,
 * and associated active/stopped container IDs.
 */
export async function inspectWorkspaceVolume(
  volumeName: string,
  execDocker: DockerExecutor = execFileAsync
): Promise<RetainedVolumeInfo | undefined> {
  const scope = parseWorkspaceVolumeName(volumeName);
  if (!scope) {
    return undefined;
  }

  try {
    const inspectResult = await execDocker("docker", [
      "volume",
      "inspect",
      scope.volumeName,
    ]);
    const parsed = JSON.parse(inspectResult.stdout);
    const volumeData = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!volumeData?.CreatedAt) {
      return undefined;
    }

    const createdAt = new Date(volumeData.CreatedAt);
    const ageMs = Math.max(0, Date.now() - createdAt.getTime());

    const runningResult = await execDocker("docker", [
      "ps",
      "-q",
      "--filter",
      `volume=${scope.volumeName}`,
    ]).catch(() => ({ stderr: "", stdout: "" }));

    const activeContainers = parseContainerIdLines(runningResult.stdout);

    const allContainersResult = await execDocker("docker", [
      "ps",
      "-a",
      "-q",
      "--filter",
      `volume=${scope.volumeName}`,
    ]).catch(() => ({ stderr: "", stdout: "" }));

    const allContainers = parseContainerIdLines(allContainersResult.stdout);
    const activeSet = new Set(activeContainers);
    const stoppedContainers = allContainers.filter((id) => !activeSet.has(id));

    return {
      activeContainers,
      ageMs,
      createdAt,
      scope,
      stoppedContainers,
      volumeName: scope.volumeName,
    };
  } catch {
    return undefined;
  }
}

/**
 * Lists all retained Reasonate workspace volumes on the Docker host matching optional filters.
 */
export async function listRetainedWorkspaceVolumes(
  options: Pick<
    ReclaimPolicyOptions,
    "execDocker" | "organizationId" | "projectId"
  > = {}
): Promise<readonly RetainedVolumeInfo[]> {
  const execDocker = options.execDocker ?? execFileAsync;
  try {
    const listed = await execDocker("docker", [
      "volume",
      "ls",
      "-q",
      "--filter",
      "name=reasonate-",
    ]);

    const lines = parseContainerIdLines(listed.stdout);
    const scopes = lines
      .map(parseWorkspaceVolumeName)
      .filter((s): s is ParsedWorkspaceVolumeScope => s !== undefined)
      .filter(
        (s) =>
          !options.organizationId || s.organizationId === options.organizationId
      )
      .filter((s) => !options.projectId || s.projectId === options.projectId);

    const inspected = await Promise.all(
      scopes.map((scope) =>
        inspectWorkspaceVolume(scope.volumeName, execDocker)
      )
    );

    return inspected.filter(
      (info): info is RetainedVolumeInfo => info !== undefined
    );
  } catch {
    return [];
  }
}

interface EligibilityDecision {
  readonly eligible: boolean;
  readonly error?: string | undefined;
  readonly reason: string;
  readonly recoveryCheckpointId?: string | undefined;
  readonly status?: ReclaimStatus | undefined;
}

async function evaluateCheckpointStoreEligibility(
  info: RetainedVolumeInfo,
  options: ReclaimPolicyOptions,
  execDocker: DockerExecutor
): Promise<EligibilityDecision> {
  const { checkpointStore } = options;
  if (!checkpointStore) {
    if (
      options.maxAgeMs !== undefined &&
      info.ageMs < options.maxAgeMs &&
      !options.force
    ) {
      return {
        eligible: false,
        reason: `Volume age (${info.ageMs}ms) is within the retention window (${options.maxAgeMs}ms).`,
        status: "skipped_unexpired",
      };
    }
    return {
      eligible: true,
      reason: "Volume eligible under general policy.",
    };
  }

  const latest = await checkpointStore
    .latest({
      organizationId: info.scope.organizationId,
      projectId: info.scope.projectId,
    })
    .catch(() => undefined);

  if (latest !== undefined) {
    return {
      eligible: true,
      reason: "Verified checkpoint found in store.",
    };
  }

  if (options.recoverBeforeReclaim) {
    try {
      const recoveryCheckpointId = await recoverWorkspaceVolumeToCheckpoint({
        checkpointStore,
        execDocker,
        scope: info.scope,
      });
      return {
        eligible: true,
        reason: "Volume recovered into checkpoint.",
        recoveryCheckpointId,
      };
    } catch (err: unknown) {
      if (!options.force) {
        return {
          eligible: false,
          error: err instanceof Error ? err.message : String(err),
          reason: "Recovery snapshot failed and force flag was not set.",
          status: "error",
        };
      }
    }
  }

  const isExpired =
    options.maxAgeMs !== undefined && info.ageMs >= options.maxAgeMs;
  if (!(isExpired || options.force)) {
    return {
      eligible: false,
      reason:
        "No verified checkpoint found in store and volume has not exceeded retention TTL.",
      status: "skipped_no_checkpoint",
    };
  }

  return {
    eligible: true,
    reason: "Volume eligible via expiration or force override.",
  };
}

/**
 * Reclaims a single retained workspace volume after verifying safety constraints.
 */
export async function reclaimRetainedWorkspaceVolume(
  volumeTarget: string | RetainedVolumeInfo,
  options: ReclaimPolicyOptions = {}
): Promise<ReclaimVolumeResult> {
  const execDocker = options.execDocker ?? execFileAsync;
  const targetName =
    typeof volumeTarget === "string" ? volumeTarget : volumeTarget.volumeName;

  const scope = parseWorkspaceVolumeName(targetName);
  if (!scope) {
    return {
      reason:
        "Volume does not match the Reasonate workspace volume naming schema.",
      status: "error",
      volumeName: targetName,
    };
  }

  const info =
    typeof volumeTarget === "object"
      ? volumeTarget
      : await inspectWorkspaceVolume(scope.volumeName, execDocker);

  if (!info) {
    return {
      reason: "Volume not found or inspection failed.",
      scope,
      status: "error",
      volumeName: scope.volumeName,
    };
  }

  if (info.activeContainers.length > 0) {
    return {
      ageMs: info.ageMs,
      reason: `Volume is currently mounted by ${info.activeContainers.length} active container(s).`,
      scope,
      status: "skipped_active_container",
      volumeName: scope.volumeName,
    };
  }

  const decision = await evaluateCheckpointStoreEligibility(
    info,
    options,
    execDocker
  );
  if (!decision.eligible) {
    return {
      ageMs: info.ageMs,
      error: decision.error,
      reason: decision.reason,
      scope,
      status: decision.status ?? "error",
      volumeName: scope.volumeName,
    };
  }

  if (options.dryRun) {
    return {
      ageMs: info.ageMs,
      reason: "Volume is eligible for safe reclamation (dry run).",
      recoveryCheckpointId: decision.recoveryCheckpointId,
      scope,
      status: "dry_run",
      volumeName: scope.volumeName,
    };
  }

  if (info.stoppedContainers.length > 0) {
    await execDocker("docker", [
      "rm",
      "-f",
      "-v",
      ...info.stoppedContainers,
    ]).catch(() => ({ stderr: "", stdout: "" }));
  }

  try {
    await execDocker("docker", ["volume", "rm", "-f", scope.volumeName]);
    const finalStatus: ReclaimStatus = decision.recoveryCheckpointId
      ? "recovered_and_reclaimed"
      : "reclaimed";
    return {
      ageMs: info.ageMs,
      reason: decision.recoveryCheckpointId
        ? "Volume successfully snapshotted to checkpoint store and reclaimed."
        : "Volume safely reclaimed.",
      recoveryCheckpointId: decision.recoveryCheckpointId,
      scope,
      status: finalStatus,
      volumeName: scope.volumeName,
    };
  } catch (error) {
    return {
      ageMs: info.ageMs,
      error: error instanceof Error ? error.message : String(error),
      reason: "Failed to remove Docker volume.",
      scope,
      status: "error",
      volumeName: scope.volumeName,
    };
  }
}

/**
 * Sweeps all retained Reasonate workspace volumes on the host according to policy.
 */
export async function reclaimRetainedWorkspaceVolumes(
  options: ReclaimPolicyOptions = {}
): Promise<ReclaimVolumesSummary> {
  const volumes = await listRetainedWorkspaceVolumes(options);
  const results = await Promise.all(
    volumes.map((vol) => reclaimRetainedWorkspaceVolume(vol, options))
  );

  let reclaimed = 0;
  let skipped = 0;
  let errors = 0;

  for (const result of results) {
    if (
      result.status === "reclaimed" ||
      result.status === "recovered_and_reclaimed"
    ) {
      reclaimed += 1;
    } else if (result.status === "error") {
      errors += 1;
    } else {
      skipped += 1;
    }
  }

  return {
    errors,
    reclaimed,
    results,
    skipped,
    totalInspected: volumes.length,
  };
}

async function recoverWorkspaceVolumeToCheckpoint(input: {
  checkpointStore: CheckpointStore;
  execDocker: DockerExecutor;
  scope: ParsedWorkspaceVolumeScope;
}): Promise<string> {
  const { checkpointStore, execDocker, scope } = input;
  const recoveryContainerId = `reasonate-rec-${randomUUID()}`;
  const recoveryRunId = RunIdSchema.parse(randomUUID());

  await execDocker("docker", [
    "run",
    "-d",
    "--name",
    recoveryContainerId,
    "-v",
    `${scope.volumeName}:/workspace`,
    "--network",
    "none",
    "node:22",
    "sleep",
    "120",
  ]);

  try {
    const sandbox: CheckpointSandbox = {
      runCommand: async (req) => {
        const cmdArgs = ["exec"];
        if (req.cwd) {
          cmdArgs.push("-w", req.cwd);
        }
        if (req.env) {
          for (const [key, val] of Object.entries(req.env)) {
            cmdArgs.push("-e", `${key}=${val}`);
          }
        }
        cmdArgs.push(recoveryContainerId, req.command, ...(req.args ?? []));
        const startTime = Date.now();
        try {
          const res = await execDocker("docker", cmdArgs);
          return {
            durationMs: Date.now() - startTime,
            exitCode: 0,
            stderr: res.stderr,
            stdout: res.stdout,
            timedOut: false,
          };
        } catch (error: unknown) {
          const err = error as {
            code?: number;
            message?: string;
            stderr?: string;
            stdout?: string;
          };
          return {
            durationMs: Date.now() - startTime,
            exitCode: typeof err.code === "number" ? err.code : 1,
            stderr: err.stderr ?? err.message ?? "Unknown command error",
            stdout: err.stdout ?? "",
            timedOut: false,
          };
        }
      },
      writeFile: async (filePath, content) => {
        const base64 = Buffer.from(content).toString("base64");
        await execDocker("docker", [
          "exec",
          "-w",
          "/workspace",
          recoveryContainerId,
          "sh",
          "-c",
          `echo '${base64}' | base64 -d > "${filePath}"`,
        ]);
      },
    };

    const writeResult = await snapshotSandbox({
      buildSessionId: scope.buildSessionId,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      runId: recoveryRunId,
      sandbox,
      store: checkpointStore,
      workdir: "/workspace",
    });

    return writeResult.checkpointId;
  } finally {
    await execDocker("docker", ["rm", "-f", "-v", recoveryContainerId]).catch(
      () => ({ stderr: "", stdout: "" })
    );
  }
}
