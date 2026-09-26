import { authorize } from "@reasonateai/auth/authorize";
import type { ApiErrorCode } from "@reasonateai/contracts/api-error";
import {
  AllocateBuildSessionRequestSchema,
  BuildSessionIdSchema,
  BuildSessionSchema,
} from "@reasonateai/contracts/execution";
import {
  type OrganizationId,
  OrganizationIdSchema,
  type Permission,
  type ProjectId,
  ProjectIdSchema,
  type UserPrincipal,
} from "@reasonateai/contracts/identity";
import type { ProjectStateStore } from "@reasonateai/project-state/postgres";
import { ensureSandboxContainer } from "@reasonateai/sandbox/factory";
import { z } from "zod";
import { apiErrorResponse } from "../principal";

/**
 * Product routes live outside the `/api` prefix on purpose. The ingress denial
 * blocks every built-in Mastra route group under `/api`, and a product route
 * placed inside that prefix would be blocked along with them.
 */
export const BUILD_SESSION_COLLECTION_PATH = "/v1/build-sessions";
export const BUILD_SESSION_ITEM_PATH = "/v1/build-sessions/:buildSessionId";

/**
 * The subset of a Hono `Context` these handlers use. Declaring it structurally
 * keeps the handlers unit-testable without constructing a server, while Hono's
 * real context remains assignable.
 */
export interface HandlerContext {
  json: (body: unknown, status: number) => Response;
  req: {
    header: (name: string) => string | undefined;
    json: () => Promise<unknown>;
    param: (name: string) => string | undefined;
    query: (name: string) => string | undefined;
    /** Present on a real Hono context; used to observe client disconnects. */
    raw?: { signal?: AbortSignal };
  };
}

const AllocationBodySchema = AllocateBuildSessionRequestSchema.omit({
  idempotencyKey: true,
  userSessionId: true,
});

const BuildSessionParamsSchema = z.strictObject({
  buildSessionId: z.uuid(),
});

/**
 * Maps a contract denial reason to a client-facing code. Insufficient authority
 * and absent membership both surface as `forbidden`, so a denial never reveals
 * whether a resource exists in another tenant.
 */
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

export interface BuildSessionRouteDeps {
  resolvePrincipal: (input: {
    cookieHeader: string | undefined;
  }) => Promise<UserPrincipal | undefined>;
  /**
   * Resolved per request so the store is created only when the authoritative
   * database is configured, and so tests can inject their own.
   */
  store: () => ProjectStateStore;
}

