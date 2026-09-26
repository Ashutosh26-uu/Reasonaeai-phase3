import { authorize } from "@reasonateai/auth/authorize";
import type { ApiErrorCode } from "@reasonateai/contracts/api-error";
import {
  CreateDeploymentRequestSchema,
  DeploymentIdSchema,
  RollbackDeploymentRequestSchema,
} from "@reasonateai/contracts/execution";
import {
  OrganizationIdSchema,
  type Permission,
  ProjectIdSchema,
  type RunId,
  SessionIdSchema,
  type UserPrincipal,
  type WorkloadPrincipal,
} from "@reasonateai/contracts/identity";
import type { ProjectStateStore } from "@reasonateai/project-state/postgres";
import { apiErrorResponse } from "../principal.js";

export const PROJECT_DEPLOYMENTS_PATH = "/v1/projects/:projectId/deployments";
export const DEPLOYMENT_ROLLBACK_PATH =
  "/v1/deployments/:deploymentId/rollback";

export interface HandlerContext {
  json: (body: unknown, status: number) => Response;
  req: {
    header: (name: string) => string | undefined;
    json: () => Promise<unknown>;
    param: (name: string) => string | undefined;
    query: (name: string) => string | undefined;
    raw?: { signal?: AbortSignal };
  };
}

const DENIAL_BY_REASON: Record<string, ApiErrorCode> = {
  CAPABILITY_EXPIRED: "unauthenticated",
  MEMBERSHIP_PRINCIPAL_MISMATCH: "forbidden",
  ORGANIZATION_MEMBERSHIP_INACTIVE: "forbidden",
  ORGANIZATION_MEMBERSHIP_REQUIRED: "forbidden",
  ORGANIZATION_SCOPE_MISMATCH: "forbidden",
  PERMISSION_DENIED: "forbidden",
  PROJECT_MEMBERSHIP_INACTIVE: "forbidden",
  PROJECT_MEMBERSHIP_REQUIRED: "forbidden",
  PROJECT_SCOPE_MISMATCH: "forbidden",
  SESSION_EXPIRED: "unauthenticated",
  SESSION_REVOKED: "unauthenticated",
  UNAUTHENTICATED: "unauthenticated",
};

export interface DeploymentRouteDeps {
  resolvePrincipal: (input: {
    cookieHeader: string | undefined;
  }) => Promise<UserPrincipal | WorkloadPrincipal | undefined>;
  store: () => ProjectStateStore;
}

async function authorizeProjectAction(input: {
  action: Permission;
  deps: DeploymentRouteDeps;
  organizationId: string;
  principal: UserPrincipal | WorkloadPrincipal;
  projectId: string;
}) {
  if (input.principal.kind === "workload") {
    return authorize({
      action: input.action,
      now: new Date().toISOString(),
      organizationMembership: null,
      principal: input.principal,
      projectMembership: null,
      resource: {
        kind: "project",
        organizationId: OrganizationIdSchema.parse(input.organizationId),
        projectId: ProjectIdSchema.parse(input.projectId),
        resourceId: null,
      },
    });
  }

  const organizationMembership = await input.deps
    .store()
    .memberships.getOrganizationMembership({
      organizationId: input.organizationId,
      userId: input.principal.userId,
    });

  const projectMembership = await input.deps
    .store()
    .memberships.getProjectMembership({
      organizationId: input.organizationId,
      projectId: input.projectId,
      userId: input.principal.userId,
    });

  return authorize({
    action: input.action,
    now: new Date().toISOString(),
    organizationMembership: organizationMembership ?? null,
    principal: input.principal,
    projectMembership: projectMembership ?? null,
    resource: {
      kind: "project",
      organizationId: OrganizationIdSchema.parse(input.organizationId),
      projectId: ProjectIdSchema.parse(input.projectId),
      resourceId: null,
    },
  });
}

