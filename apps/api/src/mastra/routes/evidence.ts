import { authorize } from "@reasonateai/auth/authorize";
import type { ApiErrorCode } from "@reasonateai/contracts/api-error";
import {
  BuildSessionIdSchema,
  EvidenceKindSchema,
} from "@reasonateai/contracts/execution";
import {
  OrganizationIdSchema,
  type Permission,
  ProjectIdSchema,
  RunIdSchema,
  type UserPrincipal,
  type WorkloadPrincipal,
} from "@reasonateai/contracts/identity";
import type { ProjectStateStore } from "@reasonateai/project-state/postgres";
import { z } from "zod";
import { apiErrorResponse } from "../principal.js";

export const PROJECT_EVIDENCE_PATH = "/v1/projects/:projectId/evidence";
export const ARTIFACT_ITEM_PATH = "/v1/artifacts/:artifactId";

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

export interface EvidenceRouteDeps {
  resolvePrincipal: (input: {
    cookieHeader: string | undefined;
  }) => Promise<UserPrincipal | WorkloadPrincipal | undefined>;
  store: () => ProjectStateStore;
}

async function authorizeProjectAction(input: {
  action: Permission;
  deps: EvidenceRouteDeps;
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

function parseEvidenceFilterQueries(c: HandlerContext) {
  const kindQuery = c.req.query("kind");
  const kindParsed = kindQuery ? EvidenceKindSchema.safeParse(kindQuery) : null;
  if (kindQuery && !kindParsed?.success) {
    return { error: true as const };
  }

  const runIdQuery = c.req.query("runId");
  const runIdParsed = runIdQuery ? RunIdSchema.safeParse(runIdQuery) : null;

  const bsIdQuery = c.req.query("buildSessionId");
  const bsIdParsed = bsIdQuery
    ? BuildSessionIdSchema.safeParse(bsIdQuery)
    : null;

  return {
    buildSessionId: bsIdParsed?.success ? bsIdParsed.data : undefined,
    error: false as const,
    kind: kindParsed?.success ? kindParsed.data : undefined,
    runId: runIdParsed?.success ? runIdParsed.data : undefined,
  };
}

export function createEvidenceHandlers(deps: EvidenceRouteDeps) {
  return {
    getArtifact: async (c: HandlerContext): Promise<Response> => {
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

      const artifactIdRaw = c.req.param("artifactId");
      const artifactIdParsed = z.string().uuid().safeParse(artifactIdRaw);
      const orgIdParsed = OrganizationIdSchema.safeParse(
        c.req.query("organizationId") ?? "00000000-0000-4000-8000-000000000002"
      );
      const projIdParsed = ProjectIdSchema.safeParse(
        c.req.query("projectId") ?? "00000000-0000-4000-8000-000000000003"
      );

      if (
        !(
          artifactIdParsed.success &&
          orgIdParsed.success &&
          projIdParsed.success
        )
      ) {
        return apiErrorResponse({
          code: "invalid_request",
          message:
            "artifactId param, organizationId query, and projectId query are required.",
          requestId: rid,
        });
      }

      const scope = {
        organizationId: orgIdParsed.data,
        projectId: projIdParsed.data,
      };

      const decision = await authorizeProjectAction({
        action: "artifact:read",
        deps,
        organizationId: scope.organizationId,
        principal,
        projectId: scope.projectId,
      });

      if (!decision.allowed) {
        return apiErrorResponse({
          code: DENIAL_BY_REASON[decision.reason] ?? "forbidden",
          message: "You are not authorized to read artifacts in this project.",
          requestId: rid,
        });
      }

      const artifacts = await deps.store().listArtifacts(scope);
      const artifact = artifacts.find(
        (a) => a.artifactId === artifactIdParsed.data
      );

      if (!artifact) {
        return apiErrorResponse({
          code: "not_found",
          message: "No such artifact in tenant scope.",
          requestId: rid,
        });
      }

      return c.json(
        {
          artifact,
          downloadUrl: null,
        },
        200
      );
    },

    listEvidence: async (c: HandlerContext): Promise<Response> => {
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
        action: "artifact:read",
        deps,
        organizationId: scope.organizationId,
        principal,
        projectId: scope.projectId,
      });

      if (!decision.allowed) {
        return apiErrorResponse({
          code: DENIAL_BY_REASON[decision.reason] ?? "forbidden",
          message: "You are not authorized to view evidence in this project.",
          requestId: rid,
        });
      }

      const filterResult = parseEvidenceFilterQueries(c);
      if (filterResult.error) {
        return apiErrorResponse({
          code: "invalid_request",
          message: "Invalid evidence kind parameter.",
          requestId: rid,
        });
      }

      const evidence = await deps.store().listEvidence(scope, {
        buildSessionId: filterResult.buildSessionId,
        kind: filterResult.kind,
        runId: filterResult.runId,
      });

      return c.json({ evidence }, 200);
    },
  };
}
