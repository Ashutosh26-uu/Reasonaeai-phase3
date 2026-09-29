import { randomUUID } from "node:crypto";
import {
  type RunLiveEvent,
  RunLiveEventSchema,
  runLiveTopic,
} from "@reasonateai/contracts/execution-protocol";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
} from "@reasonateai/contracts/identity";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_REDIS_KEY_PREFIX } from "../src/relay.js";
import { subscribeToRunLiveEvents } from "../src/run-live-stream.js";

const redisUrl = process.env.REDIS_URL;
const describeWithRedis = redisUrl ? describe : describe.skip;

/** The refusal a foreign tenant's frame produces, matched wherever it surfaces. */
const FOREIGN_SCOPE = /different tenant scope/;

describeWithRedis("run live stream", () => {
  const client = createClient({ url: redisUrl as string });

  const organizationId = OrganizationIdSchema.parse(randomUUID());
  const projectId = ProjectIdSchema.parse(randomUUID());
  const buildSessionId = randomUUID();
  const runId = RunIdSchema.parse(randomUUID());
  const scope = { buildSessionId, organizationId, projectId, runId };

  /** Writes one frame to the run's live topic, as the worker's publisher does. */
  async function write(payload: unknown): Promise<void> {
    await client.xAdd(
      `${DEFAULT_REDIS_KEY_PREFIX}:${runLiveTopic(runId)}`,
      "*",
      { event: JSON.stringify(payload) }
    );
  }

  const frame = (
    messageId: string,
    delta: string,
    eventRunId: string = runId
  ): RunLiveEvent =>
    RunLiveEventSchema.parse({
      delta,
      kind: "message.delta",
      messageId,
      mode: "append",
      organizationId,
      projectId,
      runId: eventRunId,
      schemaVersion: 1,
    });

  beforeAll(async () => {
    await client.connect();
  });

  afterAll(async () => {
    await client.del(`${DEFAULT_REDIS_KEY_PREFIX}:${runLiveTopic(runId)}`);
    await client.quit();
  });

  it("delivers the text a message has produced as it arrives", async () => {
    const abort = new AbortController();
    const iterator = (
      await subscribeToRunLiveEvents({ ...scope, signal: abort.signal })
    )[Symbol.asyncIterator]();

    try {
      await write(frame("m-1", "Checked "));
      const first = await iterator.next();
      expect(first.value?.delta).toBe("Checked ");

      await write(frame("m-1", "the route."));
      const second = await iterator.next();
      expect(second.value?.delta).toBe("the route.");
      expect(second.value?.kind).toBe("message.delta");
    } finally {
      abort.abort();
      await iterator.next();
    }
  });

  it("fails the subscription rather than deliver another tenant's frame", async () => {
    const abort = new AbortController();
    const iterator = (
      await subscribeToRunLiveEvents({ ...scope, signal: abort.signal })
    )[Symbol.asyncIterator]();

    try {
      await write({
        ...frame("m-2", "text"),
        organizationId: randomUUID(),
      });

      await expect(iterator.next()).rejects.toThrow(FOREIGN_SCOPE);
    } finally {
      abort.abort();
      await iterator.next();
    }
  });
});
