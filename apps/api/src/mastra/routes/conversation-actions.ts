import { homedir } from "node:os";
import { join } from "node:path";
import { defaultPlan } from "@reasonateai/auth/entitlements";
import { PLAN_ENTITLEMENTS } from "@reasonateai/contracts/entitlements";
import {
  BuildSessionIdSchema,
  ConversationBranchRequestSchema,
  ConversationFeedbackRequestSchema,
  ConversationFeedbackResponseSchema,
  ConversationReplayRequestSchema,
  ConversationTurnAcceptedSchema,
} from "@reasonateai/contracts/execution";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
} from "@reasonateai/contracts/identity";
import { ConversationHistoryError } from "@reasonateai/project-state/conversation-history";
import {
  type CheckpointStore,
  createGitCheckpointStore,
  parseCheckpointId,
} from "@reasonateai/sandbox/checkpoint";
import { apiErrorResponse, unauthenticatedResponse } from "../principal";
import { auditEvent } from "./auth";
import {
  admitRun,
  authorizeProjectAction,
  type BuildSessionRouteDeps,
  type HandlerContext,
} from "./build-sessions";

export const CONVERSATION_BRANCH_PATH =
  "/v1/build-sessions/:buildSessionId/branches";
export const CONVERSATION_FEEDBACK_PATH =
  "/v1/build-sessions/:buildSessionId/feedback";
