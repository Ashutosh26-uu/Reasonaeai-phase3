import { randomUUID } from "node:crypto";
import type {
  AgentControllerEvent,
  Session,
} from "@mastra/core/agent-controller";
import type { RequestContext } from "@mastra/core/request-context";
import { PostgresStore } from "@mastra/pg";
import {
  type BuildSessionId,
  PreviewIdSchema,
  type PromptAttachment,
} from "@reasonateai/contracts/execution";
import { type RunId, RunIdSchema } from "@reasonateai/contracts/identity";
import { createReasonateCtoRuntime } from "@reasonateai/cto-runtime";
import { sandboxIdFor } from "@reasonateai/cto-runtime/run-scope";
import type {
  ProjectStateStore,
  TenantScope,
} from "@reasonateai/project-state/postgres";
import {
  buildSandboxEnvironment,
  reasonateBuildWorkspace,
  SANDBOX_WORKING_DIRECTORY,
} from "./workspace.js";

/**
 * The controller the worker drives, narrowed to what driving it needs.
 *
 * A worker needs three things from a session — subscribe to its events, send it
 * the run's directive, and abort the step it is in — and one thing from the
 * controller — create a session bound to the run's scope. Declaring only those
 * keeps the seam a caller can substitute (a scripted controller in a test)
 * without letting a substitute pretend to be the whole controller, and the real
 * `AgentController` satisfies it as written because the members are exact.
 */

export interface RunSession {
  abortRun: () => void;
  resumeToolCall: (input: {
    requestContext?: RequestContext;
    resumeData: string;
    toolCallId: string;
  }) => Promise<void>;
  run: { getRunId: () => string | null };
  sendMessage: (input: {
    content: string;
    files?: Pick<PromptAttachment, "data" | "filename" | "mediaType">[];
    requestContext: RequestContext;
    untilIdle?: boolean;
  }) => Promise<void>;
  sendSignal?: Session["sendSignal"];
  subscribe: (listener: (event: AgentControllerEvent) => void) => () => void;
  suspensions: {
    register: (input: {
      runId: string;
      toolCallId: string;
      toolName: string;
    }) => void;
  };
}

export interface RunController {
  createSession: (input: {
    requestContext: RequestContext;
    resourceId: string;
    scope: string;
    threadId: string;
  }) => Promise<RunSession>;
  init: () => Promise<void>;
}

export interface RunRuntime {
  readonly controller: RunController;
  prepareHistory?: (input: RetainedHistoryInput) => Promise<void>;
}

export type RuntimeFactory = () => RunRuntime;

/**
 * The real runtime, composed exactly as the API's chat harness composes it: the
 * sandbox facts the prompt reports, the build workspace as the workspace, and
 * the workspace root as the agent's working directory.
 *
 * One runtime is built per run. The controller session is process-local,
 * non-authoritative state, so a worker that reuses a runtime between runs would
 * carry a previous run's session, thread binding, and cached resources into the
 * next one; building it per run makes recovery from a takeover or a restart
 * simply "drive a fresh session".
 */
export function createCtoRuntimeFactory(input: {
  databaseUrl: string;
  model: string;
  store: ProjectStateStore;
}): RuntimeFactory {
  const storage = new PostgresStore({
    connectionString: input.databaseUrl,
    id: "reasonate-worker-storage",
  });
  return () => {
    const runtime = createReasonateCtoRuntime({
      ...buildSandboxEnvironment,
      enableBrowserVerification: true,
      enableTestRunner: true,
      model: input.model,
      registerPreview: async ({ appPort, ...scope }) => {
        if (await input.store.previews.getByRun(scope.runId)) {
          return;
        }
        const sandboxId = sandboxIdFor(scope);
        await input.store.previews.record({
          buildSessionId: scope.buildSessionId,
          containerName: sandboxId,
          detail: `Selected app port ${appPort}`,
          organizationId: scope.organizationId,
          previewId: PreviewIdSchema.parse(randomUUID()),
          projectId: scope.projectId,
          runId: scope.runId,
          sandboxId,
          status: "starting",
        });
      },
      storage,
      workspace: reasonateBuildWorkspace,
      workspaceRoot: SANDBOX_WORKING_DIRECTORY,
    });
    return {
      controller: runtime.controller,
      prepareHistory: (retained) => seedConversationHistory(storage, retained),
    };
  };
}

