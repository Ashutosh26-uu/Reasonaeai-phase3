import { randomUUID } from "node:crypto";
import type { AgentControllerEvent } from "@mastra/core/agent-controller";
import type { BuildSessionId } from "@reasonateai/contracts/execution";
import {
  type RunEventEnvelope,
  RunEventEnvelopeSchema,
  type RunEventType,
} from "@reasonateai/contracts/execution-protocol";
import type {
  OrganizationId,
  ProjectId,
  RunId,
} from "@reasonateai/contracts/identity";

/**
 * The tenant and build-session scope one run belongs to. Every mapped envelope
 * is stamped with it, so an event can never describe a run in a scope the
 * caller was not authorized for.
 */
export interface RunEventScope {
  buildSessionId: BuildSessionId;
  organizationId: OrganizationId;
  projectId: ProjectId;
}

export interface RunEventMappingInput {
  event: AgentControllerEvent;
  /** When the controller produced the event, not when this was called. */
  occurredAt: Date;
  runId: RunId;
  scope: RunEventScope;
}

/**
 * The ledger position this mapper deliberately does not own.
 *
 * `sequence` is monotonic per run and is minted by the store in the same
 * transaction that appends the ledger row, so a source that has not committed
 * yet has no position to report. Zero is the contract's own cursor meaning
 * "nothing delivered yet", and it is what the mapper reports; the store
 * replaces it with the committed sequence.
 */
export const UNASSIGNED_SEQUENCE = 0;

type MessageEndEvent = Extract<AgentControllerEvent, { type: "message_end" }>;
type MessagePart = MessageEndEvent["message"]["content"]["parts"][number];

/** The text an assistant or user message carries, concatenated in order. */
function textOf(parts: readonly MessagePart[]): string {
  let text = "";
  for (const part of parts) {
    if (part.type === "text") {
      text += part.text;
    }
  }
  return text;
}

/**
 * Reads a message off a failure without dumping its stack. The controller's
 * union types this as an `Error`, but an event that crossed a serialization
 * boundary can carry an error-shaped object or anything else, and a ledger
 * entry must never be lost to a value the mapper cannot format.
 */
function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error === null || typeof error !== "object" || !("message" in error)) {
    return String(error);
  }
  const { message } = error;
  return typeof message === "string" ? message : String(message);
}

/**
 * Drops the keys a source event left undefined, so the durable payload is the
 * set of fields that actually carried a value rather than a shape full of
 * absent ones.
 */
function defined(payload: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined) {
      kept[key] = value;
    }
  }
  return kept;
}

/**
 * The durable content one controller event contributes, or undefined when the
 * event is part of the live view only.
 *
 * `kind` is the controller event's own type, so a replaying browser can branch
 * on the exact event that produced the entry without guessing from the payload.
 */
