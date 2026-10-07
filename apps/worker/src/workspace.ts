import type { RequestContext } from "@mastra/core/request-context";
import type { WorkspaceSandbox } from "@mastra/core/workspace";
import { WORKSPACE_TOOLS, Workspace } from "@mastra/core/workspace";
import { APP_PREVIEW_RELAY_PORT } from "@reasonateai/contracts/execution";
import {
  DEFAULT_BUILD_SANDBOX_IMAGE,
  type SandboxConfig,
  SandboxIdSchema,
  SandboxImageReferenceSchema,
} from "@reasonateai/contracts/sandbox";
import type {
  PlatformFacts,
  SandboxCapacity,
} from "@reasonateai/cto-runtime/context/environment";
import {
  type RunScope,
  readRunScope,
  sandboxIdFor,
} from "@reasonateai/cto-runtime/run-scope";
import { DockerSandbox } from "@reasonateai/sandbox/docker";
import { MastraWorkspaceSandboxAdapter } from "@reasonateai/sandbox/mastra";
import { SandboxFilesystem } from "./sandbox-filesystem.js";

/**
 * The build workspace the CTO runs in, carried into the execution plane.
 *
 * Applications compose packages and never import each other, so this file
 * mirrors `apps/api/src/mastra/workspace.ts` rather than reaching across
 * applications. It must stay identical in substance: the sandbox identity is
 * derived from the run scope alone, so a person chatting through the API and a
 * worker executing the same build session resolve the same container name, the
 * same workspace volume, and the same enforced capacity facts.
 */

const SANDBOX_CPU_PERIOD = 100_000;
const SANDBOX_CPU_QUOTA = 100_000;
const SANDBOX_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
export const SANDBOX_WORKING_DIRECTORY = "/workspace";

/** Named volume the build workspace mounts, so a launch has to remove it too. */
const WORKSPACE_VOLUME_SUFFIX = "-workspace";

/**
 * What the agent's tools actually execute in.
 *
 * Probed from inside a running build sandbox, not assumed: the shell is `sh` and
 * the architecture follows the host. Capacity is the enforced cgroup quota
 * rather than what the container reports — `nproc` and `/proc/meminfo` inside
 * the sandbox describe the host, so reading them would tell the agent it has 12
 * CPUs and 7.6 GiB when its work is capped at one CPU and 2 GiB.
 *
 * `HOME` is the workspace, so the home directory every tool falls back to — the
 * npm cache, tool configs, a global install prefix — lands on the volume that
 * survives the container instead of the container's throwaway overlay layer.
 */
export const buildSandboxEnvironment: {
  capacity: SandboxCapacity;
  platform: PlatformFacts;
} = {
  capacity: {
    cpus: SANDBOX_CPU_QUOTA / SANDBOX_CPU_PERIOD,
    memoryBytes: SANDBOX_MEMORY_BYTES,
  },
  platform: {
    arch: "x64",
    homeDir: SANDBOX_WORKING_DIRECTORY,
    os: "linux",
    shell: "/bin/sh",
  },
};

export function resolveBuildSandboxNetworkMode(
  env: NodeJS.ProcessEnv = process.env
): "bridge" | "none" {
  const candidate = (
    env.REASONATE_SANDBOX_NETWORK_MODE ??
    env.SANDBOX_NETWORK_MODE ??
    "bridge"
  )
    .trim()
    .toLowerCase();
  return candidate === "none" ? "none" : "bridge";
}

export function resolveBuildSandboxImage(
  env: NodeJS.ProcessEnv = process.env
): string {
  const candidate = env.REASONATE_BUILD_SANDBOX_IMAGE?.trim();
  return SandboxImageReferenceSchema.parse(
    candidate && candidate.length > 0 ? candidate : DEFAULT_BUILD_SANDBOX_IMAGE
  );
}

export function resolveBuildSandboxCacheVolume(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const candidate = (
    env.REASONATE_PACKAGE_CACHE_VOLUME ?? env.SANDBOX_CACHE_VOLUME
  )?.trim();
  if (!candidate || candidate.length === 0) {
    return undefined;
  }
  if (candidate.toLowerCase().includes("docker.sock")) {
    throw new Error("Mounting the host Docker socket is forbidden.");
  }
  return candidate;
}

