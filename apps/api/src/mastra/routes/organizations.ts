import {
  CreateOrganizationRequestSchema,
  CreateOrganizationResponseSchema,
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
 * Organization routes.
 *
 * This is the one tenancy mutation that needs no membership: a caller with a
 * verified session may create an organization they own, which is how a first
 * organization comes to exist. The transaction grants the owner membership, so
 * the caller is a member the moment the response is written; every later
 * organization mutation goes through centralized authorization like any other.
 */

export const ORGANIZATION_COLLECTION_PATH = "/v1/organizations";

export interface OrganizationRouteDeps {
  resolvePrincipal: (input: {
    cookieHeader: string | undefined;
  }) => Promise<UserPrincipal | undefined>;
  /**
   * Resolved per request so the store is created only when the authoritative
   * database is configured, and so tests can inject their own.
   */
  store: () => ProjectStateStore;
}

export function createOrganizationHandlers(deps: OrganizationRouteDeps) {
  return {
    /**
     * Creates an organization the caller owns, together with the owner
     * membership and the audit row, in one transaction.
     *
     * The organization identifier is generated inside that transaction, so the
     * audit event carries `null` and the store stamps the row with the
     * identifier it actually committed.
     */
    create: async (c: HandlerContext): Promise<Response> => {
      const rid = c.req.header("x-request-id") ?? crypto.randomUUID();

      const principal = await deps.resolvePrincipal({
        cookieHeader: c.req.header("cookie"),
      });
      if (!principal) {
        return unauthenticatedResponse(rid);
      }

      const body = CreateOrganizationRequestSchema.safeParse(
        await readJsonBody(c.req)
      );
      if (!body.success) {
        return apiErrorResponse({
          code: "invalid_request",
          message:
            "An organization name of at most 120 characters is required.",
          requestId: rid,
        });
      }

      const created = await deps.store().createOrganizationWithOwner({
        audit: auditEvent({
          action: "organization.created",
          actor: principal,
          metadata: { name: body.data.name },
          organizationId: null,
          projectId: null,
          requestId: rid,
        }),
        name: body.data.name,
        userId: principal.userId,
      });

      return c.json(CreateOrganizationResponseSchema.parse(created), 201);
    },
  };
}
