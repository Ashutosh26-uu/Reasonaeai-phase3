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
import {
  type RunEventFanout,
  type RunEventSubscription,
  runEventFanout,
} from "../run-event-fanout";
import type { HandlerContext } from "./build-sessions";

export const RUN_EVENTS_PATH = "/v1/build-sessions/:buildSessionId/events";

const EVENTS_PAGE_SIZE = 200;

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
  /** Overridden by tests to drive live delivery without a live transport. */
  fanout?: RunEventFanout;
  resolvePrincipal: (input: {
    cookieHeader: string | undefined;
  }) => Promise<UserPrincipal | undefined>;
  store: () => ProjectStateStore;
}

export function createRunEventHandlers(deps: RunEventRouteDeps) {
  const fanout = deps.fanout ?? runEventFanout();

  return {
    /**
     * Streams a run's durable events, replaying from the caller's cursor before
     * following live.
     *
     * The ledger is the source for both phases: replay pages it up to the
     * caller's cursor, and a hole the live transport cannot bridge is
     * backfilled from the same ledger. Live delivery rides the process-wide
     * fan-out, so concurrent followers of one run share one subscription
     * instead of each polling the ledger on its own timer.
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
      const abortSignal = c.req.raw?.signal;

      let stop: (() => void) | undefined;
      const onAbort = () => stop?.();

      const body = new ReadableStream<Uint8Array>({
        cancel() {
          stop?.();
        },
        start(controller) {
          let closed = false;
          let lastSent = cursor;
          let subscription: RunEventSubscription | undefined;
          // Live delivery and gap backfill both write, and a gap is discovered
          // in the middle of a delivery burst, so every write is chained: the
          // stream must never emit a later sequence ahead of an earlier one.
          let pending: Promise<void> = Promise.resolve();

          const write = (chunk: string) => {
            if (!closed) {
              controller.enqueue(encoder.encode(chunk));
            }
          };

          const emit = (event: RunEventEnvelope) => {
            // The transport is at-least-once and backfill overlaps live
            // delivery, so the same sequence can arrive twice; the cursor is
            // what keeps the stream exact.
            if (event.sequence <= lastSent) {
              return;
            }
            write(formatServerSentEvent(event));
            lastSent = event.sequence;
          };

          const readLedger = async () => {
            // Paging is cursor-dependent: each page resumes after the previous
            // page's last sequence, so the reads cannot overlap.
            for (;;) {
              // biome-ignore lint/performance/noAwaitInLoops: cursor-dependent pagination
              const batch = await deps.store().listRunEvents({
                afterSequence: lastSent,
                limit: EVENTS_PAGE_SIZE,
                runId,
                scope,
              });
              for (const event of batch) {
                emit(event);
              }
              if (batch.length < EVENTS_PAGE_SIZE) {
                return;
              }
            }
          };

          const enqueue = (task: () => Promise<void> | void) => {
            pending = pending.then(task).catch(() => undefined);
          };

          stop = () => {
            closed = true;
            abortSignal?.removeEventListener("abort", onAbort);
            subscription?.close();
          };

          const begin = async () => {
            // Replay everything the client missed before going live: the ledger
            // covers the run up to now, so the transport only has to carry what
            // happens next.
            await readLedger();
            if (closed) {
              return;
            }
            subscription = fanout.subscribe({
              buildSessionId: buildSession.buildSessionId,
              lastDelivered: lastSent,
              listener: (event) => {
                enqueue(() => emit(event));
              },
              onGap: () => {
                // The listener attached after these events flowed, so the
                // transport cannot hand them over; the ledger can.
                enqueue(readLedger);
              },
              organizationId,
              projectId,
              runId,
            });
          };

          abortSignal?.addEventListener("abort", onAbort, { once: true });
          if (abortSignal?.aborted) {
            stop();
            controller.close();
            return;
          }

          begin().catch(() => {
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
