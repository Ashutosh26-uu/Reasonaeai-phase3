import { authorize } from "@reasonateai/auth/authorize";
import type { ApiErrorCode } from "@reasonateai/contracts/api-error";
import {
  BuildSessionIdSchema,
  FailureDetailsSchema,
  PreviewIdSchema,
  PreviewStatusSchema,
} from "@reasonateai/contracts/execution";
import {
  OrganizationIdSchema,
  type Permission,
  ProjectIdSchema,
  type UserPrincipal,
  type WorkloadPrincipal,
} from "@reasonateai/contracts/identity";
import { executePreviewSession } from "@reasonateai/cto-runtime/tools/preview";
import type { ProjectStateStore } from "@reasonateai/project-state/postgres";
import { ensureSandboxContainer } from "@reasonateai/sandbox/factory";
import { z } from "zod";
import { apiErrorResponse } from "../principal.js";

export const PREVIEWS_BUILD_SESSION_PATH =
  "/v1/build-sessions/:buildSessionId/previews";
export const PREVIEW_ITEM_PATH = "/v1/previews/:previewId";

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

const CreatePreviewBodySchema = z.strictObject({
  expiresAt: z.string().datetime().optional(),
  organizationId: z.string().uuid().optional(),
  port: z.number().int().min(1).max(65_535),
  projectId: z.string().uuid().optional(),
  sandboxEnvironmentId: z.string().uuid().optional(),
  sandboxId: z.string().min(1).max(128).optional(),
  ttlSeconds: z.number().int().positive().optional(),
});

const UpdatePreviewBodySchema = z.strictObject({
  errorDetails: FailureDetailsSchema.nullable().optional(),
  healthUrl: z.string().url().nullable().optional(),
  organizationId: z.string().uuid(),
  projectId: z.string().uuid(),
  proxyUrl: z.string().url().nullable().optional(),
  status: PreviewStatusSchema,
});

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

export interface PreviewRouteDeps {
  resolvePrincipal: (input: {
    cookieHeader: string | undefined;
  }) => Promise<UserPrincipal | WorkloadPrincipal | undefined>;
  store: () => ProjectStateStore;
}

