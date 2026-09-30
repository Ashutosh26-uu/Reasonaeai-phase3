import {
  type RunEventEnvelope,
  RunEventEnvelopeSchema,
  runEventTopic,
} from "@reasonateai/contracts/execution-protocol";
import { subscribeToRedisTopic } from "./redis-topic-stream.js";

export interface RunEventStreamInput {
  buildSessionId: string;
  organizationId: string;
  projectId: string;
  runId: string;
  signal?: AbortSignal;
}

/**
 * Reads one durable event off a run's topic, or reports why it cannot be
 * delivered.
 *
 * The topic names one run, and an event carries the tenant it belongs to, so a
 * mismatch means the transport carried an event for a different tenant. Failing
 * the subscription is the only safe answer: delivering it would hand one
 * organization another's events.
 */
function readRunEvent(
  raw: string | undefined,
  scope: RunEventStreamInput
): RunEventEnvelope | Error {
  let payload: unknown;
  try {
    payload =
      typeof raw === "string" ? (JSON.parse(raw) as unknown) : undefined;
  } catch {
    payload = undefined;
  }

  const parsed = RunEventEnvelopeSchema.safeParse(payload);
  if (!parsed.success) {
    return new Error(
      "A run event on the transport did not match the run-event contract."
    );
  }

  const event = parsed.data;
  if (
    event.organizationId !== scope.organizationId ||
    event.projectId !== scope.projectId ||
    event.runId !== scope.runId
  ) {
    return new Error(
      "A run event arrived for a different tenant scope than the subscription."
    );
  }

  return event;
}

/**
 * Follows a run's durable events.
 *
 * The ledger remains the authority for what a run did; this is how a client
 * learns about a committed event without polling for it. Sequence numbers are
 * the caller's business — a browser deduplicates by them and a reconnect
 * resumes from its last one — so this stream hands over every retained entry it
 * reads.
 */
export function subscribeToRunEvents(
  input: RunEventStreamInput
): Promise<AsyncIterable<RunEventEnvelope>> {
  return subscribeToRedisTopic({
    parse: (raw) => readRunEvent(raw, input),
    registryKey: [
      input.organizationId,
      input.projectId,
      input.buildSessionId,
      input.runId,
    ].join("|"),
    signal: input.signal,
    topicName: runEventTopic(input.runId),
  });
}
