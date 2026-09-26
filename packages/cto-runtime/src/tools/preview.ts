import type { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import type {
  BuildSessionId,
  PreviewSession,
} from "@reasonateai/contracts/execution";
import {
  PreviewSessionSchema,
  SandboxEnvironmentIdSchema,
} from "@reasonateai/contracts/execution";
import type {
  OrganizationId,
  ProjectId,
  RunId,
} from "@reasonateai/contracts/identity";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
} from "@reasonateai/contracts/identity";
import type { ISandbox } from "@reasonateai/contracts/sandbox";
import type { ProjectStateStore } from "@reasonateai/project-state/postgres";
import { z } from "zod";
import { readRunScope, sandboxIdFor } from "../run-scope.js";

export interface PreviewToolOptions {
  resolveSandbox?:
    | ((
        requestContext: RequestContext
      ) => Promise<ISandbox | undefined> | ISandbox | undefined)
    | undefined;
  store: () => ProjectStateStore;
}

export interface ExecutePreviewInput {
  expiresAt?: string | undefined;
  healthPath?: string | undefined;
  port: number;
  sandboxEnvironmentId?: string | undefined;
  sandboxId?: string | undefined;
  scope: {
    buildSessionId: BuildSessionId;
    organizationId: OrganizationId;
    projectId: ProjectId;
    runId?: RunId | undefined;
  };
  ttlSeconds?: number | undefined;
}

async function checkSandboxHealth(
  sandbox: ISandbox | undefined,
  port: number,
  healthPath?: string
): Promise<{ failureMessage: string | null; isHealthy: boolean }> {
  if (!(sandbox && typeof sandbox.runCommand === "function")) {
    return { failureMessage: null, isHealthy: true };
  }

  try {
    const path = healthPath ?? "/";
    const healthUrlCheck = `http://localhost:${port}${path}`;
    const curlRes = await sandbox.runCommand({
      args: ["-sf", healthUrlCheck],
      command: "curl",
      timeoutMs: 5000,
    });
    if (curlRes.exitCode === 0) {
      return { failureMessage: null, isHealthy: true };
    }
    return {
      failureMessage:
        curlRes.stderr ||
        curlRes.stdout ||
        `No service listening on port ${port} inside sandbox container`,
      isHealthy: false,
    };
  } catch (err: unknown) {
    const errMessage = err instanceof Error ? err.message : String(err);
    return {
      failureMessage:
        errMessage || "Health check command failed inside sandbox container",
      isHealthy: false,
    };
  }
}