async function authorizeProjectAction(input: {
  action: Permission;
  deps: PreviewRouteDeps;
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

export function createPreviewHandlers(deps: PreviewRouteDeps) {
  return {
    create: async (c: HandlerContext): Promise<Response> => {
      const rid = c.req.header("x-request-id") ?? crypto.randomUUID();

      try {
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

        const buildSessionIdParsed = BuildSessionIdSchema.safeParse(
          c.req.param("buildSessionId")
        );
        if (!buildSessionIdParsed.success) {
          return apiErrorResponse({
            code: "invalid_request",
            message: "A valid buildSessionId parameter is required.",
            requestId: rid,
          });
        }

        const bodyParse = CreatePreviewBodySchema.safeParse(await c.req.json());
        if (!bodyParse.success) {
          return apiErrorResponse({
            code: "invalid_request",
            message: "Invalid preview creation request body.",
            requestId: rid,
          });
        }

        const organizationId =
          bodyParse.data.organizationId ??
          c.req.query("organizationId") ??
          "00000000-0000-4000-8000-000000000002";
        const projectId =
          bodyParse.data.projectId ??
          c.req.query("projectId") ??
          "00000000-0000-4000-8000-000000000003";

        const scope = {
          organizationId: OrganizationIdSchema.parse(organizationId),
          projectId: ProjectIdSchema.parse(projectId),
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
            message: "You are not authorized to allocate preview sessions.",
            requestId: rid,
          });
        }

        const buildSession = await deps
          .store()
          .getBuildSession(scope, buildSessionIdParsed.data);
        if (!buildSession) {
          return apiErrorResponse({
            code: "not_found",
            message: "No such build session in tenant scope.",
            requestId: rid,
          });
        }

        const preview = await executePreviewSession(
          {
            expiresAt: bodyParse.data.expiresAt,
            port: bodyParse.data.port,
            sandboxEnvironmentId: bodyParse.data.sandboxEnvironmentId,
            sandboxId: bodyParse.data.sandboxId,
            scope: {
              buildSessionId: buildSession.buildSessionId,
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              runId: buildSession.runId,
            },
            ttlSeconds: bodyParse.data.ttlSeconds,
          },
          {
            resolveSandbox: () =>
              ensureSandboxContainer({
                buildSessionId: buildSession.buildSessionId,
                organizationId: scope.organizationId,
                projectId: scope.projectId,
                runId: buildSession.runId,
                sandboxEnvironmentId:
                  bodyParse.data.sandboxEnvironmentId ??
                  buildSession.sandboxEnvironmentId ??
                  "00000000-0000-4000-8000-000000000099",
                sandboxId:
                  bodyParse.data.sandboxId ??
                  `sb-${buildSession.buildSessionId.slice(0, 8)}`,
              }),
            store: deps.store(),
          }
        );

        return c.json({ preview }, 202);
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Internal server error";
        return apiErrorResponse({
          code: "internal",
          message,
          requestId: rid,
        });
      }
    },

    get: async (c: HandlerContext): Promise<Response> => {
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

      const previewIdParsed = PreviewIdSchema.safeParse(
        c.req.param("previewId")
      );
      const orgIdParsed = OrganizationIdSchema.safeParse(
        c.req.query("organizationId") ?? "00000000-0000-4000-8000-000000000002"
      );
      const projIdParsed = ProjectIdSchema.safeParse(
        c.req.query("projectId") ?? "00000000-0000-4000-8000-000000000003"
      );

      if (
        !(
          previewIdParsed.success &&
          orgIdParsed.success &&
          projIdParsed.success
        )
      ) {
        return apiErrorResponse({
          code: "invalid_request",
          message: "A valid previewId parameter is required.",
          requestId: rid,
        });
      }

      const scope = {
        organizationId: orgIdParsed.data,
        projectId: projIdParsed.data,
      };

      const decision = await authorizeProjectAction({
        action: "preview:open",
        deps,
        organizationId: scope.organizationId,
        principal,
        projectId: scope.projectId,
      });

      if (!decision.allowed) {
        return apiErrorResponse({
          code: DENIAL_BY_REASON[decision.reason] ?? "forbidden",
          message: "You are not authorized to view previews in this project.",
          requestId: rid,
        });
      }

      const preview = await deps
        .store()
        .getPreview(scope, previewIdParsed.data);
      if (!preview) {
        return apiErrorResponse({
          code: "not_found",
          message: "No such preview session in scope.",
          requestId: rid,
        });
      }

      return c.json({ preview }, 200);
    },

    listActive: async (c: HandlerContext): Promise<Response> => {
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

      const buildSessionIdParsed = BuildSessionIdSchema.safeParse(
        c.req.param("buildSessionId")
      );
      const orgIdParsed = OrganizationIdSchema.safeParse(
        c.req.query("organizationId") ?? "00000000-0000-4000-8000-000000000002"
      );
      const projIdParsed = ProjectIdSchema.safeParse(
        c.req.query("projectId") ?? "00000000-0000-4000-8000-000000000003"
      );

      if (
        !(
          buildSessionIdParsed.success &&
          orgIdParsed.success &&
          projIdParsed.success
        )
      ) {
        return apiErrorResponse({
          code: "invalid_request",
          message: "A valid buildSessionId parameter is required.",
          requestId: rid,
        });
      }

      const scope = {
        organizationId: orgIdParsed.data,
        projectId: projIdParsed.data,
      };

      const decision = await authorizeProjectAction({
        action: "preview:open",
        deps,
        organizationId: scope.organizationId,
        principal,
        projectId: scope.projectId,
      });

      if (!decision.allowed) {
        return apiErrorResponse({
          code: DENIAL_BY_REASON[decision.reason] ?? "forbidden",
          message: "You are not authorized to list previews in this project.",
          requestId: rid,
        });
      }

      const previews = await deps
        .store()
        .listActivePreviews(scope, buildSessionIdParsed.data);
      return c.json({ previews }, 200);
    },

    update: async (c: HandlerContext): Promise<Response> => {
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

      const previewIdParsed = PreviewIdSchema.safeParse(
        c.req.param("previewId")
      );
      if (!previewIdParsed.success) {
        return apiErrorResponse({
          code: "invalid_request",
          message: "A valid previewId parameter is required.",
          requestId: rid,
        });
      }

      const bodyParse = UpdatePreviewBodySchema.safeParse(await c.req.json());
      if (!bodyParse.success) {
        return apiErrorResponse({
          code: "invalid_request",
          message: "Invalid preview status update body.",
          requestId: rid,
        });
      }

      const scope = {
        organizationId: OrganizationIdSchema.parse(
          bodyParse.data.organizationId
        ),
        projectId: ProjectIdSchema.parse(bodyParse.data.projectId),
      };

      const decision = await authorizeProjectAction({
        action: "project:update",
        deps,
        organizationId: scope.organizationId,
        principal,
        projectId: scope.projectId,
      });

      if (!decision.allowed) {
        return apiErrorResponse({
          code: DENIAL_BY_REASON[decision.reason] ?? "forbidden",
          message: "You are not authorized to update preview status.",
          requestId: rid,
        });
      }

      try {
        const preview = await deps.store().updatePreviewStatus({
          errorDetails: bodyParse.data.errorDetails,
          healthUrl: bodyParse.data.healthUrl,
          previewId: previewIdParsed.data,
          proxyUrl: bodyParse.data.proxyUrl,
          scope,
          status: bodyParse.data.status,
        });

        return c.json({ preview }, 200);
      } catch (error) {
        return apiErrorResponse({
          code: "not_found",
          message:
            error instanceof Error
              ? error.message
              : "Preview session update failed.",
          requestId: rid,
        });
      }
    },
  };
}
