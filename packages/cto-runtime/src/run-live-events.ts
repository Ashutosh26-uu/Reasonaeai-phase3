import type {
  AgentControllerEvent,
  MastraDBMessage,
} from "@mastra/core/agent-controller";
import {
  type MessageSnapshot,
  MessageSnapshotSchema,
  type RunLiveEvent,
  type TranscriptPart,
} from "@reasonateai/contracts/execution-protocol";
import type {
  OrganizationId,
  ProjectId,
  RunId,
} from "@reasonateai/contracts/identity";

export interface RunLiveScope {
  organizationId: OrganizationId;
  projectId: ProjectId;
  runId: RunId;
}

function closeParts(
  parts: TranscriptPart[],
  finished: boolean,
  count: number,
  stamp: string
): void {
  for (const part of parts) {
    if (part.type !== "tool" && (finished || part.index < count - 1)) {
      part.endedAt ??= stamp;
    }
  }
}

/** Copy display data now: the controller mutates the source message in place. */
export function snapshotMessage(
  message: MastraDBMessage,
  at: Date,
  previous?: MessageSnapshot,
  finished = false
): MessageSnapshot {
  const stamp = at.toISOString();
  const parts: TranscriptPart[] = [];
  for (const [index, part] of message.content.parts.entries()) {
    if (part.type === "tool-invocation") {
      parts.push({
        index,
        toolCallId: part.toolInvocation.toolCallId,
        type: "tool",
      });
      continue;
    }
    if (part.type !== "text" && part.type !== "reasoning") {
      continue;
    }
    const text = part.type === "text" ? part.text : part.reasoning;
    if (!text) {
      continue;
    }
    const old = previous?.parts.find(
      (item) => item.index === index && item.type === part.type
    );
    parts.push({
      endedAt: old && old.type !== "tool" ? old.endedAt : null,
      index,
      startedAt: old && old.type !== "tool" ? old.startedAt : stamp,
      text,
      type: part.type,
    });
  }
  closeParts(parts, finished, message.content.parts.length, stamp);
  return MessageSnapshotSchema.parse({
    finished,
    messageId: message.id,
    parts,
    revision: (previous?.revision ?? 0) + 1,
    startedAt: previous?.startedAt ?? stamp,
    version: 1,
  });
}

/** Full, bounded snapshots self-heal lost live frames; the publisher coalesces them. */
export class RunLiveEventMapper {
  readonly #scope: RunLiveScope;
  readonly #messages = new Map<string, MessageSnapshot>();
  constructor(input: { scope: RunLiveScope }) {
    this.#scope = input.scope;
  }

  map(event: AgentControllerEvent, at = new Date()): RunLiveEvent | undefined {
    if (event.type === "subagent_text_delta") {
      return event.textDelta
        ? {
            ...this.#scope,
            agentType: event.agentType,
            delta: event.textDelta,
            kind: "subagent.delta",
            schemaVersion: 1,
            toolCallId: event.toolCallId,
          }
        : undefined;
    }
    if (
      event.type !== "message_start" &&
      event.type !== "message_update" &&
      event.type !== "message_end"
    ) {
      return;
    }
    if (event.message.role !== "assistant") {
      return;
    }
    const previous = this.#messages.get(event.message.id);
    const snapshot = snapshotMessage(
      event.message,
      at,
      previous,
      event.type === "message_end"
    );
    if (snapshot.parts.length === 0) {
      return;
    }
    if (
      previous?.finished === snapshot.finished &&
      JSON.stringify(previous.parts) === JSON.stringify(snapshot.parts)
    ) {
      return;
    }
    this.#messages.set(snapshot.messageId, snapshot);
    return {
      ...this.#scope,
      kind: "message.snapshot",
      schemaVersion: 1,
      snapshot,
    };
  }

  /** Seal partial content even if the controller never emits message_end. */
  finish(at = new Date()): RunLiveEvent[] {
    const frames: RunLiveEvent[] = [];
    for (const previous of this.#messages.values()) {
      if (previous.finished) {
        continue;
      }
      const snapshot: MessageSnapshot = {
        ...previous,
        finished: true,
        parts: previous.parts.map((part) =>
          part.type === "tool"
            ? part
            : { ...part, endedAt: part.endedAt ?? at.toISOString() }
        ),
        revision: previous.revision + 1,
      };
      this.#messages.set(snapshot.messageId, snapshot);
      frames.push({
        ...this.#scope,
        kind: "message.snapshot",
        schemaVersion: 1,
        snapshot,
      });
    }
    return frames;
  }
}
