import { authorize } from "@reasonateai/auth/authorize";
import {
  decideEntitlement,
  decideRateLimit,
  defaultPlan,
} from "@reasonateai/auth/entitlements";
import type { ApiErrorCode } from "@reasonateai/contracts/api-error";
import {
  type EntitlementDecision,
  type Entitlements,
  PLAN_ENTITLEMENTS,
  type UsageMetric,
} from "@reasonateai/contracts/entitlements";
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
import type {
  BuildSessionAllocation,
  ProjectStateStore,
} from "@reasonateai/project-state/postgres";
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

/** The metric an allocation is metered against. */
const RUN_METRIC: UsageMetric = "runs";

/**
 * One allocation consumes one run slot. The run's sandbox minutes and tokens
 * are metered as the run reports them, not at admission.
 */
const RUN_SLOT = 1;

/**
 * A refused admission is typed like every other route error. The decision's
 * reason is written for the caller, and a retry hint becomes a `Retry-After`
 * header so a client can back off without parsing prose. A hint from the store
 * wins over the decision's, since only the store sees the live window.
 */
function entitlementRefusal(
  decision: EntitlementDecision,
  requestId: string,
  retryAfterSeconds: number | null
): Response {
  const response = apiErrorResponse({
    code: "rate_limited",
    message: decision.reason,
    requestId,
  });
  const retryAfter = retryAfterSeconds ?? decision.retryAfterSeconds;

  if (retryAfter !== undefined) {
    response.headers.set("Retry-After", String(retryAfter));
  }

  return response;
}

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

/**
 * The metering admission, in the order the route applies it: the limiter is the
 * only check that sees the request window as it is consumed, the snapshot is the
 * cheap run-quota refusal, and the reservation is the authoritative one. Returns
 * the typed refusal, or undefined once the slot is reserved.
 */
async function admitRun(input: {
  entitlements: Entitlements;
  organizationId: OrganizationId;
  requestId: string;
  store: ProjectStateStore;
}): Promise<Response | undefined> {
  // The limiter is the only admission check that sees the request window as
  // it is consumed, so it decides; the policy turns its observation into the
  // reason and the retry hint.
  const rate = await input.store.rateLimiter.consume({
    burstPerMinute: input.entitlements.rateLimit.burstPerMinute,
    organizationId: input.organizationId,
    requestsPerDay: input.entitlements.rateLimit.requestsPerDay,
  });
  if (!rate.allowed) {
    return entitlementRefusal(
      decideRateLimit(input.entitlements, rate.observed),
      input.requestId,
      rate.retryAfterSeconds ?? null
    );
  }

  const usage = await input.store.usage.snapshot(input.organizationId);
  // A run quota only refills when the billing period rolls over, so that
  // instant is the only honest retry hint for a refused run slot.
  const retryAtPeriodEnd = Math.max(
    1,
    Math.ceil((Date.parse(usage.periodEnd) - Date.now()) / 1000)
  );

  const admission = decideEntitlement({
    entitlements: input.entitlements,
    request: { amount: RUN_SLOT, metric: RUN_METRIC },
    usage,
  });
  if (!admission.allowed) {
    return entitlementRefusal(admission, input.requestId, retryAtPeriodEnd);
  }

  // The snapshot is the cheap refusal; the reservation is the authoritative
  // one, so two concurrent allocations cannot both take the last run slot.
  const reservation = await input.store.usage.reserve({
    amount: RUN_SLOT,
    limit: input.entitlements.runsPerPeriod,
    metric: RUN_METRIC,
    organizationId: input.organizationId,
    periodEnd: new Date(usage.periodEnd),
    periodStart: new Date(usage.periodStart),
    runId: null,
  });
  if (!reservation.allowed) {
    return entitlementRefusal(
      decideEntitlement({
        entitlements: input.entitlements,
        request: { amount: RUN_SLOT, metric: RUN_METRIC },
        usage: { ...usage, runs: reservation.observed },
      }),
      input.requestId,
      retryAtPeriodEnd
    );
  }

  return undefined;
}