export function createDeploymentHandlers(deps: DeploymentRouteDeps) {
  return {
    create: async (c: HandlerContext): Promise<Response> => {
      const rid = c.req.header("x-request-id") ?? crypto.randomUUID();

      const principal = await deps.resolvePrincipal({
        cookieHeader: c.req.header("cookie"),
      });
      if (!principal) {
        return apiErrorResponse({
          code: "unauthenticated",
          message: "A valid session is required for this request.",
          requestId: rid,
        });
      }

      const projIdParam = ProjectIdSchema.safeParse(c.req.param("projectId"));
      if (!projIdParam.success) {
        return apiErrorResponse({
          code: "invalid_request",
          message: "A valid projectId path parameter is required.",
          requestId: rid,
        });
      }

      const bodyParse = CreateDeploymentRequestSchema.safeParse(
        await c.req.json()
      );
      if (!bodyParse.success) {
        return apiErrorResponse({
          code: "invalid_request",
          message: "Invalid deployment creation request body.",
          requestId: rid,
        });
      }

      if (bodyParse.data.projectId !== projIdParam.data) {
        return apiErrorResponse({
          code: "invalid_request",
          message: "projectId in path and body must match.",
          requestId: rid,
        });
      }

      const scope = {
        organizationId: bodyParse.data.organizationId,
        projectId: bodyParse.data.projectId,
      };

      const decision = await authorizeProjectAction({
        action: "agent:run",
        deps,
        organizationId: scope.organizationId,
        principal,
        projectId: scope.projectId,
      });

      if (!decision.allowed) {
        return apiErrorResponse({
          code: DENIAL_BY_REASON[decision.reason] ?? "forbidden",
          message:
            "You are not authorized to create deployments in this project.",
          requestId: rid,
        });
      }

      // Checkpoints check
      const checkpoints = await deps.store().listCheckpoints(scope);
      const matchingCheckpoint = checkpoints.find(
        (cp) =>
          cp.commitHash === bodyParse.data.sourceCheckpoint ||
          cp.checkpointId === bodyParse.data.sourceCheckpoint
      );

      let runIdToUse: RunId;
      if (matchingCheckpoint) {
        runIdToUse = matchingCheckpoint.runId;
      } else {
        // Fall back to active build session run ID
        const activeAlloc = await deps.store().allocateBuildSession({
          idempotencyKey: `deploy-lookup-${rid}`,
          scope,
          userSessionId:
            principal.kind === "user"
              ? principal.sessionId
              : SessionIdSchema.parse(scope.projectId),
        });
        runIdToUse = activeAlloc.buildSession.runId;
      }

      const deploymentId = crypto.randomUUID();
      const deployment = await deps.store().recordDeployment({
        deploymentId,
        exposure: bodyParse.data.exposure,
        providerReference: bodyParse.data.providerReference,
        runId: runIdToUse,
        scope,
        sourceCheckpoint: bodyParse.data.sourceCheckpoint,
        status: "pending",
        url: null,
      });

      return c.json({ deployment }, 201);
    },

    list: async (c: HandlerContext): Promise<Response> => {
      const rid = c.req.header("x-request-id") ?? crypto.randomUUID();

      const principal = await deps.resolvePrincipal({
        cookieHeader: c.req.header("cookie"),
      });
      if (!principal) {
        return apiErrorResponse({
          code: "unauthenticated",
          message: "A valid session is required for this request.",
          requestId: rid,
        });
      }

      const projIdParsed = ProjectIdSchema.safeParse(c.req.param("projectId"));
      const orgIdParsed = OrganizationIdSchema.safeParse(
        c.req.query("organizationId") ?? "00000000-0000-4000-8000-000000000002"
      );

      if (!(projIdParsed.success && orgIdParsed.success)) {
        return apiErrorResponse({
          code: "invalid_request",
          message:
            "projectId path parameter and organizationId query parameter are required.",
          requestId: rid,
        });
      }

      const scope = {
        organizationId: orgIdParsed.data,
        projectId: projIdParsed.data,
      };

      const decision = await authorizeProjectAction({
        action: "project:read",
        deps,
        organizationId: scope.organizationId,
        principal,
        projectId: scope.projectId,
      });

      if (!decision.allowed) {
        return apiErrorResponse({
          code: DENIAL_BY_REASON[decision.reason] ?? "forbidden",
          message:
            "You are not authorized to view deployments in this project.",
          requestId: rid,
        });
      }

      const deployments = await deps.store().listDeployments(scope);
      return c.json({ deployments }, 200);
    },

    rollback: async (c: HandlerContext): Promise<Response> => {
      const rid = c.req.header("x-request-id") ?? crypto.randomUUID();

      const principal = await deps.resolvePrincipal({
        cookieHeader: c.req.header("cookie"),
      });
      if (!principal) {
        return apiErrorResponse({
          code: "unauthenticated",
          message: "A valid session is required for this request.",
          requestId: rid,
        });
      }

      const deploymentIdParsed = DeploymentIdSchema.safeParse(
        c.req.param("deploymentId")
      );
      if (!deploymentIdParsed.success) {
        return apiErrorResponse({
          code: "invalid_request",
          message: "A valid deploymentId parameter is required.",
          requestId: rid,
        });
      }

      const bodyParse = RollbackDeploymentRequestSchema.safeParse(
        await c.req.json()
      );
      if (!bodyParse.success) {
        return apiErrorResponse({
          code: "invalid_request",
          message: "Invalid rollback request body.",
          requestId: rid,
        });
      }

      const scope = {
        organizationId: bodyParse.data.organizationId,
        projectId: bodyParse.data.projectId,
      };

      const decision = await authorizeProjectAction({
        action: "checkpoint:restore",
        deps,
        organizationId: scope.organizationId,
        principal,
        projectId: scope.projectId,
      });

      if (!decision.allowed) {
        return apiErrorResponse({
          code: DENIAL_BY_REASON[decision.reason] ?? "forbidden",
          message: "You are not authorized to execute deployment rollbacks.",
          requestId: rid,
        });
      }

      try {
        const result = await deps.store().rollbackDeployment({
          deploymentId: deploymentIdParsed.data,
          reason: bodyParse.data.reason,
          scope,
          targetDeploymentId: bodyParse.data.targetDeploymentId,
        });

        return c.json(result, 200);
      } catch (error) {
        return apiErrorResponse({
          code: "not_found",
          message:
            error instanceof Error
              ? error.message
              : "Deployment rollback operation failed.",
          requestId: rid,
        });
      }
    },
  };
}
