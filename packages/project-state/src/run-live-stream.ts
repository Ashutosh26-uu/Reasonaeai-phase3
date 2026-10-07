import {
  type RunLiveEvent,
  RunLiveEventSchema,
  runLiveTopic,
} from "@reasonateai/contracts/execution-protocol";
import { subscribeToRedisTopic } from "./redis-topic-stream.js";

export interface RunLiveStreamInput {
  /** Verified owning session of the run, which may differ from a history branch. */
  buildSessionId: string;
  organizationId: string;
  projectId: string;
  runId: string;
  signal?: AbortSignal;
}

/**
 * Reads one live frame off a run's topic, or reports why it cannot be
 * delivered.
 *
 * A live frame carries its tenant for the same reason a durable event does: the
 * topic names one run, so a frame from another tenant is a transport fault, and
 * a partial message is the last thing that should be handed to the wrong
 * organization.
 */
export function readRunLiveEvent(
  raw: string | undefined,
  scope: RunLiveStreamInput
): RunLiveEvent | Error {
  let payload: unknown;
  try {
    payload =
      typeof raw === "string" ? (JSON.parse(raw) as unknown) : undefined;
  } catch {
    payload = undefined;
  }

  // Older workers spread their wider execution scope into these transient
  // frames. Retained entries live for one hour and must survive a rolling
  // upgrade. Remove only this known field after checking the run's owning session;
  // the remaining frame still passes the strict schema and tenant/run checks.
  if (
    typeof payload === "object" &&
    payload !== null &&
    "buildSessionId" in payload
  ) {
    if (payload.buildSessionId !== scope.buildSessionId) {
      return new Error(
        "A live run frame arrived for a different build session than the subscription."
      );
    }
    const { buildSessionId: _buildSessionId, ...frame } = payload;
    payload = frame;
  }

  const parsed = RunLiveEventSchema.safeParse(payload);
  if (!parsed.success) {
    return new Error(
      "A live run frame on the transport did not match the live-event contract."
    );
  }

  const event = parsed.data;
  if (
    event.organizationId !== scope.organizationId ||
    event.projectId !== scope.projectId ||
    event.runId !== scope.runId
  ) {
    return new Error(
      "A live run frame arrived for a different tenant scope than the subscription."
    );
  }

  return event;
}

/**
 * Follows a run's live deltas.
 *
 * The topic is bounded and expires with the run, and a delta carries no
 * position, so this stream is at-most-once by design: a reader that joins late
 * receives the text retained so far and a reader that misses a frame receives
 * the completed message from the durable ledger instead. Nothing about a run's
 * correctness depends on this stream.
 */
export function subscribeToRunLiveEvents(
  input: RunLiveStreamInput
): Promise<AsyncIterable<RunLiveEvent>> {
  return subscribeToRedisTopic({
    parse: (raw) => readRunLiveEvent(raw, input),
    registryKey: [
      "live",
      input.organizationId,
      input.projectId,
      input.buildSessionId,
      input.runId,
    ].join("|"),
    signal: input.signal,
    topicName: runLiveTopic(input.runId),
  });
}
