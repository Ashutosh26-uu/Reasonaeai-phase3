import { authorize } from "@reasonateai/auth/authorize";
import {
  CreateProjectRequestSchema,
  ProjectViewSchema,
} from "@reasonateai/contracts/auth";
import type { UserPrincipal } from "@reasonateai/contracts/identity";
import type { ProjectStateStore } from "@reasonateai/project-state/postgres";
import {
  apiErrorResponse,
  readJsonBody,
  unauthenticatedResponse,
} from "../principal";
import { auditEvent } from "./auth";
import type { HandlerContext } from "./build-sessions";

/**
 * Project routes.
 *
 * Project creation is a tenant mutation like any other, so it goes through the
 * same centralized policy as every other project action: a caller with no
 * membership in the organization is refused by default, and a member whose
 * role does not carry `project:create` is refused with the same answer. The
 * organization identifier in the body is a scope to be authorized, never proof
 * of access.
 */

export const PROJECT_COLLECTION_PATH = "/v1/projects";

export interface ProjectRouteDeps {
  resolvePrincipal: (input: {
    cookieHeader: string | undefined;
  }) => Promise<UserPrincipal | undefined>;
  /**
   * Resolved per request so the store is created only when the authoritative
   * database is configured, and so tests can inject their own.
   */
  store: () => ProjectStateStore;
}

export function createProjectHandlers(deps: ProjectRouteDeps) {
  return {
    /**
     * Creates a project the caller may add to the organization, with the
     * caller's own project membership and the audit row in one transaction.
     */
    create: async (c: HandlerContext): Promise<Response> => {
      const rid = c.req.header("x-request-id") ?? crypto.randomUUID();

      const principal = await deps.resolvePrincipal({
        cookieHeader: c.req.header("cookie"),
      });
      if (!principal) {
        return unauthenticatedResponse(rid);
      }

      const body = CreateProjectRequestSchema.safeParse(
        await readJsonBody(c.req)
      );
      if (!body.success) {
        return apiErrorResponse({
          code: "invalid_request",
          message:
            "A project name of at most 120 characters and an organization identifier are required.",
          requestId: rid,
        });
      }

      const store = deps.store();
      const { name, organizationId } = body.data;

      // The project does not exist yet, so the decision is the organization
      // role's: the policy resolves a null project scope against the
      // organization membership alone.
      const organizationMembership =
        await store.memberships.getOrganizationMembership({
          organizationId,
          userId: principal.userId,
        });

      const decision = authorize({
        action: "project:create",
        now: new Date().toISOString(),
        organizationMembership: organizationMembership ?? null,
        principal,
        projectMembership: null,
        resource: {
          kind: "project",
          organizationId,
          projectId: null,
          resourceId: null,
        },
      });

      if (!decision.allowed) {
        // Every reason reachable here is a tenancy refusal — missing
        // membership, mismatched scope, or a role without the capability — and
        // all of them are the same answer to the caller, so a denial never
        // reports whether the organization exists. The reason stays in the
        // audit trail, where an operator needs it.
        await store.audit.record(
          auditEvent({
            action: "authorization.denied",
            actor: principal,
            metadata: { action: "project:create", reason: decision.reason },
            organizationId,
            projectId: null,
            requestId: rid,
          })
        );
        return apiErrorResponse({
          code: "forbidden",
          message:
            "You are not authorized to create projects in this organization.",
          requestId: rid,
        });
      }

      const created = await store.createProject({
        audit: auditEvent({
          action: "project.created",
          actor: principal,
          metadata: { name },
          organizationId,
          // Generated inside the transaction; the store stamps the audit row
          // with the project it actually committed.
          projectId: null,
          requestId: rid,
        }),
        name,
        organizationId,
        // The creator gets implementation authority on the project they just
        // created. A role that could not work on its own project would make the
        // creation pointless, and this is the only membership granted here.
        role: "builder",
        userId: principal.userId,
      });

      return c.json(ProjectViewSchema.parse(created), 201);
    },
  };
}
