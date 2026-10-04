import { authorize } from "@reasonateai/auth/authorize";
import { BuildSessionIdSchema } from "@reasonateai/contracts/execution";
import { IdempotencyKeySchema } from "@reasonateai/contracts/execution-protocol";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
} from "@reasonateai/contracts/identity";
import {
  RunSteeringAcceptedSchema,
  RunSteeringRequestSchema,
} from "@reasonateai/contracts/steering";
import { SteeringConflictError } from "@reasonateai/project-state/steering";
import { apiErrorResponse } from "../principal";
import type { BuildSessionRouteDeps, HandlerContext } from "./build-sessions";

export const RUN_STEERING_PATH =
  "/v1/build-sessions/:buildSessionId/runs/:runId/steering";

export function createRunSteeringHandlers(deps: BuildSessionRouteDeps) {
  return {
    steer: async (context: HandlerContext): Promise<Response> => {
      const requestId =
        context.req.header("x-request-id") ?? crypto.randomUUID();
      const refuse = (
        code:
          | "unauthenticated"
          | "invalid_request"
          | "forbidden"
          | "not_found"
          | "conflict",
        message: string
      ) => apiErrorResponse({ code, message, requestId });
      const principal = await deps.resolvePrincipal({
        cookieHeader: context.req.header("cookie"),
      });
      if (!principal) {
        return refuse(
          "unauthenticated",
          "A valid browser session is required."
        );
      }
      const organizationId = OrganizationIdSchema.safeParse(
        context.req.query("organizationId")
      );
      const projectId = ProjectIdSchema.safeParse(
        context.req.query("projectId")
      );
      const buildSessionId = BuildSessionIdSchema.safeParse(
        context.req.param("buildSessionId")
      );
      const runId = RunIdSchema.safeParse(context.req.param("runId"));
      const key = IdempotencyKeySchema.safeParse(
        context.req.header("idempotency-key")
      );
      const body = RunSteeringRequestSchema.safeParse(
        await context.req.json().catch(() => null)
      );
      if (
        !(
          organizationId.success &&
          projectId.success &&
          buildSessionId.success &&
          runId.success &&
          key.success &&
          body.success
        )
      ) {
        return refuse(
          "invalid_request",
          "A message, steering key, active run, and project scope are required."
        );
      }
      const scope = {
        organizationId: organizationId.data,
        projectId: projectId.data,
      };
      const store = deps.store();
      const [organizationMembership, projectMembership] = await Promise.all([
        store.memberships.getOrganizationMembership({
          organizationId: scope.organizationId,
          userId: principal.userId,
        }),
        store.memberships.getProjectMembership({
          ...scope,
          userId: principal.userId,
        }),
      ]);
      const decision = authorize({
        action: "agent:run",
        now: new Date().toISOString(),
        organizationMembership: organizationMembership ?? null,
        principal,
        projectMembership: projectMembership ?? null,
        resource: { kind: "project", ...scope, resourceId: null },
      });
      if (!decision.allowed) {
        return refuse("forbidden", "You are not authorized to steer this CTO.");
      }
      const run = await store.getRun({ ...scope, runId: runId.data });
      if (!run || run.buildSessionId !== buildSessionId.data) {
        return refuse("not_found", "No such run in this conversation.");
      }
      try {
        const accepted = await store.steering.request({
          buildSessionId: buildSessionId.data,
          idempotencyKey: key.data,
          message: body.data.message,
          requestedByUserId: principal.userId,
          runId: runId.data,
          scope,
        });
        if (!accepted) {
          return refuse(
            "conflict",
            "The CTO must be running to receive steering. Answer any pending question or send a new turn after it finishes."
          );
        }
        return context.json(RunSteeringAcceptedSchema.parse(accepted), 202);
      } catch (error) {
        if (error instanceof SteeringConflictError) {
          return refuse("conflict", error.message);
        }
        throw error;
      }
    },
  };
}