export function createConversationActionHandlers(
  deps: BuildSessionRouteDeps & {
    checkpoints?: () => CheckpointStore;
    onFailure?: (cause: unknown) => void;
  }
) {
  let checkpointStore: CheckpointStore | undefined;
  const checkpoints = () => {
    if (deps.checkpoints) {
      return deps.checkpoints();
    }
    checkpointStore ??= createGitCheckpointStore({
      root:
        process.env.REASONATE_CHECKPOINT_ROOT ??
        join(homedir(), ".reasonateai", "checkpoints"),
    });
    return checkpointStore;
  };
  const authorizeRequest = async (c: HandlerContext, requiresKey: boolean) => {
    const requestId = c.req.header("x-request-id") ?? crypto.randomUUID();
    const principal = await deps.resolvePrincipal({
      cookieHeader: c.req.header("cookie"),
    });
    if (!principal) {
      return unauthenticatedResponse(requestId);
    }
    const organization = OrganizationIdSchema.safeParse(
      c.req.query("organizationId")
    );
    const project = ProjectIdSchema.safeParse(c.req.query("projectId"));
    const session = BuildSessionIdSchema.safeParse(
      c.req.param("buildSessionId")
    );
    const key = c.req.header("idempotency-key");
    if (
      !(organization.success && project.success && session.success) ||
      (requiresKey && !(key && key.length <= 128))
    ) {
      return apiErrorResponse({
        code: "invalid_request",
        message: "A conversation, project scope, and request key are required.",
        requestId,
      });
    }
    const scope = {
      organizationId: organization.data,
      projectId: project.data,
    };
    const authorization = await authorizeProjectAction({
      action: "agent:run",
      deps,
      ...scope,
      principal,
    });
    if (!authorization.allowed) {
      return apiErrorResponse({
        code: "forbidden",
        message: "You cannot change this conversation.",
        requestId,
      });
    }
    const store = deps.store();
    if (!(await store.getBuildSession(scope, session.data))) {
      return apiErrorResponse({
        code: "not_found",
        message: "Conversation not found.",
        requestId,
      });
    }
    return {
      key: key ?? "",
      principal,
      requestId,
      scope,
      session: session.data,
      store,
    };
  };
  const feedback = async (c: HandlerContext) => {
    const authorized = await authorizeRequest(c, false);
    if (authorized instanceof Response) {
      return authorized;
    }
    const { principal, requestId, scope, session, store } = authorized;
    const body = await c.req.json().catch(() => undefined);
    const parsed = ConversationFeedbackRequestSchema.safeParse(body);
    if (!parsed.success) {
      return apiErrorResponse({
        code: "invalid_request",
        message: "Choose positive or negative feedback for a completed turn.",
        requestId,
      });
    }
    const saved = await store.history.feedback(
      scope,
      session,
      parsed.data.runId,
      principal.userId,
      parsed.data.feedback
    );
    return saved
      ? c.json(ConversationFeedbackResponseSchema.parse(parsed.data), 200)
      : apiErrorResponse({
          code: "conflict",
          message:
            "This answer is no longer a completed turn in this conversation.",
          requestId,
        });
  };
  const parseCommand = async (
    c: HandlerContext,
    action: "branch" | "retry",
    requestId: string
  ) => {
    const body = await c.req.json().catch(() => undefined);
    const branchBody = ConversationBranchRequestSchema.safeParse(body);
    const retryBody = ConversationReplayRequestSchema.safeParse(body);
    const run = RunIdSchema.safeParse(
      action === "branch" && branchBody.success
        ? branchBody.data.runId
        : c.req.param("runId")
    );
    if (
      !run.success ||
      (action === "branch" ? !branchBody.success : !retryBody.success)
    ) {
      return apiErrorResponse({
        code: "invalid_request",
        message: "Choose a saved turn and a valid message.",
        requestId,
      });
    }
    return {
      message:
        action === "retry" && retryBody.success
          ? retryBody.data.message
          : undefined,
      runId: run.data,
    };
  };
  type Authorized = Exclude<
    Awaited<ReturnType<typeof authorizeRequest>>,
    Response
  >;
  type Command = Exclude<Awaited<ReturnType<typeof parseCommand>>, Response>;
  const changeHistory = (
    authorized: Authorized,
    action: "branch" | "retry",
    command: Command
  ) => {
    const { key, principal, requestId, scope, session, store } = authorized;
    return store.history.change({
      action,
      audit: auditEvent({
        action:
          action === "branch" ? "conversation.branch" : "conversation.retry",
        actor: principal,
        metadata: {},
        ...scope,
        requestId,
      }),
      buildSessionId: session,
      idempotencyKey: key,
      latestCheckpoint: async () =>
        (await checkpoints().latest(scope))?.checkpointId,
      message: command.message,
      requestedByUserId: principal.userId,
      runId: command.runId,
      scope,
      userSessionId: principal.sessionId,
      validateCheckpoint: async (checkpointId) => {
        const parsed = parseCheckpointId(checkpointId);
        if (
          parsed.organizationId !== scope.organizationId ||
          parsed.projectId !== scope.projectId
        ) {
          throw new ConversationHistoryError(
            "The saved checkpoint belongs to a different project."
          );
        }
        await checkpoints().read(checkpointId);
      },
    });
  };
  const handle = async (c: HandlerContext, action: "branch" | "retry") => {
    const authorized = await authorizeRequest(c, true);
    if (authorized instanceof Response) {
      return authorized;
    }
    const { principal, requestId, scope } = authorized;
    if (action === "retry") {
      const restore = await authorizeProjectAction({
        action: "checkpoint:restore",
        deps,
        ...scope,
        principal,
      });
      if (!restore.allowed) {
        return apiErrorResponse({
          code: "forbidden",
          message: "You cannot restore this conversation's files.",
          requestId,
        });
      }
    }
    const command = await parseCommand(c, action, requestId);
    if (command instanceof Response) {
      return command;
    }
    return await perform(c, action, authorized, command);
  };
  const perform = async (
    c: HandlerContext,
    action: "branch" | "retry",
    authorized: Authorized,
    command: Command
  ) => {
    const { key, requestId, scope, session, store } = authorized;
    let reserved = false;
    try {
      const replay = await store.history.lookup({
        action,
        buildSessionId: session,
        idempotencyKey: key,
        message: command.message,
        runId: command.runId,
        scope,
      });
      if (replay) {
        return c.json(
          ConversationTurnAcceptedSchema.parse({
            buildSessionId: replay.buildSessionId,
            runId: replay.runId,
            sequence: 1,
          }),
          202
        );
      }
      if (action === "retry") {
        const refusal = await admitRun({
          entitlements: PLAN_ENTITLEMENTS[defaultPlan],
          organizationId: scope.organizationId,
          requestId,
          store,
        });
        if (refusal) {
          return refusal;
        }
        reserved = true;
      }
      const accepted = await changeHistory(authorized, action, command);
      if (reserved && !accepted.created) {
        await store.usage.record({
          amount: -1,
          metric: "runs",
          organizationId: scope.organizationId,
          runId: null,
        });
      }
      return c.json(
        ConversationTurnAcceptedSchema.parse({
          buildSessionId: accepted.buildSessionId,
          runId: accepted.runId,
          sequence: 1,
        }),
        202
      );
    } catch (cause) {
      deps.onFailure?.(cause);
      console.error(
        JSON.stringify({
          action,
          event: "conversation.history.failed",
          requestId,
          ...scope,
          buildSessionId: session,
          reason:
            cause instanceof ConversationHistoryError
              ? "conflict"
              : "checkpoint_or_persistence_failure",
        })
      );
      if (reserved) {
        await store.usage.record({
          amount: -1,
          metric: "runs",
          organizationId: scope.organizationId,
          runId: null,
        });
      }
      return historyFailure(cause, requestId);
    }
  };
  return {
    branch: (c: HandlerContext) => handle(c, "branch"),
    feedback,
    retry: (c: HandlerContext) => handle(c, "retry"),
  };
}

function historyFailure(cause: unknown, requestId: string) {
  return apiErrorResponse({
    code: cause instanceof ConversationHistoryError ? "conflict" : "internal",
    message:
      cause instanceof ConversationHistoryError
        ? cause.message
        : "Could not change this conversation. Its history was left unchanged.",
    requestId,
  });
}