export interface RetainedHistoryInput {
  buildSessionId: BuildSessionId;
  resourceId: string;
  runId: RunId;
  scope: TenantScope;
  store: ProjectStateStore;
  threadId: string;
}
export async function seedConversationHistory(
  storage: PostgresStore,
  retained: RetainedHistoryInput
): Promise<void> {
  const memory = await storage.getStore("memory");
  if (!memory) {
    throw new Error("Durable conversation memory is unavailable.");
  }
  const existing = await memory.getThreadById({
    threadId: retained.threadId,
  });
  if (existing?.metadata?.historySeeded === true) {
    return;
  }
  const inputs = await retained.store.history.retainedInputs(
    retained.scope,
    retained.buildSessionId
  );
  const messages = (
    await retained.store.listConversationMessages({
      buildSessionId: retained.buildSessionId,
      scope: retained.scope,
    })
  ).filter((message) => message.runId !== retained.runId);
  for (const event of inputs.events) {
    if (event.run_id === retained.runId) {
      continue;
    }
    const text = retainedEventText(event);
    if (text) {
      messages.push({
        createdAt: event.occurred_at.toISOString(),
        id: `retained:${messages.length}`,
        reasoning: null,
        role: "user",
        runId: RunIdSchema.parse(event.run_id),
        sourceId: null,
        text,
      });
    }
  }
  messages.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  if (
    messages.reduce(
      (bytes, message) =>
        bytes +
        Buffer.byteLength(message.text) +
        (inputs.attachments.get(message.id) ?? []).reduce(
          (size, file) => size + Buffer.byteLength(file.data),
          0
        ),
      0
    ) >
    32 * 1024 * 1024
  ) {
    throw new Error(
      "Retained conversation context exceeds the supported 32 MB memory import limit."
    );
  }
  const now = new Date();
  await memory.saveThread({
    thread: {
      createdAt: existing?.createdAt ?? now,
      id: retained.threadId,
      metadata: { ...existing?.metadata, historySeeded: false },
      resourceId: retained.resourceId,
      title: "Retained conversation",
      updatedAt: now,
    },
  });
  await memory.saveMessages({
    messages: messages
      .filter(
        (message) =>
          message.role !== "tool" &&
          (message.text.length > 0 ||
            (inputs.attachments.get(message.id)?.length ?? 0) > 0)
      )
      .map((message, index) => ({
        content: {
          experimental_attachments: (
            inputs.attachments.get(message.id) ?? []
          ).map((file) => ({
            contentType: file.mediaType,
            name: file.filename,
            url: file.data,
          })),
          format: 2,
          parts: message.text ? [{ text: message.text, type: "text" }] : [],
        },
        createdAt: new Date(message.createdAt),
        id: `${retained.threadId}:retained:${index}`,
        resourceId: retained.resourceId,
        role: message.role === "tool" ? "user" : message.role,
        threadId: retained.threadId,
        type: "text",
      })),
  });
  await memory.updateThread({
    id: retained.threadId,
    metadata: { ...existing?.metadata, historySeeded: true },
  });
}

function retainedEventText(event: {
  type: string;
  payload: Record<string, unknown>;
}): string | undefined {
  const { payload } = event;
  if (
    event.type === "run.steering.requested" &&
    typeof payload.message === "string"
  ) {
    return payload.message;
  }
  if (
    event.type === "approval.resolved" &&
    typeof payload.answer === "string"
  ) {
    return payload.answer;
  }
  if (event.type === "run.plan_decided") {
    return JSON.stringify({
      approved: payload.approved,
      feedback: payload.feedback,
    });
  }
  return undefined;
}
