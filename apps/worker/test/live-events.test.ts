import { randomUUID } from "node:crypto";
import type { RunLiveEvent } from "@reasonateai/contracts/execution-protocol";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
  type RunId,
  RunIdSchema,
} from "@reasonateai/contracts/identity";
import { subscribeToRunLiveEvents } from "@reasonateai/project-state/run-live-stream";
import { afterAll, describe, expect, it } from "vitest";
import { createRedisLiveEventPublisher } from "../src/live-events.js";

const redisUrl = process.env.REDIS_URL;
const describeWithRedis = redisUrl ? describe : describe.skip;

describeWithRedis("live event publisher", () => {
  const organizationId = OrganizationIdSchema.parse(randomUUID());
  const projectId = ProjectIdSchema.parse(randomUUID());
  const publishers: { close: () => Promise<void> }[] = [];

  afterAll(async () => {
    await Promise.all(publishers.splice(0).map((item) => item.close()));
  });

  function publisher() {
    const created = createRedisLiveEventPublisher({
      url: redisUrl as string,
    });
    publishers.push(created);
    return created;
  }

  const frame = (
    runId: RunId,
    delta: string,
    mode: "append" | "replace" = "append"
  ): RunLiveEvent => ({
    delta,
    kind: "message.delta",
    messageId: "m-1",
    mode,
    organizationId,
    projectId,
    runId,
    schemaVersion: 1,
  });

  /**
   * Reads the next frame through the same subscription a browser's SSE route
   * uses: the publisher and the reader are only correct as a pair.
   *
   * One frame is enough to see the merging. The topic retains every entry that
   * was written, so a burst that failed to merge would deliver its first delta
   * here.
   */
  async function readFrame(
    runId: RunId
  ): Promise<{ delta?: unknown; mode?: unknown }> {
    const abort = new AbortController();
    const iterator = (
      await subscribeToRunLiveEvents({
        buildSessionId: randomUUID(),
        organizationId,
        projectId,
        runId,
        signal: abort.signal,
      })
    )[Symbol.asyncIterator]();

    try {
      const next = await iterator.next();
      if (next.done) {
        throw new Error("The run's live topic carried nothing.");
      }
      return next.value as unknown as Record<string, unknown>;
    } finally {
      abort.abort();
      await iterator.next();
    }
  }

  it("merges the deltas queued between two transport writes into one frame", async () => {
    const runId = RunIdSchema.parse(randomUUID());
    const subject = publisher();

    // One synchronous burst, as a model's tokens arriving between two writes.
    subject.publish(frame(runId, "Reading "));
    subject.publish(frame(runId, "the "));
    subject.publish(frame(runId, "router."));
    await subject.close();

    const delivered = await readFrame(runId);

    expect(delivered.delta).toBe("Reading the router.");
    expect(delivered.mode).toBe("append");
  });

  it("sends a rewritten message in full instead of merging it onto the old text", async () => {
    const runId = RunIdSchema.parse(randomUUID());
    const subject = publisher();

    subject.publish(frame(runId, "I will check the router."));
    subject.publish(frame(runId, "Let me check the ledger.", "replace"));
    await subject.close();

    const delivered = await readFrame(runId);

    expect(delivered.delta).toBe("Let me check the ledger.");
    expect(delivered.mode).toBe("replace");
  });
});