export async function executePreviewSession(
  input: ExecutePreviewInput,
  options: {
    requestContext?: RequestContext | undefined;
    resolveSandbox?:
      | ((
          requestContext: RequestContext
        ) => Promise<ISandbox | undefined> | ISandbox | undefined)
      | undefined;
    store: ProjectStateStore;
  }
): Promise<PreviewSession> {
  const {
    expiresAt: inputExpiresAt,
    healthPath,
    port,
    sandboxEnvironmentId: inputSbxEnvId,
    sandboxId: inputSbxId,
    scope,
    ttlSeconds,
  } = input;

  const orgId = OrganizationIdSchema.parse(scope.organizationId);
  const projId = ProjectIdSchema.parse(scope.projectId);

  const buildSession = await options.store.getBuildSession(
    { organizationId: orgId, projectId: projId },
    scope.buildSessionId
  );

  const sandboxEnvironmentId =
    inputSbxEnvId ??
    buildSession?.sandboxEnvironmentId ??
    "00000000-0000-4000-8000-000000000099";

  const fallbackRunId = scope.buildSessionId as unknown as RunId;
  const sandboxId =
    inputSbxId ??
    sandboxIdFor({
      buildSessionId: scope.buildSessionId,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      runId: scope.runId ?? fallbackRunId,
    });

  const activePreviews = await options.store.listActivePreviews(
    { organizationId: orgId, projectId: projId },
    scope.buildSessionId
  );
  const existingPreview = activePreviews.find((p) => p.port === port);

  const ttlMs = (ttlSeconds ?? 3600) * 1000;
  const expiresAt =
    inputExpiresAt ?? new Date(Date.now() + ttlMs).toISOString();

  let preview: PreviewSession;
  if (existingPreview) {
    preview = await options.store.updatePreviewStatus({
      errorDetails: null,
      healthUrl: null,
      previewId: existingPreview.previewId,
      proxyUrl: null,
      scope: { organizationId: orgId, projectId: projId },
      status: "allocating",
    });
  } else {
    preview = await options.store.createPreview({
      buildSessionId: scope.buildSessionId,
      errorDetails: null,
      expiresAt,
      healthUrl: null,
      port,
      proxyUrl: null,
      sandboxEnvironmentId:
        SandboxEnvironmentIdSchema.parse(sandboxEnvironmentId),
      sandboxId,
      scope: { organizationId: orgId, projectId: projId },
      status: "allocating",
    });
  }

  let sandbox: ISandbox | undefined;
  let containerInitError: Error | null = null;

  try {
    if (options.resolveSandbox && options.requestContext) {
      sandbox = await options.resolveSandbox(options.requestContext);
    }
  } catch (err: unknown) {
    containerInitError = err instanceof Error ? err : new Error(String(err));
  }

  if (containerInitError) {
    const updated = await options.store.updatePreviewStatus({
      errorDetails: {
        code: "SANDBOX_INIT_FAILED",
        message: containerInitError.message,
        occurredAt: new Date().toISOString(),
        recoverable: true,
        stack: null,
        step: "sandbox_init",
      },
      healthUrl: null,
      previewId: preview.previewId,
      proxyUrl: null,
      scope: { organizationId: orgId, projectId: projId },
      status: "failed",
    });
    return PreviewSessionSchema.parse(updated);
  }

  const { failureMessage, isHealthy } = await checkSandboxHealth(
    sandbox,
    port,
    healthPath
  );

  const path = healthPath ?? "/";
  const healthUrl = `http://localhost:${port}${path}`;

  if (isHealthy) {
    const proxyUrl = port === 3000 ? null : `http://localhost:${port}`;

    const updated = await options.store.updatePreviewStatus({
      errorDetails: null,
      healthUrl,
      previewId: preview.previewId,
      proxyUrl,
      scope: { organizationId: orgId, projectId: projId },
      status: "ready",
    });
    return PreviewSessionSchema.parse(updated);
  }

  const updated = await options.store.updatePreviewStatus({
    errorDetails: {
      code: "HEALTH_CHECK_FAILED",
      message: `Preview health check failed: ${failureMessage || "Health check failed inside container."}`,
      occurredAt: new Date().toISOString(),
      recoverable: true,
      stack: null,
      step: "health_check",
    },
    healthUrl,
    previewId: preview.previewId,
    proxyUrl: null,
    scope: { organizationId: orgId, projectId: projId },
    status: "failed",
  });
  return PreviewSessionSchema.parse(updated);
}

export function createPreviewTool(options: PreviewToolOptions) {
  return createTool({
    description:
      "Register an application preview session, perform in-container health check, and manage allocating/ready/failed preview states.",
    execute: async (
      { healthPath, port, ttlSeconds },
      context
    ): Promise<PreviewSession> => {
      const scope = readRunScope(context.requestContext);
      return await executePreviewSession(
        {
          healthPath,
          port,
          scope: {
            buildSessionId: scope.buildSessionId,
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            runId: scope.runId,
          },
          ttlSeconds,
        },
        {
          requestContext: context.requestContext,
          resolveSandbox: options.resolveSandbox,
          store: options.store(),
        }
      );
    },
    id: "preview",
    inputSchema: z.strictObject({
      healthPath: z.string().optional(),
      port: z.number().int().min(1).max(65_535),
      ttlSeconds: z.number().int().positive().optional(),
    }),
    outputSchema: PreviewSessionSchema,
  });
}
