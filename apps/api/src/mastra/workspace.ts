import type {
  ExecuteCommandOptions,
  WorkspaceSandbox,
} from "@mastra/core/workspace";
import { WORKSPACE_TOOLS, Workspace } from "@mastra/core/workspace";
import { DockerSandbox } from "@mastra/docker";
import type {
  PlatformFacts,
  SandboxCapacity,
} from "@reasonateai/cto-runtime/context/environment";
import {
  type RunScope,
  readRunScope,
  sandboxIdFor,
} from "@reasonateai/cto-runtime/run-scope";
import type { CheckpointSandbox } from "@reasonateai/sandbox/checkpoint";
import { SandboxFilesystem } from "./sandbox-filesystem";

export function checkpointSandboxFor(
  sandbox: WorkspaceSandbox
): CheckpointSandbox {
  const executeCommand = sandbox.executeCommand?.bind(sandbox);
  const writeFiles = sandbox.writeFiles?.bind(sandbox);

  return {
    runCommand: async (request) => {
      if (executeCommand === undefined) {
        throw new Error("The resolved sandbox cannot execute commands.");
      }

      const options: ExecuteCommandOptions = {};
      if (request.cwd !== undefined) {
        options.cwd = request.cwd;
      }
      if (request.env !== undefined) {
        options.env = request.env;
      }
      if (request.timeoutMs !== undefined) {
        options.timeout = request.timeoutMs;
      }

      const startedAt = Date.now();
      const result = await executeCommand(
        request.command,
        request.args,
        options
      );
      if (result.stdoutTruncated === true) {
        throw new Error(
          "The sandbox truncated checkpoint output; partial checkpoints cannot be used."
        );
      }
      return {
        durationMs: result.executionTimeMs ?? Date.now() - startedAt,
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
        timedOut: result.timedOut ?? result.killed ?? false,
      };
    },
    writeFile: async (relativePath, content) => {
      if (writeFiles === undefined) {
        throw new Error("The resolved sandbox cannot write files.");
      }
      await writeFiles([
        {
          content: typeof content === "string" ? content : Buffer.from(content),
          path: relativePath,
        },
      ]);
    },
  };
}

const SANDBOX_CPU_PERIOD = 100_000;
const SANDBOX_CPU_QUOTA = 100_000;
const SANDBOX_IMAGE = "node:22";
const SANDBOX_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
export const SANDBOX_WORKING_DIRECTORY = "/workspace";

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

export function createBuildSandbox(scope: RunScope) {
  const sandboxId = sandboxIdFor(scope);
  const network = resolveBuildSandboxNetworkMode();
  const cacheVolume = resolveBuildSandboxCacheVolume();
  const mounts: Array<{
    source: string;
    target: string;
    type: "volume";
  }> = [
    {
      source: `${sandboxId}-workspace`,
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

  return new DockerSandbox({
    capDrop: ["ALL"],
    cpuPeriod: SANDBOX_CPU_PERIOD,
    cpuQuota: SANDBOX_CPU_QUOTA,
    env,
    id: sandboxId,
    image: SANDBOX_IMAGE,
    memory: SANDBOX_MEMORY_BYTES,
    memorySwap: SANDBOX_MEMORY_BYTES,
    mounts,
    network,
    pidsLimit: 256,
    securityOpt: ["no-new-privileges:true"],
    timeout: 120_000,
    workingDirectory: SANDBOX_WORKING_DIRECTORY,
  });
}

export const reasonateBuildWorkspace = new Workspace({
  filesystem: ({ requestContext }) => {
    const scope = readRunScope(requestContext);
    const sandboxId = sandboxIdFor(scope);
    return new SandboxFilesystem({
      id: `${sandboxId}-filesystem`,
      root: "/workspace",
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
