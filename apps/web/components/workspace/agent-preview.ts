import {
  type OpenAppPreviewResult,
  OpenAppPreviewResultSchema,
} from "@reasonateai/contracts/execution";
import { turnCheckpoint } from "@/components/chat/checkpoint-state";
import { projectTranscript, type Timeline } from "@/components/chat/timeline";

export type AgentPreviewSelection = OpenAppPreviewResult & { sequence: number };

function retainPreviewSelection(
  selection: AgentPreviewSelection | undefined,
  timeline: Timeline,
  latestRunId: string | undefined
) {
  if (!selection || selection.runId === latestRunId) {
    return selection;
  }
  const checkpoint = turnCheckpoint(
    Object.values(timeline.runs[selection.runId]?.events ?? {})
  );
  return checkpoint?.checkpoint?.status === "available" ? selection : undefined;
}

/** Only a matched, successful CTO tool result can request the preview UI. */
export function agentPreviewSelection(
  timeline: Timeline,
  buildSessionId: string
): AgentPreviewSelection | undefined {
  let selection: AgentPreviewSelection | undefined;
  const turns = projectTranscript(timeline, []);
  for (const turn of turns) {
    const calls = new Set<string>();
    const events = Object.values(timeline.runs[turn.id]?.events ?? {}).sort(
      (a, b) => a.sequence - b.sequence
    );
    for (const event of events) {
      const { payload } = event;
      if (typeof payload.toolCallId !== "string") {
        continue;
      }
      if (
        payload.kind === "tool_start" &&
        payload.toolName === "open_preview"
      ) {
        calls.add(payload.toolCallId);
      }
      if (
        payload.kind !== "tool_end" ||
        !calls.delete(payload.toolCallId) ||
        payload.isError === true ||
        payload.denied === true
      ) {
        continue;
      }
      const result = OpenAppPreviewResultSchema.safeParse(payload.result);
      if (
        result.success &&
        result.data.buildSessionId === buildSessionId &&
        result.data.runId === event.runId
      ) {
        selection = { ...result.data, sequence: event.sequence };
      }
    }
  }
  return retainPreviewSelection(selection, timeline, turns.at(-1)?.id);
}
