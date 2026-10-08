import type { RunEventEnvelope } from "@reasonateai/contracts/execution-protocol";
import type { TranscriptEntry } from "./timeline";

export type ActivityEntry =
  | Extract<TranscriptEntry, { kind: "tool" }>
  | (Extract<TranscriptEntry, { kind: "text" | "reasoning" }> & {
      kind: "reasoning";
    });

export function isActivityEntry(
  entry: TranscriptEntry
): entry is ActivityEntry {
  return entry.kind === "tool" || entry.kind === "reasoning";
}

/** Controller agent ends precede the worker's durable turn outcome. */
export function isTurnEnd(event: RunEventEnvelope): boolean {
  return (
    event.payload.kind !== "agent_end" &&
    event.payload.kind !== "error" &&
    ["run.completed", "run.failed", "run.cancelled"].includes(event.type)
  );
}

function workedDuration(events: RunEventEnvelope[], end: RunEventEnvelope) {
  const start =
    events.find((event) => event.type === "run.claimed") ?? events[0];
  if (!start) {
    return "Worked";
  }
  const elapsed = Date.parse(end.occurredAt) - Date.parse(start.occurredAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) {
    return "Worked";
  }
  const seconds = Math.floor(elapsed / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  let duration = `${seconds}s`;
  if (hours > 0) {
    duration = `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    duration = `${minutes}m ${seconds % 60}s`;
  }
  return `Worked for ${duration}`;
}

export function turnPresentation(
  entries: TranscriptEntry[],
  runEvents: RunEventEnvelope[]
) {
  const events = [...runEvents].sort((a, b) => a.sequence - b.sequence);
  const end = events.findLast(isTurnEnd);
  const assistantEntries = entries.filter((entry) => entry.kind !== "steering");
  const last = assistantEntries.findLast(
    (entry) =>
      entry.kind === "tool" ||
      entry.kind === "plan" ||
      entry.text.trim().length > 0
  );
  // Text before a subsequent tool/reasoning entry is progress, not an answer.
  const answerParts = end && last?.kind === "text" ? [last] : [];
  if (end && last?.kind === "text" && last.sourceMessageId) {
    for (
      let index = assistantEntries.indexOf(last) - 1;
      index >= 0;
      index -= 1
    ) {
      const previous = assistantEntries[index];
      if (
        previous?.kind !== "text" ||
        previous.sourceMessageId !== last.sourceMessageId
      ) {
        break;
      }
      answerParts.unshift(previous);
    }
  }
  const answer =
    end && last?.kind === "text"
      ? { ...last, text: answerParts.map((part) => part.text).join("") }
      : undefined;
  const answerIds = new Set(answerParts.map((part) => part.id));
  const history = end
    ? assistantEntries.filter((entry) => !answerIds.has(entry.id))
    : [];
  return {
    answer,
    end,
    history,
    label: end ? workedDuration(events, end) : undefined,
    visible: end
      ? entries.flatMap<TranscriptEntry>((entry) => {
          if (entry.id === answer?.id) {
            return [answer];
          }
          return entry.kind === "steering" ? [entry] : [];
        })
      : entries,
  };
}
