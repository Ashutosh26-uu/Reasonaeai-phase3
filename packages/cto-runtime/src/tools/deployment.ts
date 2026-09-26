import { createTool } from "@mastra/core/tools";
import type {
  Deployment,
  GitCheckpoint,
} from "@reasonateai/contracts/execution";
import {
  DeploymentExposureSchema,
  DeploymentSchema,
} from "@reasonateai/contracts/execution";
import type { ProjectStateStore } from "@reasonateai/project-state/postgres";
import { z } from "zod";
import { readRunScope } from "../run-scope.js";

export interface DeploymentToolOptions {
  store: () => ProjectStateStore;
}

export function createDeploymentTool(options: DeploymentToolOptions) {
  return createTool({
    description:
      "Initiate a deployment request from a verified source checkpoint for the current run and scope.",
    execute: async (
      { exposure, providerReference, sourceCheckpoint },
      context
    ): Promise<Deployment> => {
      const scope = readRunScope(context.requestContext);

      const tenantScope = {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
      };

      const checkpoints = await options.store().listCheckpoints(tenantScope);
      const matchingCheckpoint = checkpoints.find(
        (cp: GitCheckpoint) =>
          cp.commitHash === sourceCheckpoint ||
          cp.checkpointId === sourceCheckpoint
      );

      if (!matchingCheckpoint) {
        throw new Error(
          `Source checkpoint '${sourceCheckpoint}' does not exist in project scope.`
        );
      }

      const deploymentId = crypto.randomUUID();
      const recorded = await options.store().recordDeployment({
        deploymentId,
        exposure,
        providerReference,
        runId: scope.runId,
        scope: tenantScope,
        sourceCheckpoint,
        status: "pending",
        url: null,
      });

      return DeploymentSchema.parse({
        createdAt: new Date().toISOString(),
        deploymentId: recorded.deploymentId,
        exposure: recorded.exposure as "public" | "internal" | "private",
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        providerReference: recorded.providerReference,
        rollbackDeploymentId: recorded.rollbackDeploymentId,
        runId: scope.runId,
        sourceCheckpoint: recorded.sourceCheckpoint,
        status: recorded.status as
          | "pending"
          | "building"
          | "ready"
          | "failed"
          | "rolled_back"
          | "stopped",
        updatedAt: recorded.updatedAt,
        url: recorded.url,
      });
    },
    id: "deployment",
    inputSchema: z.strictObject({
      exposure: DeploymentExposureSchema,
      providerReference: z.string().min(1).max(512),
      sourceCheckpoint: z.string().min(1).max(256),
    }),
    outputSchema: DeploymentSchema,
  });
}
