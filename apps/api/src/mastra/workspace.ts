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
import { SandboxFilesystem } from "./sandbox-filesystem";

const SANDBOX_CPU_PERIOD = 100_000;
const SANDBOX_CPU_QUOTA = 100_000;
const SANDBOX_IMAGE = "node:22-slim";
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

function createBuildSandbox(scope: RunScope) {
  const sandboxId = sandboxIdFor(scope);
  return new DockerSandbox({
    capDrop: ["ALL"],
    cpuPeriod: SANDBOX_CPU_PERIOD,
    cpuQuota: SANDBOX_CPU_QUOTA,
    env: { HOME: SANDBOX_WORKING_DIRECTORY },
    id: sandboxId,
    image: SANDBOX_IMAGE,
    memory: SANDBOX_MEMORY_BYTES,
    memorySwap: SANDBOX_MEMORY_BYTES,
    mounts: [
      {
        source: `${sandboxId}-workspace`,
        target: SANDBOX_WORKING_DIRECTORY,
        type: "volume",
      },
    ],
    network: "none",
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
