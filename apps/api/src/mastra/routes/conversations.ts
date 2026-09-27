import { authorize } from "@reasonateai/auth/authorize";
import type { ApiErrorCode } from "@reasonateai/contracts/api-error";
import {
  AppendConversationTurnRequestSchema,
  type BuildSessionId,
  BuildSessionIdSchema,
  ConversationHistorySchema,
  ConversationListSchema,
  type ConversationMessage,
  conversationThreadId,
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
  ProjectStateStore,
  TenantScope,
} from "@reasonateai/project-state/postgres";
import { z } from "zod";
import {
  apiErrorResponse,
  readJsonBody,
  unauthenticatedResponse,
} from "../principal";
import { admitRun, type HandlerContext, refundRunSlot } from "./build-sessions";

/**
 * Conversation routes.
 *
 * A conversation is a build session: it belongs to one project, it has one CTO
 * thread, and the messages the user and the CTO exchange live in the
 * authoritative Mastra store under that thread's identifier. A project
 * therefore accumulates conversations over its life, and the product is not
 * only the newest one.
 *
 * History is read from durable storage rather than from any process-local
 * session, so a browser that reconnects — or the worker that executes the next
 * turn — sees the same conversation the user left. Nothing here is served from
 * memory the API happens to hold.
 */

/**
 * Product routes live outside the `/api` prefix on purpose, the same as every
 * other product route: the ingress denial blocks the built-in Mastra route
 * groups under `/api`.
 */
export const PROJECT_CONVERSATIONS_PATH =
  "/v1/projects/:projectId/conversations";
export const BUILD_SESSION_MESSAGES_PATH =
  "/v1/build-sessions/:buildSessionId/messages";
export const BUILD_SESSION_CLOSE_PATH =
  "/v1/build-sessions/:buildSessionId/close";

/** Bound on one history read. The newest messages are the ones a client needs. */
const MESSAGE_HISTORY_LIMIT = 200;

const ConversationParamsSchema = z.strictObject({
  buildSessionId: z.uuid(),
});

const ProjectParamsSchema = z.strictObject({ projectId: z.uuid() });