/**
 * The reservation is the atomic metering write for the run slot, so the route
 * never records that unit on the way in. A negative write on the same metric is
 * the refund, and the snapshot sums it away in the period the reservation landed
 * in.
 */
async function allocateOrRefund(input: {
  idempotencyKey: string;
  organizationId: OrganizationId;
  principal: UserPrincipal;
  projectId: ProjectId;
  store: ProjectStateStore;
}): Promise<BuildSessionAllocation> {
  const refund = {
    amount: -RUN_SLOT,
    metric: RUN_METRIC,
    organizationId: input.organizationId,
    runId: null,
  };

  let allocation: BuildSessionAllocation;
  try {
    allocation = await input.store.allocateBuildSession({
      idempotencyKey: input.idempotencyKey,
      scope: {
        organizationId: input.organizationId,
        projectId: input.projectId,
      },
      userSessionId: input.principal.sessionId,
    });
  } catch (error) {
    // The slot was taken but there is no run to spend it on.
    await input.store.usage.record(refund);
    throw error;
  }

  if (!allocation.created) {
    // A replay adopts the session whose run the first request already metered,
    // so this request's reservation goes back to the plan. The refund is not
    // retroactive: until it lands, a concurrent run in an organization at its
    // plan limit can see a spurious refusal for the width of that window. A
    // session lookup by idempotency key in the store is the follow-up that
    // removes the window.
    await input.store.usage.record(refund);
  }

  return allocation;
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

      const idempotencyKey = c.req.header("idempotency-key");
      if (!idempotencyKey) {
        return apiErrorResponse({
          code: "invalid_request",
          message: "An Idempotency-Key header is required.",
          requestId: rid,
        });
      }

      const body = AllocationBodySchema.safeParse(await c.req.json());
      if (!body.success) {
        return apiErrorResponse({
          code: "invalid_request",
          message:
            "The request body must contain only organizationId and projectId.",
          requestId: rid,
        });
      }

      const organizationId = OrganizationIdSchema.safeParse(
        body.data.organizationId
      );
      const projectId = ProjectIdSchema.safeParse(body.data.projectId);
      if (!(organizationId.success && projectId.success)) {
        return apiErrorResponse({
          code: "invalid_request",
          message: "Malformed scope identifiers.",
          requestId: rid,
        });
      }

      const decision = await authorizeProjectAction({
        action: "agent:run",
        deps,
        organizationId: organizationId.data,
        principal,
        projectId: projectId.data,
      });

      if (!decision.allowed) {
        return apiErrorResponse({
          code: DENIAL_BY_REASON[decision.reason] ?? "forbidden",
          message: "You are not authorized to start work on this project.",
          requestId: rid,
        });
      }

      const store = deps.store();
      // Billing owns the plan column this will read once it ships; until then
      // the default plan is the only truthful answer for an organization.
      const entitlements = PLAN_ENTITLEMENTS[defaultPlan];

      const refusal = await admitRun({
        entitlements,
        organizationId: organizationId.data,
        requestId: rid,
        store,
      });
      if (refusal !== undefined) {
        return refusal;
      }

      const allocation = await allocateOrRefund({
        idempotencyKey,
        organizationId: organizationId.data,
        principal,
        projectId: projectId.data,
        store,
      });

      return c.json(
        {
          buildSession: allocation.buildSession,
          created: allocation.created,
          sandbox: allocation.sandbox,
        },
        202
      );
    },

    /** Scoped read. Another tenant's session is indistinguishable from absent. */
    read: async (c: HandlerContext): Promise<Response> => {
      const rid = c.req.header("x-request-id") ?? crypto.randomUUID();

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
        c.req.query("organizationId")
      );
      const projectId = ProjectIdSchema.safeParse(c.req.query("projectId"));
      if (!(params.success && organizationId.success && projectId.success)) {
        return apiErrorResponse({
          code: "invalid_request",
          message:
            "A build session id and both scope identifiers are required.",
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
    },
  };
}
