import { authorize } from "@reasonateai/auth/authorize";
import { defaultPlan } from "@reasonateai/auth/entitlements";
import {
  CreateOrganizationRequestSchema,
  CreateOrganizationResponseSchema,
  OrganizationPlanUsageSchema,
  RenameOrganizationRequestSchema,
} from "@reasonateai/contracts/auth";
import { PLAN_ENTITLEMENTS } from "@reasonateai/contracts/entitlements";
import {
  OrganizationIdSchema,
  type UserPrincipal,
} from "@reasonateai/contracts/identity";
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
export const ORGANIZATION_ITEM_PATH = "/v1/organizations/:organizationId";
export const ORGANIZATION_USAGE_PATH = `${ORGANIZATION_ITEM_PATH}/usage`;

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
    rename: async (c: HandlerContext): Promise<Response> => {
      const rid = c.req.header("x-request-id") ?? crypto.randomUUID();
      const principal = await deps.resolvePrincipal({
        cookieHeader: c.req.header("cookie"),
      });
      if (!principal) {
        return unauthenticatedResponse(rid);
      }
      const organizationId = OrganizationIdSchema.safeParse(
        c.req.param("organizationId")
      );
      const body = RenameOrganizationRequestSchema.safeParse(
        await readJsonBody(c.req)
      );
      if (!(organizationId.success && body.success)) {
        return apiErrorResponse({
          code: "invalid_request",
          message: "A valid organization identifier and name are required.",
          requestId: rid,
        });
      }
      const store = deps.store();
      const membership = await store.memberships.getOrganizationMembership({
        organizationId: organizationId.data,
        userId: principal.userId,
      });
      const decision = authorize({
        action: "organization:update",
        now: new Date().toISOString(),
        organizationMembership: membership ?? null,
        principal,
        projectMembership: null,
        resource: {
          kind: "organization",
          organizationId: organizationId.data,
          projectId: null,
          resourceId: null,
        },
      });
      if (!decision.allowed) {
        await store.audit.record(
          auditEvent({
            action: "authorization.denied",
            actor: principal,
            metadata: {
              action: "organization:update",
              reason: decision.reason,
            },
            organizationId: organizationId.data,
            projectId: null,
            requestId: rid,
          })
        );
        return apiErrorResponse({
          code: "forbidden",
          message: "You are not authorized to update this workspace.",
          requestId: rid,
        });
      }
      const renamed = await store.renameOrganization({
        audit: auditEvent({
          action: "organization.updated",
          actor: principal,
          metadata: { name: body.data.name },
          organizationId: organizationId.data,
          projectId: null,
          requestId: rid,
        }),
        name: body.data.name,
        organizationId: organizationId.data,
      });
      if (!renamed) {
        return apiErrorResponse({
          code: "not_found",
          message: "The workspace could not be found.",
          requestId: rid,
        });
      }
      return c.json({ name: body.data.name }, 200);
    },
    usage: async (c: HandlerContext): Promise<Response> => {
      const rid = c.req.header("x-request-id") ?? crypto.randomUUID();
      const principal = await deps.resolvePrincipal({
        cookieHeader: c.req.header("cookie"),
      });
      if (!principal) {
        return unauthenticatedResponse(rid);
      }
      const organizationId = OrganizationIdSchema.safeParse(
        c.req.param("organizationId")
      );
      if (!organizationId.success) {
        return apiErrorResponse({
          code: "invalid_request",
          message: "A valid organization identifier is required.",
          requestId: rid,
        });
      }
      const store = deps.store();
      const membership = await store.memberships.getOrganizationMembership({
        organizationId: organizationId.data,
        userId: principal.userId,
      });
      const decision = authorize({
        action: "organization:read",
        now: new Date().toISOString(),
        organizationMembership: membership ?? null,
        principal,
        projectMembership: null,
        resource: {
          kind: "organization",
          organizationId: organizationId.data,
          projectId: null,
          resourceId: null,
        },
      });
      if (!decision.allowed) {
        await store.audit.record(
          auditEvent({
            action: "authorization.denied",
            actor: principal,
            metadata: {
              action: "organization:read",
              reason: decision.reason,
            },
            organizationId: organizationId.data,
            projectId: null,
            requestId: rid,
          })
        );
        return apiErrorResponse({
          code: "forbidden",
          message: "You are not authorized to view this workspace's plan.",
          requestId: rid,
        });
      }
      const response = c.json(
        OrganizationPlanUsageSchema.parse({
          billingMode: "default",
          entitlements: PLAN_ENTITLEMENTS[defaultPlan],
          plan: defaultPlan,
          usage: await store.usage.snapshot(organizationId.data),
        }),
        200
      );
      response.headers.set("Cache-Control", "no-store");
      return response;
    },
  };
}