const ScopeQuerySchema = z.strictObject({
  organizationId: z.uuid(),
  projectId: z.uuid(),
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

/**
 * The fields this route reads off a stored message. Declared structurally so
 * the route does not depend on the storage adapter's own type surface.
 */
export interface DurableMessage {
  content?: {
    content?: unknown;
    parts?: readonly { text?: unknown; type?: unknown }[];
  };
  createdAt?: Date | string;
  id: string;
  role?: string;
}

/** The slice of the durable Mastra store these routes read. */
export interface ConversationMemory {
  listMessages: (input: {
    threadId: string;
    resourceId?: string;
    perPage?: number | false;
  }) => Promise<{ messages: DurableMessage[] }>;
  listThreads: (input: {
    filter?: { resourceId?: string };
    perPage?: number | false;
  }) => Promise<{ threads: { id: string; title?: string }[] }>;
}

export interface ConversationRouteDeps {
  /** Plan limits a turn is admitted against. */
  entitlements: Parameters<typeof admitRun>[0]["entitlements"];
  /** The durable Mastra store, resolved per request so it is created only when used. */
  memory: () => Promise<ConversationMemory>;
  resolvePrincipal: (input: {
    cookieHeader: string | undefined;
  }) => Promise<UserPrincipal | undefined>;
  store: () => ProjectStateStore;
}

interface ScopedRequest {
  action: Permission;
  buildSessionId: BuildSessionId;
  organizationId: OrganizationId;
  principal: UserPrincipal;
  projectId: ProjectId;
  requestId: string;
}

/** The text a person is meant to read, with the model's internal parts dropped. */
function messageText(message: DurableMessage): string {
  const parts = message.content?.parts ?? [];
  const fromParts = parts
    .map((part) =>
      part.type === "text" && typeof part.text === "string" ? part.text : ""
    )
    .join("");

  if (fromParts.length > 0) {
    return fromParts;
  }

  const legacy = message.content?.content;
  return typeof legacy === "string" ? legacy : "";
}

/**
 * Storage roles are the four a person can see. A message the platform stored
 * for its own bookkeeping is presented as a system message rather than dropped,
 * so a transcript never silently loses a turn.
 */
function messageRole(role: string | undefined): ConversationMessage["role"] {
  switch (role) {
    case "assistant":
      return "assistant";
    case "tool":
      return "tool";
    case "user":
      return "user";
    default:
      return "system";
  }
}

function createdAtIso(value: Date | string | undefined): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return typeof value === "string" ? value : new Date(0).toISOString();
}

function toConversationMessage(message: DurableMessage): ConversationMessage {
  return {
    createdAt: createdAtIso(message.createdAt),
    id: message.id,
    role: messageRole(message.role),
    text: messageText(message).slice(0, 1_000_000),
  };
}

export function createConversationHandlers(deps: ConversationRouteDeps) {
  /**
   * The whole guard for a conversation read or write: a verified principal, a
   * well-formed scope, and one centralized authorization decision. Returned as
   * a value so each handler answers with exactly one refusal and continues on
   * one success path.
   */
  const resolveScopedRequest = async (
    c: HandlerContext,
    action: Permission
  ): Promise<{ response: Response } | { scoped: ScopedRequest }> => {
    const requestId = c.req.header("x-request-id") ?? crypto.randomUUID();
    const principal = await deps.resolvePrincipal({
      cookieHeader: c.req.header("cookie"),
    });
    if (!principal) {
      return { response: unauthenticatedResponse(requestId) };
    }

    const params = ConversationParamsSchema.safeParse({
      buildSessionId: c.req.param("buildSessionId"),
    });
    const query = ScopeQuerySchema.safeParse({
      organizationId: c.req.query("organizationId"),
      projectId: c.req.query("projectId"),
    });
    if (!(params.success && query.success)) {
      return {
        response: apiErrorResponse({
          code: "invalid_request",
          message: "A conversation id and both scope identifiers are required.",
          requestId,
        }),
      };
    }

    const organizationId = OrganizationIdSchema.parse(
      query.data.organizationId
    );
    const projectId = ProjectIdSchema.parse(query.data.projectId);

    const organizationMembership = await deps
      .store()
      .memberships.getOrganizationMembership({
        organizationId,
        userId: principal.userId,
      });
    const projectMembership = await deps
      .store()
      .memberships.getProjectMembership({
        organizationId,
        projectId,
        userId: principal.userId,
      });

    const decision = await authorize({
      action,
      now: new Date().toISOString(),
      organizationMembership: organizationMembership ?? null,
      principal,
      projectMembership: projectMembership ?? null,
      resource: {
        kind: "project",
        organizationId,
        projectId,
        resourceId: null,
      },
    });
    if (!decision.allowed) {
      return {
        response: apiErrorResponse({
          code: DENIAL_BY_REASON[decision.reason] ?? "forbidden",
          message: "You are not authorized to act on this project.",
          requestId,
        }),
      };
    }

    return {
      scoped: {
        action,
        buildSessionId: BuildSessionIdSchema.parse(params.data.buildSessionId),
        organizationId,
        principal,
        projectId,
        requestId,
      },
    };
  };

  /** The messages of one conversation, or the refusal that stands in their way. */
  const readHistory = async (
    scoped: ScopedRequest
  ): Promise<ConversationMessage[]> => {
    const memory = await deps.memory();
    const stored = await memory.listMessages({
      perPage: MESSAGE_HISTORY_LIMIT,
      resourceId: scoped.projectId,
      threadId: conversationThreadId(scoped.buildSessionId),
    });

    return stored.messages
      .map(toConversationMessage)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  };

  return {
    /**
     * Submits the next turn. The turn is a new run of the conversation's build
     * session, admitted against the plan exactly as an allocation is, and the
     * worker that claims the run sends this message into the durable thread.
     */
    appendTurn: async (c: HandlerContext): Promise<Response> => {
      const resolved = await resolveScopedRequest(c, "agent:run");
      if ("response" in resolved) {
        return resolved.response;
      }
      const { scoped } = resolved;

      const body = AppendConversationTurnRequestSchema.safeParse(
        await readJsonBody(c.req)
      );
      if (!body.success) {
        return apiErrorResponse({
          code: "invalid_request",
          message: "The request body must contain only a message.",
          requestId: scoped.requestId,
        });
      }

      const store = deps.store();
      const refusal = await admitRun({
        entitlements: deps.entitlements,
        organizationId: scoped.organizationId,
        requestId: scoped.requestId,
        store,
      });
      if (refusal !== undefined) {
        return refusal;
      }

      const turn = await store
        .appendConversationTurn({
          buildSessionId: scoped.buildSessionId,
          message: body.data.message,
          scope: {
            organizationId: scoped.organizationId,
            projectId: scoped.projectId,
          },
        })
        .catch(async (error: unknown) => {
          // The slot was taken but there is no run to spend it on.
          await refundRunSlot(store, scoped.organizationId);
          throw error;
        });

      if (turn.kind !== "queued") {
        // No run was queued, so this request's run slot goes back to the plan.
        await refundRunSlot(store, scoped.organizationId);
      }

      if (turn.kind === "missing") {
        return apiErrorResponse({
          code: "not_found",
          message: "No such conversation, or it has already been closed.",
          requestId: scoped.requestId,
        });
      }

      if (turn.kind === "busy") {
        return apiErrorResponse({
          code: "conflict",
          message:
            "This conversation already has a run in progress. Follow it, or wait for it to finish before sending another message.",
          requestId: scoped.requestId,
        });
      }

      return c.json(
        {
          buildSessionId: scoped.buildSessionId,
          runId: turn.runId,
          sequence: turn.sequence,
        },
        202
      );
    },

    /**
     * Closes a conversation so the project's next allocation starts a new one.
     * A conversation with a run in flight is refused: it is still working.
     */
    close: async (c: HandlerContext): Promise<Response> => {
      const resolved = await resolveScopedRequest(c, "project:update");
      if ("response" in resolved) {
        return resolved.response;
      }
      const { scoped } = resolved;

      const result = await deps.store().endBuildSession({
        buildSessionId: scoped.buildSessionId,
        scope: {
          organizationId: scoped.organizationId,
          projectId: scoped.projectId,
        },
      });

      if (result === "missing") {
        return apiErrorResponse({
          code: "not_found",
          message: "No such conversation.",
          requestId: scoped.requestId,
        });
      }
      if (result === "busy") {
        return apiErrorResponse({
          code: "conflict",
          message:
            "This conversation still has a run in progress and cannot be closed yet.",
          requestId: scoped.requestId,
        });
      }

      return c.json(
        { buildSessionId: scoped.buildSessionId, status: "completed" },
        200
      );
    },
    /**
     * Every conversation of the project, newest first. A caller outside the
     * project is refused rather than shown an empty list that would read as
     * "this project has no conversations".
     */
    list: async (c: HandlerContext): Promise<Response> => {
      const requestId = c.req.header("x-request-id") ?? crypto.randomUUID();
      const principal = await deps.resolvePrincipal({
        cookieHeader: c.req.header("cookie"),
      });
      if (!principal) {
        return unauthenticatedResponse(requestId);
      }

      const params = ProjectParamsSchema.safeParse({
        projectId: c.req.param("projectId"),
      });
      const organizationId = OrganizationIdSchema.safeParse(
        c.req.query("organizationId")
      );
      if (!(params.success && organizationId.success)) {
        return apiErrorResponse({
          code: "invalid_request",
          message: "A project id and an organization id are required.",
          requestId,
        });
      }

      const projectId = ProjectIdSchema.parse(params.data.projectId);
      const organizationMembership = await deps
        .store()
        .memberships.getOrganizationMembership({
          organizationId: organizationId.data,
          userId: principal.userId,
        });
      const projectMembership = await deps
        .store()
        .memberships.getProjectMembership({
          organizationId: organizationId.data,
          projectId,
          userId: principal.userId,
        });
      const decision = await authorize({
        action: "project:read",
        now: new Date().toISOString(),
        organizationMembership: organizationMembership ?? null,
        principal,
        projectMembership: projectMembership ?? null,
        resource: {
          kind: "project",
          organizationId: organizationId.data,
          projectId,
          resourceId: null,
        },
      });
      if (!decision.allowed) {
        return apiErrorResponse({
          code: DENIAL_BY_REASON[decision.reason] ?? "forbidden",
          message: "You are not authorized to read this project.",
          requestId,
        });
      }

      const scope: TenantScope = {
        organizationId: organizationId.data,
        projectId,
      };
      const conversations = await deps.store().listProjectConversations(scope);

      // Titles are Mastra's to generate, so they are read from the same store
      // the messages are: one lookup for the whole project rather than one per
      // conversation, and a conversation that has no title yet still lists.
      const memory = await deps.memory();
      const threads = await memory.listThreads({
        filter: { resourceId: projectId },
        perPage: false,
      });
      const titleByThread = new Map(
        threads.threads.map((thread) => [thread.id, thread.title ?? null])
      );

      return c.json(
        ConversationListSchema.parse({
          conversations: conversations.map((conversation) => ({
            buildSessionId: conversation.buildSessionId,
            createdAt: conversation.createdAt,
            latestRunId: conversation.latestRunId,
            pendingRunId: conversation.pendingRunId,
            status: conversation.status,
            title: titleByThread.get(conversation.buildSessionId) ?? null,
            updatedAt: conversation.updatedAt,
          })),
        }),
        200
      );
    },

    /** The durable transcript of one conversation. */
    readMessages: async (c: HandlerContext): Promise<Response> => {
      const resolved = await resolveScopedRequest(c, "project:read");
      if ("response" in resolved) {
        return resolved.response;
      }
      const { scoped } = resolved;

      // A conversation outside the caller's project is indistinguishable from
      // one that does not exist, so the transcript is only read once the build
      // session itself has been found in scope.
      const buildSession = await deps.store().getBuildSession(
        {
          organizationId: scoped.organizationId,
          projectId: scoped.projectId,
        },
        scoped.buildSessionId
      );
      if (!buildSession) {
        return apiErrorResponse({
          code: "not_found",
          message: "No such conversation.",
          requestId: scoped.requestId,
        });
      }

      return c.json(
        ConversationHistorySchema.parse({
          messages: await readHistory(scoped),
        }),
        200
      );
    },
  };
}
