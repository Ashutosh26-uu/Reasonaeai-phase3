import { WORKSPACE_TOOLS, Workspace } from "@mastra/core/workspace";
import { DockerSandbox } from "@mastra/docker";
import { readRunScope, sandboxIdFor } from "@reasonateai/cto-runtime/run-scope";
import { SandboxFilesystem } from "./sandbox-filesystem";

function createBuildSandbox(scope: ReturnType<typeof readRunScope>) {
  const sandboxId = sandboxIdFor(scope);
  return new DockerSandbox({
    capDrop: ["ALL"],
    cpuPeriod: 100_000,
    cpuQuota: 100_000,
    id: sandboxId,
    image: "node:22-slim",
    memory: 2 * 1024 * 1024 * 1024,
    memorySwap: 2 * 1024 * 1024 * 1024,
    mounts: [
      {
        source: `${sandboxId}-workspace`,
        target: "/workspace",
        type: "volume",
      },
    ],
    network: "none",
    pidsLimit: 256,
    securityOpt: ["no-new-privileges:true"],
    timeout: 120_000,
    workingDirectory: "/workspace",
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
