import {
  MessageSnapshotSchema,
  type RunEventEnvelope,
  type TranscriptPart,
} from "@reasonateai/contracts/execution-protocol";
import { z } from "zod";

const StoredPartsSchema = z.object({
  parts: z.array(z.object({ type: z.string() }).passthrough()).max(4096),
});
const TextSchema = z.object({ text: z.string() });
const ReasoningSchema = z.object({ reasoning: z.string() });
const ToolSchema = z.object({
  toolInvocation: z.object({ toolCallId: z.string() }),
});

/** Recover only exact source parts whose text and tool ownership still agree. */
export function recoverTranscript(
  source: RunEventEnvelope,
  content: unknown,
  toolIds: ReadonlySet<string>
) {
  if (
    source.payload.kind !== "message_end" ||
    source.payload.role !== "assistant"
  ) {
    throw new Error("Recovery requires a legacy assistant message event");
  }
  const parts: TranscriptPart[] = [];
  for (const [index, part] of StoredPartsSchema.parse(
    content
  ).parts.entries()) {
    if (part.type === "tool-invocation") {
      const { toolCallId } = ToolSchema.parse(part).toolInvocation;
      if (!toolIds.has(toolCallId)) {
        throw new Error(
          "Stored tool reference does not belong to the source run"
        );
      }
      parts.push({ index, toolCallId, type: "tool" });
    } else if (part.type === "text" || part.type === "reasoning") {
      const text =
        part.type === "text"
          ? TextSchema.parse(part).text
          : ReasoningSchema.parse(part).reasoning;
      if (text) {
        // Legacy data has no per-span timing. The recovery marker prevents the
        // UI from presenting these bookkeeping timestamps as measured duration.
        parts.push({
          endedAt: source.occurredAt,
          index,
          startedAt: source.occurredAt,
          text,
          type: part.type,
        });
      }
    }
  }
  const text = parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
  if (text !== source.payload.text) {
    throw new Error(
      "Stored text does not match the legacy event; recovery refused"
    );
  }
  return MessageSnapshotSchema.parse({
    finished: true,
    messageId: source.payload.messageId,
    parts,
    recovery: {
      source: "mastra.parts.v1",
      sourceEventId: source.eventId,
      sourceSequence: source.sequence,
    },
    revision: 1,
    startedAt: source.occurredAt,
    version: 1,
  });
}