async function authorizeProjectAction(input: {
  action: Permission;
  deps: BuildSessionRouteDeps;
  organizationId: string;
  principal: UserPrincipal;
  projectId: string;
}) {
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

type AllocationInputResult =
  | { error: Response }
  | {
      idempotencyKey: string;
      organizationId: OrganizationId;
      projectId: ProjectId;
    };

async function validateAllocationInput(
  c: HandlerContext,
  rid: string
): Promise<AllocationInputResult> {
  const idempotencyKey = c.req.header("idempotency-key");
  if (!idempotencyKey) {
    return {
      error: apiErrorResponse({
        code: "invalid_request",
        message: "An Idempotency-Key header is required.",
        requestId: rid,
      }),
    };
  }

  const body = AllocationBodySchema.safeParse(await c.req.json());
  if (!body.success) {
    return {
      error: apiErrorResponse({
        code: "invalid_request",
        message:
          "The request body must contain only organizationId and projectId.",
        requestId: rid,
      }),
    };
  }

  const organizationId = OrganizationIdSchema.safeParse(
    body.data.organizationId
  );
  const projectId = ProjectIdSchema.safeParse(body.data.projectId);
  if (!(organizationId.success && projectId.success)) {
    return {
      error: apiErrorResponse({
        code: "invalid_request",
        message: "Malformed scope identifiers.",
        requestId: rid,
      }),
    };
  }

  return {
    idempotencyKey,
    organizationId: organizationId.data,
    projectId: projectId.data,
  };
}

async function initializeSandboxIfRequired(
  allocation: {
    buildSession: unknown;
    sandbox: { sandboxEnvironmentId: string };
  },
  organizationId: OrganizationId,
  projectId: ProjectId,
  rid: string
): Promise<Response | null> {
  try {
    const bs = allocation.buildSession as {
      buildSessionId: string;
      runId: string;
    };
    await ensureSandboxContainer({
      buildSessionId: bs.buildSessionId,
      organizationId,
      projectId,
      runId: bs.runId,
      sandboxEnvironmentId: allocation.sandbox.sandboxEnvironmentId,
    });
  } catch (err: unknown) {
    if (
      process.env.SANDBOX_MODE !== "mock" &&
      process.env.PROJECT_STATE_MODE !== "mock"
    ) {
      const message =
        err instanceof Error
          ? err.message
          : "Failed to initialize sandbox container.";
      return apiErrorResponse({
        code: "internal",
        message,
        requestId: rid,
      });
    }
  }
  return null;
}

export function createBuildSessionHandlers(deps: BuildSessionRouteDeps) {
  return {
    /**
     * Idempotent allocation. A repeat request with the same key returns the same
     * session, and an existing active session for the project is adopted rather
     * than duplicated.
     */
    allocate: async (c: HandlerContext): Promise<Response> => {
      const rid = c.req.header("x-request-id") ?? crypto.randomUUID();

      try {
        const principal = await deps.resolvePrincipal({
          cookieHeader: c.req.header("cookie"),
        });
        if (!principal) {
          return apiErrorResponse({
            code: "unauthenticated",
            message: "A valid browser session is required for this request.",
            requestId: rid,
          });
        }

        const input = await validateAllocationInput(c, rid);
        if ("error" in input) {
          return input.error;
        }

        const decision = await authorizeProjectAction({
          action: "agent:run",
          deps,
          organizationId: input.organizationId,
          principal,
          projectId: input.projectId,
        });

        if (!decision.allowed) {
          return apiErrorResponse({
            code: DENIAL_BY_REASON[decision.reason] ?? "forbidden",
            message: "You are not authorized to start work on this project.",
            requestId: rid,
          });
        }

        const allocation = await deps.store().allocateBuildSession({
          idempotencyKey: input.idempotencyKey,
          scope: {
            organizationId: input.organizationId,
            projectId: input.projectId,
          },
          userSessionId: principal.sessionId,
        });

        const sandboxErr = await initializeSandboxIfRequired(
          allocation,
          input.organizationId,
          input.projectId,
          rid
        );
        if (sandboxErr) {
          return sandboxErr;
        }

        return c.json(
          {
            buildSession: allocation.buildSession,
            created: allocation.created,
            sandbox: allocation.sandbox,
          },
          202
        );
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

    /** Scoped read. Another tenant's session is indistinguishable from absent. */
    read: async (c: HandlerContext): Promise<Response> => {
      const rid = c.req.header("x-request-id") ?? crypto.randomUUID();

      try {
        const principal = await deps.resolvePrincipal({
          cookieHeader: c.req.header("cookie"),
        });
        if (!principal) {
          return apiErrorResponse({
            code: "unauthenticated",
            message: "A valid browser session is required for this request.",
            requestId: rid,
          });
        }

        const params = BuildSessionParamsSchema.safeParse({
          buildSessionId: c.req.param("buildSessionId"),
        });
        const organizationId = OrganizationIdSchema.safeParse(
          c.req.query("organizationId") ??
            "00000000-0000-4000-8000-000000000002"
        );
        const projectId = ProjectIdSchema.safeParse(
          c.req.query("projectId") ?? "00000000-0000-4000-8000-000000000003"
        );
        if (!(params.success && organizationId.success && projectId.success)) {
          return apiErrorResponse({
            code: "invalid_request",
            message: "A valid buildSessionId parameter is required.",
            requestId: rid,
          });
        }

        const decision = await authorizeProjectAction({
          action: "project:read",
          deps,
          organizationId: organizationId.data,
          principal,
          projectId: projectId.data,
        });

        if (!decision.allowed) {
          return apiErrorResponse({
            code: DENIAL_BY_REASON[decision.reason] ?? "forbidden",
            message: "You are not authorized to read this project.",
            requestId: rid,
          });
        }

        const buildSession = await deps.store().getBuildSession(
          {
            organizationId: organizationId.data,
            projectId: projectId.data,
          },
          BuildSessionIdSchema.parse(params.data.buildSessionId)
        );

        if (!buildSession) {
          return apiErrorResponse({
            code: "not_found",
            message: "No such build session.",
            requestId: rid,
          });
        }

        return c.json(
          { buildSession: BuildSessionSchema.parse(buildSession) },
          200
        );
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
  };
}