function draftOf(
  event: AgentControllerEvent
): { payload: Record<string, unknown>; type: RunEventType } | undefined {
  switch (event.type) {
    // Agent boundaries: the main agent and every delegated subagent is a
    // start/end pair, which is what a replay draws as the run's step tree.
    case "agent_start": {
      return { payload: { kind: event.type }, type: "agent.started" };
    }
    case "agent_end": {
      const reason = event.reason ?? "complete";
      const payload = { kind: event.type, reason };
      if (reason === "complete") {
        return { payload, type: "run.completed" };
      }
      if (reason === "error") {
        return { payload, type: "run.failed" };
      }
      if (reason === "aborted") {
        return { payload, type: "run.cancelled" };
      }
      // A suspended agent has parked, not finished: the run has not reached a
      // terminal state, so this is progress rather than an outcome.
      return { payload, type: "agent.progress" };
    }

    // The assistant's and the user's own text. Only the end of a message is
    // durable: the start and every update carry the same live message object
    // while it streams, and a ledger entry per delta would record one message
    // many times. A message with no text has nothing to record.
    case "message_end": {
      const text = textOf(event.message.content.parts);
      if (text.length === 0) {
        return;
      }
      return {
        payload: {
          kind: event.type,
          messageId: event.message.id,
          role: event.message.role,
          text,
        },
        type: "agent.progress",
      };
    }

    // Tool calls and their outcomes. The complete arguments arrive on
    // `tool_start`; the input deltas that streamed before it are the same
    // arguments in pieces.
    case "tool_start": {
      return {
        payload: {
          args: event.args,
          kind: event.type,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        },
        type: "agent.progress",
      };
    }
    case "tool_end": {
      return {
        payload: {
          denied: event.denied === true,
          isError: event.isError,
          kind: event.type,
          result: event.result,
          toolCallId: event.toolCallId,
        },
        type: "agent.progress",
      };
    }
    case "command_exit": {
      return {
        payload: {
          exitCode: event.exitCode,
          kind: event.type,
          success: event.success,
          toolCallId: event.toolCallId,
        },
        type: "agent.progress",
      };
    }

    // An approval gate and a suspension both park the run until something
    // outside it decides, which the browser must see to offer that decision.
    case "tool_approval_required": {
      return {
        payload: {
          args: event.args,
          kind: event.type,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        },
        type: "approval.requested",
      };
    }
    case "tool_suspended": {
      return {
        payload: {
          args: event.args,
          kind: event.type,
          resumeSchema: event.resumeSchema,
          suspendPayload: event.suspendPayload,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        },
        type: "approval.requested",
      };
    }
    case "tool_suspension_cancelled": {
      return {
        payload: {
          kind: event.type,
          reason: event.reason,
          resolution: "cancelled",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        },
        type: "approval.resolved",
      };
    }

    // Subagent lifecycle. A subagent's start is an agent starting, and its own
    // tool calls and result are the work it was delegated.
    case "subagent_start": {
      return {
        payload: {
          agentType: event.agentType,
          forked: event.forked === true,
          kind: event.type,
          modelId: event.modelId,
          task: event.task,
          toolCallId: event.toolCallId,
        },
        type: "agent.started",
      };
    }
    case "subagent_tool_start": {
      return {
        payload: {
          agentType: event.agentType,
          kind: event.type,
          subToolArgs: event.subToolArgs,
          subToolName: event.subToolName,
          toolCallId: event.toolCallId,
        },
        type: "agent.progress",
      };
    }
    case "subagent_tool_end": {
      return {
        payload: {
          agentType: event.agentType,
          isError: event.isError,
          kind: event.type,
          subToolName: event.subToolName,
          subToolResult: event.subToolResult,
          toolCallId: event.toolCallId,
        },
        type: "agent.progress",
      };
    }
    case "subagent_end": {
      return {
        payload: {
          agentType: event.agentType,
          durationMs: event.durationMs,
          isError: event.isError,
          kind: event.type,
          result: event.result,
          toolCallId: event.toolCallId,
        },
        type: "agent.progress",
      };
    }

    case "task_updated": {
      return {
        payload: { kind: event.type, tasks: event.tasks },
        type: "task.updated",
      };
    }

    // A retryable failure is one the controller is recovering from, so it is
    // progress rather than the run's outcome; only a failure it will not retry
    // ends the run.
    case "error": {
      const failure = {
        errorType: event.errorType,
        kind: event.type,
        message: messageOf(event.error),
      };
      if (event.retryable === true) {
        return {
          payload: {
            ...failure,
            maxRetries: event.maxRetries,
            retryAttempt: event.retryAttempt,
            retryable: true,
            retryDelay: event.retryDelay,
          },
          type: "agent.progress",
        };
      }
      return { payload: failure, type: "run.failed" };
    }
    case "info": {
      return {
        payload: { kind: event.type, message: event.message },
        type: "agent.progress",
      };
    }

    // Everything else is the live view: streaming fragments of a message or a
    // tool's arguments that a later event completes, model, mode, thread, and
    // display state, token usage, workspace and context-window bookkeeping, and
    // the goal evaluation that informs the next step. None of it is work the
    // run did, so nothing is invented to hold it.
    default: {
      return;
    }
  }
}

/**
 * Maps one controller event to the durable ledger entry for it.
 *
 * The run identity comes from the input scope and never from the event, the
 * timestamp is the caller's, and the result is validated against
 * `RunEventEnvelopeSchema` before it is returned. `undefined` means the event
 * carries no durable meaning for the run's ledger. The sequence is not the
 * mapper's to assign: it reports the contract's unassigned cursor and the store
 * mints the committed sequence.
 */
export function toRunEventEnvelope(
  input: RunEventMappingInput
): RunEventEnvelope | undefined {
  const draft = draftOf(input.event);
  if (!draft) {
    return;
  }

  return RunEventEnvelopeSchema.parse({
    eventId: randomUUID(),
    occurredAt: input.occurredAt.toISOString(),
    organizationId: input.scope.organizationId,
    payload: defined({
      buildSessionId: input.scope.buildSessionId,
      ...draft.payload,
    }),
    projectId: input.scope.projectId,
    runId: input.runId,
    schemaVersion: 1,
    sequence: UNASSIGNED_SEQUENCE,
    type: draft.type,
  });
}