function createBuildSandbox(scope: RunScope) {
  const sandboxId = sandboxIdFor(scope);
  const network = resolveBuildSandboxNetworkMode();
  const cacheVolume = resolveBuildSandboxCacheVolume();
  const mounts: Array<{
    source: string;
    target: string;
    type: "volume";
  }> = [
    {
      source: `${sandboxId}${WORKSPACE_VOLUME_SUFFIX}`,
      target: SANDBOX_WORKING_DIRECTORY,
      type: "volume",
    },
  ];
  const env: Record<string, string> = {
    HOME: SANDBOX_WORKING_DIRECTORY,
  };
  if (cacheVolume) {
    mounts.push({
      source: cacheVolume,
      target: "/root/.npm",
      type: "volume",
    });
    env.npm_config_cache = "/root/.npm";
  }

  const config: SandboxConfig = {
    cpuLimit: SANDBOX_CPU_QUOTA / SANDBOX_CPU_PERIOD,
    env,
    id: SandboxIdSchema.parse(sandboxId),
    image: resolveBuildSandboxImage(),
    memoryLimitMb: SANDBOX_MEMORY_BYTES / (1024 * 1024),
    mounts: mounts.map((mount) => ({ ...mount, readonly: false })),
    networkMode: network,
    ports: [APP_PREVIEW_RELAY_PORT],
    projectId: scope.projectId,
    runId: scope.runId,
    timeoutMs: 120_000,
    workdir: SANDBOX_WORKING_DIRECTORY,
  };
  const sandbox = new DockerSandbox(config, sandboxId);
  return new MastraWorkspaceSandboxAdapter({ config, sandbox });
}

export const reasonateBuildWorkspace = new Workspace({
  filesystem: ({ requestContext }) => {
    const scope = readRunScope(requestContext);
    const sandboxId = sandboxIdFor(scope);
    return new SandboxFilesystem({
      id: `${sandboxId}-filesystem`,
      root: SANDBOX_WORKING_DIRECTORY,
      sandbox: createBuildSandbox(scope),
    });
  },
  id: "reasonate-build-workspace",
  name: "ReasonateAI Build Workspace",
  sandbox: ({ requestContext }) => {
    const scope = readRunScope(requestContext);
    return createBuildSandbox(scope);
  },
  sandboxCacheKey: ({ requestContext }) =>
    sandboxIdFor(readRunScope(requestContext)),
  tools: {
    [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]: { enabled: false },
    [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: { enabled: false },
    [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: { enabled: false },
    [WORKSPACE_TOOLS.FILESYSTEM.DELETE]: {
      enabled: false,
    },
    [WORKSPACE_TOOLS.FILESYSTEM.MKDIR]: { enabled: false },
    [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: {
      maxOutputTokens: 10_000,
      requireApproval: false,
    },
  },
});

/**
 * Resolves the sandbox the tools will use for this run. The workspace caches it
 * against the request context, so the sandbox a worker starts, restores, and
 * destroys is the same one the agent's commands execute in.
 */
export async function resolveBuildSandbox(input: {
  requestContext: RequestContext;
}): Promise<WorkspaceSandbox> {
  const sandbox = await reasonateBuildWorkspace.resolveSandbox({
    requestContext: input.requestContext,
  });
  if (sandbox === undefined) {
    throw new Error("The build workspace resolved no sandbox for this run.");
  }
  return sandbox;
}

/** A destroyed sandbox cannot serve a later turn in the same build session. */
export function releaseBuildSandbox(scope: RunScope): void {
  reasonateBuildWorkspace.clearSandboxCache(sandboxIdFor(scope));
}

/** The build workspace names its volume after the run's scope; nothing else is touched. */
export function workspaceVolumeName(scope: RunScope): string {
  return `${sandboxIdFor(scope)}${WORKSPACE_VOLUME_SUFFIX}`;
}
