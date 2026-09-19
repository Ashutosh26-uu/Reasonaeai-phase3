import { WORKSPACE_TOOLS, Workspace } from "@mastra/core/workspace";
import { DockerSandbox } from "@mastra/docker";
import { readRunScope, sandboxIdFor } from "@reasonateai/cto-runtime/run-scope";

export const reasonateBuildWorkspace = new Workspace({
  id: "reasonate-build-workspace",
  name: "ReasonateAI Build Workspace",
  sandbox: ({ requestContext }) => {
    const scope = readRunScope(requestContext);
    return new DockerSandbox({
      capDrop: ["ALL"],
      cpuPeriod: 100_000,
      cpuQuota: 100_000,
      id: sandboxIdFor(scope),
      image: "node:22-slim",
      memory: 2 * 1024 * 1024 * 1024,
      memorySwap: 2 * 1024 * 1024 * 1024,
      network: "none",
      pidsLimit: 256,
      securityOpt: ["no-new-privileges:true"],
      timeout: 120_000,
      workingDirectory: "/workspace",
    });
  },
  sandboxCacheKey: ({ requestContext }) =>
    sandboxIdFor(readRunScope(requestContext)),
  tools: {
    requireApproval: true,
    [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: {
      requireApproval: true,
      requireReadBeforeWrite: true,
    },
    [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: {
      requireApproval: true,
      requireReadBeforeWrite: true,
    },
    [WORKSPACE_TOOLS.FILESYSTEM.DELETE]: {
      requireApproval: true,
    },
    [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: {
      maxOutputTokens: 10_000,
      requireApproval: true,
    },
  },
});
