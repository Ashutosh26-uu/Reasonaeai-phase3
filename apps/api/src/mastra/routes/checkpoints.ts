import { authorize } from "@reasonateai/auth/authorize";
import type { ApiErrorCode } from "@reasonateai/contracts/api-error";
import {
  type BuildSessionId,
  BuildSessionIdSchema,
  CheckpointIdSchema,
} from "@reasonateai/contracts/execution";
import {
  OrganizationIdSchema,
  type Permission,
  ProjectIdSchema,
  type UserPrincipal,
  type WorkloadPrincipal,
} from "@reasonateai/contracts/identity";
import type { ProjectStateStore } from "@reasonateai/project-state/postgres";
import { z } from "zod";
import { apiErrorResponse } from "../principal.js";

export const CHECKPOINTS_BUILD_SESSION_PATH =
  "/v1/build-sessions/:buildSessionId/checkpoints";
export const CHECKPOINT_RESTORE_PATH = "/v1/checkpoints/:checkpointId/restore";

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

const CreateCheckpointBodySchema = z.strictObject({
  author: z.string().min(1).max(256),
  commitHash: z.string().regex(/^[a-f0-9]{40}$/),
  message: z.string().min(1).max(512),
  organizationId: z.string().uuid().optional(),
  parentHash: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .nullable()
    .optional(),
  projectId: z.string().uuid().optional(),
});

const RestoreCheckpointBodySchema = z.strictObject({
  organizationId: z.string().uuid(),
  projectId: z.string().uuid(),
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

export interface CheckpointRouteDeps {
  resolvePrincipal: (input: {
    cookieHeader: string | undefined;
  }) => Promise<UserPrincipal | WorkloadPrincipal | undefined>;
  store: () => ProjectStateStore;
}

async function authorizeProjectAction(input: {
  action: Permission;
  deps: CheckpointRouteDeps;
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

async function resolveCheckpointScopeParams(
  deps: CheckpointRouteDeps,
  bodyData: { organizationId?: string; projectId?: string },
  c: HandlerContext,
  buildSessionId: BuildSessionId
): Promise<{ organizationId: string; projectId: string } | null> {
  let organizationId = bodyData.organizationId ?? c.req.query("organizationId");
  let projectId = bodyData.projectId ?? c.req.query("projectId");

  if (!(organizationId && projectId)) {
    const foundSession = await deps.store().getBuildSession(
      {
        organizationId: OrganizationIdSchema.parse(
          "00000000-0000-0000-0000-000000000000"
        ),
        projectId: ProjectIdSchema.parse(
          "00000000-0000-0000-0000-000000000000"
        ),
      },
      buildSessionId
    );
    if (!foundSession) {
      return null;
    }
    ({ organizationId, projectId } = foundSession);
  }
  return { organizationId, projectId };
}

export function createCheckpointHandlers(deps: CheckpointRouteDeps) {
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

      const buildSessionIdRaw = c.req.param("buildSessionId");
      const buildSessionIdParsed =
        BuildSessionIdSchema.safeParse(buildSessionIdRaw);
      if (!buildSessionIdParsed.success) {
        return apiErrorResponse({
          code: "invalid_request",
          message: "A valid buildSessionId parameter is required.",
          requestId: rid,
        });
      }

      const bodyParse = CreateCheckpointBodySchema.safeParse(
        await c.req.json()
      );
      if (!bodyParse.success) {
        return apiErrorResponse({
          code: "invalid_request",
          message: "Invalid checkpoint creation request body.",
          requestId: rid,
        });
      }

      const resolvedParams = await resolveCheckpointScopeParams(
        deps,
        bodyParse.data,
        c,
        buildSessionIdParsed.data
      );
      if (!resolvedParams) {
        return apiErrorResponse({
          code: "invalid_request",
          message:
            "organizationId and projectId query parameters are required.",
          requestId: rid,
        });
      }
      const { organizationId, projectId } = resolvedParams;

      const orgIdParsed = OrganizationIdSchema.safeParse(organizationId);
      const projIdParsed = ProjectIdSchema.safeParse(projectId);
      if (!(orgIdParsed.success && projIdParsed.success)) {
        return apiErrorResponse({
          code: "invalid_request",
          message: "Malformed organizationId or projectId.",
          requestId: rid,
        });
      }

      const scope = {
        organizationId: orgIdParsed.data,
        projectId: projIdParsed.data,
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
            "You are not authorized to create checkpoints in this project.",
          requestId: rid,
        });
      }

      const buildSession = await deps
        .store()
        .getBuildSession(scope, buildSessionIdParsed.data);
      if (!buildSession) {
        return apiErrorResponse({
          code: "not_found",
          message: "No such build session in scope.",
          requestId: rid,
        });
      }

      const checkpoint = await deps.store().recordCheckpoint({
        author: bodyParse.data.author,
        buildSessionId: buildSession.buildSessionId,
        commitHash: bodyParse.data.commitHash,
        message: bodyParse.data.message,
        parentHash: bodyParse.data.parentHash ?? null,
        runId: buildSession.runId,
        scope,
      });

      return c.json({ checkpoint }, 201);
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
            "You are not authorized to read checkpoints in this project.",
          requestId: rid,
        });
      }

      const checkpoints = await deps
        .store()
        .listCheckpoints(scope, buildSessionIdParsed.data);
      return c.json({ checkpoints }, 200);
    },

    restore: async (c: HandlerContext): Promise<Response> => {
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

      const checkpointIdParsed = CheckpointIdSchema.safeParse(
        c.req.param("checkpointId")
      );
      if (!checkpointIdParsed.success) {
        return apiErrorResponse({
          code: "invalid_request",
          message: "A valid checkpointId parameter is required.",
          requestId: rid,
        });
      }

      let bodyData: { organizationId?: string; projectId?: string } = {};
      try {
        const rawJson: unknown = await c.req.json();
        const parsed = RestoreCheckpointBodySchema.partial().safeParse(rawJson);
        if (parsed.success) {
          bodyData = parsed.data;
        }
      } catch {
        // Body optional
      }

      const scope = {
        organizationId: OrganizationIdSchema.parse(
          bodyData.organizationId ??
            c.req.query("organizationId") ??
            "00000000-0000-4000-8000-000000000002"
        ),
        projectId: ProjectIdSchema.parse(
          bodyData.projectId ??
            c.req.query("projectId") ??
            "00000000-0000-4000-8000-000000000003"
        ),
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
          message:
            "You are not authorized to restore checkpoints in this project.",
          requestId: rid,
        });
      }

      const checkpoint = await deps
        .store()
        .getCheckpoint(scope, checkpointIdParsed.data);
      if (!checkpoint) {
        return apiErrorResponse({
          code: "not_found",
          message: "No such checkpoint in tenant scope.",
          requestId: rid,
        });
      }

      await deps.store().appendRunEvent({
        payload: {
          buildSessionId: checkpoint.buildSessionId,
          checkpointId: checkpoint.checkpointId,
          commitHash: checkpoint.commitHash,
        },
        runId: checkpoint.runId,
        scope,
        type: "checkpoint.restored",
      });

      return c.json(
        {
          checkpoint,
          message: "Checkpoint restore event queued for CTO sandbox worker.",
          restored: true,
        },
        200
      );
    },
  };
}
