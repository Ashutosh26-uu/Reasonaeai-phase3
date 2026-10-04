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
  AppendConversationTurnRequestSchema,
  type BuildSessionId,
  BuildSessionIdSchema,
  BuildSessionSchema,
  ConversationListSchema,
  ConversationTurnAcceptedSchema,
  type PromptAttachment,
} from "@reasonateai/contracts/execution";
import {
  ConversationTranscriptSchema,
  RunAnswerAcceptedSchema,
  RunAnswerRequestSchema,
} from "@reasonateai/contracts/execution-protocol";
import {
  type OrganizationId,
  OrganizationIdSchema,
  type Permission,
  type ProjectId,
  ProjectIdSchema,
  type RunId,
  RunIdSchema,
  type UserPrincipal,
} from "@reasonateai/contracts/identity";
import {
  type BuildSessionAllocation,
  ConversationBusyError,
  ConversationRetryUnavailableError,
  type ProjectStateStore,
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
export const PROJECT_CONVERSATIONS_PATH =
  "/v1/projects/:projectId/conversations";
export const CONVERSATION_MESSAGES_PATH =
  "/v1/build-sessions/:buildSessionId/messages";
export const CONVERSATION_TURNS_PATH =
  "/v1/build-sessions/:buildSessionId/turns";
export const RUN_CANCELLATION_PATH =
  "/v1/build-sessions/:buildSessionId/runs/:runId/cancel";
export const RUN_ANSWER_PATH =
  "/v1/build-sessions/:buildSessionId/runs/:runId/answers";
export const RUN_RETRY_PATH =
  "/v1/build-sessions/:buildSessionId/runs/:runId/retry";

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

const AllocationBodySchema = z.strictObject({
  attachments: AllocateBuildSessionRequestSchema.shape.attachments,
  message: AllocateBuildSessionRequestSchema.shape.message,
  organizationId: AllocateBuildSessionRequestSchema.shape.organizationId,
  projectId: AllocateBuildSessionRequestSchema.shape.projectId,
});

const MAX_PROMPT_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const ATTACHMENT_ONLY_MESSAGE = "Please review the attached files.";

function promptMessage(message: string | undefined): string {
  return message?.trim() || ATTACHMENT_ONLY_MESSAGE;
}

function attachmentsWithinLimit(attachments: PromptAttachment[] | undefined) {
  return (
    (attachments ?? []).reduce((total, attachment) => {
      const encoded = attachment.data.slice(attachment.data.indexOf(",") + 1);
      let padding = 0;
      if (encoded.endsWith("==")) {
        padding = 2;
      } else if (encoded.endsWith("=")) {
        padding = 1;
      }
      return total + Math.floor((encoded.length * 3) / 4) - padding;
    }, 0) <= MAX_PROMPT_ATTACHMENT_BYTES
  );
}

async function parseConversationTurn(
  context: HandlerContext,
  requestId: string
) {
  const parsed = AppendConversationTurnRequestSchema.safeParse(
    await context.req.json()
  );
  if (!parsed.success) {
    return apiErrorResponse({
      code: "invalid_request",
      message:
        "A message, idempotency key, conversation, and project scope are required.",
      requestId,
    });
  }
  if (!attachmentsWithinLimit(parsed.data.attachments)) {
    return apiErrorResponse({
      code: "invalid_request",
      message: "Attachments must total 12 MB or less.",
      requestId,
    });
  }
  return parsed.data;
}

async function appendAcceptedConversationTurn(
  input: {
    buildSessionId: BuildSessionId;
    idempotencyKey: string;
    requestId: string;
    scope: { organizationId: OrganizationId; projectId: ProjectId };
    store: ProjectStateStore;
  } & (
    | { attachments: PromptAttachment[]; message: string; retryRunId?: never }
    | { attachments?: never; message?: never; retryRunId: RunId }
  )
) {
  let accepted: Awaited<
    ReturnType<ProjectStateStore["appendConversationTurn"]>
  >;
  try {
    accepted = input.retryRunId
      ? await input.store.retryConversationRun({
          buildSessionId: input.buildSessionId,
          idempotencyKey: input.idempotencyKey,
          runId: input.retryRunId,
          scope: input.scope,
        })
      : await input.store.appendConversationTurn({
          attachments: input.attachments,
          buildSessionId: input.buildSessionId,
          idempotencyKey: input.idempotencyKey,
          message: promptMessage(input.message),
          scope: input.scope,
        });
  } catch (error) {
    await input.store.usage.record({
      amount: -RUN_SLOT,
      metric: RUN_METRIC,
      organizationId: input.scope.organizationId,
      runId: null,
    });
    if (
      error instanceof ConversationBusyError ||
      error instanceof ConversationRetryUnavailableError
    ) {
      return apiErrorResponse({
        code: "conflict",
        message: error.message,
        requestId: input.requestId,
      });
    }
    throw error;
  }
  if (!accepted.created) {
    await input.store.usage.record({
      amount: -RUN_SLOT,
      metric: RUN_METRIC,
      organizationId: input.scope.organizationId,
      runId: null,
    });
  }
  return accepted;
}

function parseConversationTurnScope(context: HandlerContext) {
  const idempotencyKey = context.req.header("idempotency-key");
  const organizationId = OrganizationIdSchema.safeParse(
    context.req.query("organizationId")
  );
  const projectId = ProjectIdSchema.safeParse(context.req.query("projectId"));
  const buildSessionId = BuildSessionIdSchema.safeParse(
    context.req.param("buildSessionId")
  );
  if (
    !(
      idempotencyKey &&
      idempotencyKey.length <= 128 &&
      organizationId.success &&
      projectId.success &&
      buildSessionId.success
    )
  ) {
    return null;
  }
  return {
    buildSessionId: buildSessionId.data,
    idempotencyKey,
    scope: {
      organizationId: organizationId.data,
      projectId: projectId.data,
    },
  };
}

async function retryAcceptedConversationTurn(input: {
  buildSessionId: BuildSessionId;
  idempotencyKey: string;
  requestId: string;
  retryRunId: RunId;
  scope: { organizationId: OrganizationId; projectId: ProjectId };
  store: ProjectStateStore;
}) {
  const replayRunId = await input.store.getConversationRetry({
    buildSessionId: input.buildSessionId,
    idempotencyKey: input.idempotencyKey,
    runId: input.retryRunId,
    scope: input.scope,
  });
  if (replayRunId) {
    return { created: false, runId: replayRunId };
  }
  const refusal = await admitRun({
    entitlements: PLAN_ENTITLEMENTS[defaultPlan],
    organizationId: input.scope.organizationId,
    requestId: input.requestId,
    store: input.store,
  });
  return refusal ?? (await appendAcceptedConversationTurn(input));
}

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
  attachments?: PromptAttachment[];
  idempotencyKey: string;
  message?: string;
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
      ...(input.attachments === undefined
        ? {}
        : { attachments: input.attachments }),
      ...(input.message === undefined ? {} : { message: input.message }),
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
            "The request body must contain organizationId, projectId, and optionally message.",
          requestId: rid,
        });
      }
      if (!attachmentsWithinLimit(body.data.attachments)) {
        return apiErrorResponse({
          code: "invalid_request",
          message: "Attachments must total 12 MB or less.",
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
        attachments: body.data.attachments ?? [],
        idempotencyKey,
        message: promptMessage(body.data.message),
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

    /** Records an authorized answer for the exact suspended tool call. */
    answerRun: async (c: HandlerContext): Promise<Response> => {
      const rid = c.req.header("x-request-id") ?? crypto.randomUUID();
      const principal = await deps.resolvePrincipal({
        cookieHeader: c.req.header("cookie"),
      });
      if (!principal) {
        return apiErrorResponse({
          code: "unauthenticated",
          message: "A valid browser session is required.",
          requestId: rid,
        });
      }
      const organizationId = OrganizationIdSchema.safeParse(
        c.req.query("organizationId")
      );
      const projectId = ProjectIdSchema.safeParse(c.req.query("projectId"));
      const buildSessionId = BuildSessionIdSchema.safeParse(
        c.req.param("buildSessionId")
      );
      const runId = RunIdSchema.safeParse(c.req.param("runId"));
      const body = RunAnswerRequestSchema.safeParse(await c.req.json());
      if (
        !(
          organizationId.success &&
          projectId.success &&
          buildSessionId.success &&
          runId.success &&
          body.success
        )
      ) {
        return apiErrorResponse({
          code: "invalid_request",
          message:
            "A valid answer, question, run, conversation, and project scope are required.",
          requestId: rid,
        });
      }
      const scope = {
        organizationId: organizationId.data,
        projectId: projectId.data,
      };
      const decision = await authorizeProjectAction({
        action: "agent:run",
        deps,
        ...scope,
        principal,
      });
      if (!decision.allowed) {
        return apiErrorResponse({
          code: "forbidden",
          message: "You are not authorized to answer this question.",
          requestId: rid,
        });
      }
      const result = await deps.store().answerRunQuestion({
        ...body.data,
        buildSessionId: buildSessionId.data,
        requestedByUserId: principal.userId,
        runId: runId.data,
        scope,
      });
      if (result === "conflict") {
        return apiErrorResponse({
          code: "conflict",
          message: "This question is no longer waiting for an answer.",
          requestId: rid,
        });
      }
      return c.json(
        RunAnswerAcceptedSchema.parse({
          accepted: true,
          runId: runId.data,
          toolCallId: body.data.toolCallId,
        }),
        202
      );
    },

    /** One durable turn becomes one queued, tenant-scoped run. */
    appendTurn: async (c: HandlerContext): Promise<Response> => {
      const rid = c.req.header("x-request-id") ?? crypto.randomUUID();
      const principal = await deps.resolvePrincipal({
        cookieHeader: c.req.header("cookie"),
      });
      if (!principal) {
        return apiErrorResponse({
          code: "unauthenticated",
          message: "A valid browser session is required.",
          requestId: rid,
        });
      }
      const turnScope = parseConversationTurnScope(c);
      const body = await parseConversationTurn(c, rid);
      if (body instanceof Response) {
        return body;
      }
      if (!turnScope) {
        return apiErrorResponse({
          code: "invalid_request",
          message:
            "A message, idempotency key, conversation, and project scope are required.",
          requestId: rid,
        });
      }
      const { buildSessionId, idempotencyKey, scope } = turnScope;
      const decision = await authorizeProjectAction({
        action: "agent:run",
        deps,
        ...scope,
        principal,
      });
      if (!decision.allowed) {
        return apiErrorResponse({
          code: "forbidden",
          message: "You are not authorized to run this CTO.",
          requestId: rid,
        });
      }
      const store = deps.store();
      if (!(await store.getBuildSession(scope, buildSessionId))) {
        return apiErrorResponse({
          code: "not_found",
          message: "No such conversation.",
          requestId: rid,
        });
      }
      const refusal = await admitRun({
        entitlements: PLAN_ENTITLEMENTS[defaultPlan],
        organizationId: scope.organizationId,
        requestId: rid,
        store,
      });
      if (refusal) {
        return refusal;
      }
      const accepted = await appendAcceptedConversationTurn({
        attachments: body.attachments ?? [],
        buildSessionId,
        idempotencyKey,
        message: promptMessage(body.message),
        requestId: rid,
        scope,
        store,
      });
      if (accepted instanceof Response) {
        return accepted;
      }
      return c.json(
        ConversationTurnAcceptedSchema.parse({
          buildSessionId,
          runId: accepted.runId,
          sequence: 1,
        }),
        202
      );
    },

    /** A durable, project-authorized request for the worker to abort this run. */
    cancelRun: async (c: HandlerContext): Promise<Response> => {
      const rid = c.req.header("x-request-id") ?? crypto.randomUUID();
      const principal = await deps.resolvePrincipal({
        cookieHeader: c.req.header("cookie"),
      });
      if (!principal) {
        return apiErrorResponse({
          code: "unauthenticated",
          message: "A valid browser session is required.",
          requestId: rid,
        });
      }
      const organizationId = OrganizationIdSchema.safeParse(
        c.req.query("organizationId")
      );
      const projectId = ProjectIdSchema.safeParse(c.req.query("projectId"));
      const buildSessionId = BuildSessionIdSchema.safeParse(
        c.req.param("buildSessionId")
      );
      const runId = RunIdSchema.safeParse(c.req.param("runId"));
      if (
        !(
          organizationId.success &&
          projectId.success &&
          buildSessionId.success &&
          runId.success
        )
      ) {
        return apiErrorResponse({
          code: "invalid_request",
          message: "A conversation, run, and project scope are required.",
          requestId: rid,
        });
      }
      const scope = {
        organizationId: organizationId.data,
        projectId: projectId.data,
      };
      const decision = await authorizeProjectAction({
        action: "agent:run",
        deps,
        ...scope,
        principal,
      });
      if (!decision.allowed) {
        return apiErrorResponse({
          code: "forbidden",
          message: "You are not authorized to stop work on this project.",
          requestId: rid,
        });
      }
      const store = deps.store();
      const [session, run] = await Promise.all([
        store.getBuildSession(scope, buildSessionId.data),
        store.getRun({ ...scope, runId: runId.data }),
      ]);
      if (!(session && run) || run.buildSessionId !== buildSessionId.data) {
        return apiErrorResponse({
          code: "not_found",
          message: "No such active run.",
          requestId: rid,
        });
      }
      const accepted = await store.requestRunCancellation({
        buildSessionId: buildSessionId.data,
        requestedByUserId: principal.userId,
        runId: runId.data,
        scope,
      });
      if (!accepted) {
        return apiErrorResponse({
          code: "conflict",
          message: "This run has already finished.",
          requestId: rid,
        });
      }
      return c.json({ accepted: true, runId: runId.data }, 202);
    },

    /** User-visible messages, including turns from earlier runs. */
    history: async (c: HandlerContext): Promise<Response> => {
      const rid = c.req.header("x-request-id") ?? crypto.randomUUID();
      const principal = await deps.resolvePrincipal({
        cookieHeader: c.req.header("cookie"),
      });
      if (!principal) {
        return apiErrorResponse({
          code: "unauthenticated",
          message: "A valid browser session is required.",
          requestId: rid,
        });
      }
      const organizationId = OrganizationIdSchema.safeParse(
        c.req.query("organizationId")
      );
      const projectId = ProjectIdSchema.safeParse(c.req.query("projectId"));
      const buildSessionId = BuildSessionIdSchema.safeParse(
        c.req.param("buildSessionId")
      );
      if (
        !(organizationId.success && projectId.success && buildSessionId.success)
      ) {
        return apiErrorResponse({
          code: "invalid_request",
          message: "A conversation and both scope identifiers are required.",
          requestId: rid,
        });
      }
      const scope = {
        organizationId: organizationId.data,
        projectId: projectId.data,
      };
      const decision = await authorizeProjectAction({
        action: "project:read",
        deps,
        ...scope,
        principal,
      });
      if (!decision.allowed) {
        return apiErrorResponse({
          code: "forbidden",
          message: "You are not authorized to read this project.",
          requestId: rid,
        });
      }
      if (!(await deps.store().getBuildSession(scope, buildSessionId.data))) {
        return apiErrorResponse({
          code: "not_found",
          message: "No such conversation.",
          requestId: rid,
        });
      }
      const after = z.coerce
        .number()
        .int()
        .min(0)
        .max(1_000_000)
        .safeParse(c.req.query("after") ?? 0);
      if (!after.success) {
        return apiErrorResponse({
          code: "invalid_request",
          message: "Invalid conversation cursor.",
          requestId: rid,
        });
      }
      const messages = await deps.store().listConversationMessages({
        buildSessionId: buildSessionId.data,
        scope,
      });
      const events = await deps.store().listConversationEvents({
        after: after.data,
        buildSessionId: buildSessionId.data,
        limit: 500,
        scope,
      });
      return c.json(
        ConversationTranscriptSchema.parse({
          events,
          messages,
          nextAfter: events.length === 500 ? after.data + events.length : null,
        }),
        200
      );
    },
    /** All conversations visible to a member of this project. */
    listConversations: async (c: HandlerContext): Promise<Response> => {
      const rid = c.req.header("x-request-id") ?? crypto.randomUUID();
      const principal = await deps.resolvePrincipal({
        cookieHeader: c.req.header("cookie"),
      });
      if (!principal) {
        return apiErrorResponse({
          code: "unauthenticated",
          message: "A valid browser session is required.",
          requestId: rid,
        });
      }
      const organizationId = OrganizationIdSchema.safeParse(
        c.req.query("organizationId")
      );
      const projectId = ProjectIdSchema.safeParse(c.req.param("projectId"));
      if (!(organizationId.success && projectId.success)) {
        return apiErrorResponse({
          code: "invalid_request",
          message: "Organization and project identifiers are required.",
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
          code: "forbidden",
          message: "You are not authorized to read this project.",
          requestId: rid,
        });
      }
      const conversations = await deps.store().listConversations({
        organizationId: organizationId.data,
        projectId: projectId.data,
      });
      return c.json(ConversationListSchema.parse({ conversations }), 200);
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

    /** Retry is explicit; reconnecting a stream never submits another run. */
    retryRun: async (c: HandlerContext): Promise<Response> => {
      const rid = c.req.header("x-request-id") ?? crypto.randomUUID();
      const principal = await deps.resolvePrincipal({
        cookieHeader: c.req.header("cookie"),
      });
      if (!principal) {
        return apiErrorResponse({
          code: "unauthenticated",
          message: "A valid browser session is required.",
          requestId: rid,
        });
      }
      const turnScope = parseConversationTurnScope(c);
      const sourceRunId = RunIdSchema.safeParse(c.req.param("runId"));
      if (!(turnScope && sourceRunId.success)) {
        return apiErrorResponse({
          code: "invalid_request",
          message:
            "A run, idempotency key, conversation, and project scope are required.",
          requestId: rid,
        });
      }
      const { buildSessionId, idempotencyKey, scope } = turnScope;
      const decision = await authorizeProjectAction({
        action: "agent:run",
        deps,
        ...scope,
        principal,
      });
      if (!decision.allowed) {
        return apiErrorResponse({
          code: "forbidden",
          message: "You are not authorized to retry this generation.",
          requestId: rid,
        });
      }
      const store = deps.store();
      const [session, source] = await Promise.all([
        store.getBuildSession(scope, buildSessionId),
        store.getRun({ ...scope, runId: sourceRunId.data }),
      ]);
      if (!(session && source) || source.buildSessionId !== buildSessionId) {
        return apiErrorResponse({
          code: "not_found",
          message: "No such generation in this conversation.",
          requestId: rid,
        });
      }
      if (source.status !== "failed" && source.status !== "cancelled") {
        return apiErrorResponse({
          code: "conflict",
          message: "Only a failed or cancelled generation can be retried.",
          requestId: rid,
        });
      }
      const accepted = await retryAcceptedConversationTurn({
        buildSessionId,
        idempotencyKey,
        requestId: rid,
        retryRunId: sourceRunId.data,
        scope,
        store,
      });
      if (accepted instanceof Response) {
        return accepted;
      }
      return c.json(
        ConversationTurnAcceptedSchema.parse({
          buildSessionId,
          runId: accepted.runId,
          sequence: 1,
        }),
        202
      );
    },
  };
}
