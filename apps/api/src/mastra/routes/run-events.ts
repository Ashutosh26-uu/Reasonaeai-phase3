import { authorize } from "@reasonateai/auth/authorize";
import type { ApiErrorCode } from "@reasonateai/contracts/api-error";
import { BuildSessionIdSchema } from "@reasonateai/contracts/execution";
import {
  isReplayableSequence,
  type RunEventEnvelope,
} from "@reasonateai/contracts/execution-protocol";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
  type UserPrincipal,
} from "@reasonateai/contracts/identity";
import type { ProjectStateStore } from "@reasonateai/project-state/postgres";
import { z } from "zod";
import { apiErrorResponse } from "../principal";
import type { HandlerContext } from "./build-sessions";

export const RUN_EVENTS_PATH = "/v1/build-sessions/:buildSessionId/events";

const EVENTS_PAGE_SIZE = 200;
const HEARTBEAT = ": keep-alive\n\n";

const EventsParamsSchema = z.strictObject({ buildSessionId: z.uuid() });
const EventsQuerySchema = z.strictObject({
  after: z.coerce.number().int().min(0).optional(),
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
 * Serializes one event as an SSE frame. The `id` field carries the ledger
 * sequence, so a browser that reconnects sends it back as `Last-Event-ID` and
 * resumes exactly where it stopped.
 *
 * Exported because it defines the wire format the browser client depends on.
 */
export function formatServerSentEvent(event: RunEventEnvelope): string {
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export interface RunEventRouteDeps {
  /** How long to wait between ledger reads while following a run. */
  pollIntervalMs?: number;
  resolvePrincipal: (input: {
    cookieHeader: string | undefined;
  }) => Promise<UserPrincipal | undefined>;
  store: () => ProjectStateStore;
}

export function createRunEventHandlers(deps: RunEventRouteDeps) {
  const pollIntervalMs = deps.pollIntervalMs ?? 1000;

  return {
    /**
     * Streams a run's durable events, replaying from the caller's cursor before
     * following live.
     *
     * The ledger is the source for both phases. Following by reading the ledger
     * rather than subscribing to Redis means replay and live delivery share one
     * code path and one ordering guarantee, and a reconnect can never lose or
     * duplicate a user-visible transition.
     */
    stream: async (c: HandlerContext): Promise<Response> => {
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

      const params = EventsParamsSchema.safeParse({
        buildSessionId: c.req.param("buildSessionId"),
      });
      const query = EventsQuerySchema.safeParse({
        after: c.req.query("after"),
        organizationId: c.req.query("organizationId"),
        projectId: c.req.query("projectId"),
      });

      if (!(params.success && query.success)) {
        return apiErrorResponse({
          code: "invalid_request",
          message:
            "A build session id, both scope identifiers, and a non-negative cursor are required.",
          requestId: rid,
        });
      }

      const organizationId = OrganizationIdSchema.parse(
        query.data.organizationId
      );
      const projectId = ProjectIdSchema.parse(query.data.projectId);
      const scope = { organizationId, projectId };

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

      const decision = authorize({
        action: "project:read",
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
        return apiErrorResponse({
          code: DENIAL_BY_REASON[decision.reason] ?? "forbidden",
          message: "You are not authorized to follow this project.",
          requestId: rid,
        });
      }

      const buildSession = await deps
        .store()
        .getBuildSession(
          scope,
          BuildSessionIdSchema.parse(params.data.buildSessionId)
        );

      if (!buildSession) {
        return apiErrorResponse({
          code: "not_found",
          message: "No such build session.",
          requestId: rid,
        });
      }

      // `Last-Event-ID` is what a reconnecting browser sends automatically; the
      // query parameter exists for clients that cannot set the header.
      const headerCursor = Number(c.req.header("last-event-id") ?? "0");
      const cursor = isReplayableSequence(headerCursor)
        ? headerCursor
        : (query.data.after ?? 0);

      const { runId } = buildSession;
      const encoder = new TextEncoder();

      let stop: (() => void) | undefined;

      const body = new ReadableStream<Uint8Array>({
        cancel() {
          stop?.();
        },
        start(controller) {
          let closed = false;
          let following = false;
          let lastSent = cursor;
          let timer: NodeJS.Timeout | undefined;

          const write = (chunk: string) => {
            if (!closed) {
              controller.enqueue(encoder.encode(chunk));
            }
          };

          stop = () => {
            closed = true;
            if (timer) {
              clearInterval(timer);
              timer = undefined;
            }
          };

          const readBatch = async () =>
            await deps.store().listRunEvents({
              afterSequence: lastSent,
              limit: EVENTS_PAGE_SIZE,
              runId,
              scope,
            });

          const emit = (event: RunEventEnvelope) => {
            write(formatServerSentEvent(event));
            lastSent = event.sequence;
          };

          const follow = async () => {
            if (following || closed) {
              return;
            }
            following = true;
            try {
              const batch = await readBatch();
              if (batch.length === 0) {
                // An idle stream needs traffic so intermediaries do not close it.
                write(HEARTBEAT);
                return;
              }
              for (const event of batch) {
                emit(event);
              }
            } catch {
              // A transient read failure must not end the stream; the next tick
              // retries from the same cursor.
              write(HEARTBEAT);
            } finally {
              following = false;
            }
          };

          (async () => {
            // Replay everything the client missed before going live. Paging is
            // inherently sequential: each page's cursor is the previous page's
            // last sequence, so the reads cannot overlap.
            for (;;) {
              // biome-ignore lint/performance/noAwaitInLoops: cursor-dependent pagination
              const batch = await readBatch();
              for (const event of batch) {
                emit(event);
              }
              if (batch.length < EVENTS_PAGE_SIZE) {
                break;
              }
            }

            if (closed) {
              return;
            }

            // `follow` swallows its own read failures and never rejects, so the
            // tick does not need a rejection handler.
            timer = setInterval(() => {
              follow();
            }, pollIntervalMs);
          })().catch(() => {
            closed = true;
            controller.close();
          });
        },
      });

      return new Response(body, {
        headers: {
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "Content-Type": "text/event-stream",
          "X-Accel-Buffering": "no",
        },
      });
    },
  };
}
