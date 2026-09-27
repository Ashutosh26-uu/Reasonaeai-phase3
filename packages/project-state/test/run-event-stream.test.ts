import { randomUUID } from "node:crypto";
import {
  type RunEventEnvelope,
  RunEventEnvelopeSchema,
  runEventTopic,
} from "@reasonateai/contracts/execution-protocol";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
  type RunId,
  RunIdSchema,
} from "@reasonateai/contracts/identity";
import { createClient, type RedisClientType } from "redis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRedisStreamPublisher } from "../src/relay.js";
import { subscribeToRunEvents } from "../src/run-event-stream.js";

const redisUrl = process.env.REDIS_URL;
const describeWithRedis = redisUrl ? describe : describe.skip;

/**
 * Identities of the connections the server currently holds. Every suite in this
 * repository shares one Redis, so a raw count races with whoever else connects
 * or disconnects; comparing identities isolates this subscription's connection.
 */
async function clientIds(client: RedisClientType): Promise<Set<string>> {
  const listing = await client.sendCommand<string>(["CLIENT", "LIST"]);
  return new Set(
    listing
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const [id] = line.split(" ").filter((field) => field.startsWith("id="));
        return id ?? line;
      })
  );
}

describeWithRedis("run event stream", () => {
  const publisher = createRedisStreamPublisher({
    keyPrefix: "reasonateai",
    url: redisUrl as string,
  });
  const reader = createClient({ url: redisUrl as string });

  const organizationId = OrganizationIdSchema.parse(randomUUID());
  const projectId = ProjectIdSchema.parse(randomUUID());
  const buildSessionId = randomUUID();
  const runId = RunIdSchema.parse(randomUUID());
  const scope = { buildSessionId, organizationId, projectId, runId };

  const envelope = (
    sequence: number,
    step: string,
    eventRunId: RunId = runId
  ): RunEventEnvelope =>
    RunEventEnvelopeSchema.parse({
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      organizationId,
      payload: { step },
      projectId,
      runId: eventRunId,
      schemaVersion: 1,
      sequence,
      type: "agent.progress",
    });

  beforeAll(async () => {
    await reader.connect();
  });

  afterAll(async () => {
    await publisher.close();
    await reader.quit();
  });

  it("shares one subscription between two callers and releases it when both abort", async () => {
    const published = envelope(1, "first");
    await publisher.publish(runEventTopic(runId), published);

    const baseline = await clientIds(reader);

    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const first = (
      await subscribeToRunEvents({ ...scope, signal: firstAbort.signal })
    )[Symbol.asyncIterator]();
    const second = (
      await subscribeToRunEvents({ ...scope, signal: secondAbort.signal })
    )[Symbol.asyncIterator]();

    const [firstEvent, secondEvent] = await Promise.all([
      first.next(),
      second.next(),
    ]);

    expect(firstEvent.value?.eventId).toBe(published.eventId);
    expect(secondEvent.value?.eventId).toBe(published.eventId);
    // Two callers, one connection: the second shares the first's subscription,
    // so exactly one connection appeared and it is the one to watch from here.
    const opened = new Set(
      [...(await clientIds(reader))].filter((id) => !baseline.has(id))
    );
    expect(opened.size).toBe(1);

    firstAbort.abort();
    await expect(first.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    // The other caller still needs the subscription, so its connection stays.
    expect([...(await clientIds(reader))].some((id) => opened.has(id))).toBe(
      true
    );

    secondAbort.abort();
    await expect(second.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });

    // The server notices the closed socket asynchronously, so wait for the
    // condition rather than guessing a duration.
    await vi.waitFor(
      async () => {
        expect(
          [...(await clientIds(reader))].some((id) => opened.has(id))
        ).toBe(false);
      },
      { timeout: 5000 }
    );
  });

  it("subscribes again after every consumer has gone, replaying the retained stream", async () => {
    // A run of this test's own: a topic retains every event ever published to
    // it, so sharing the file's run would replay the earlier test's events too.
    const replayRunId = RunIdSchema.parse(randomUUID());
    const first = envelope(1, "first", replayRunId);
    const second = envelope(2, "second", replayRunId);
    await publisher.publish(runEventTopic(replayRunId), first);
    await publisher.publish(runEventTopic(replayRunId), second);

    const abort = new AbortController();
    const iterator = (
      await subscribeToRunEvents({
        ...scope,
        runId: replayRunId,
        signal: abort.signal,
      })
    )[Symbol.asyncIterator]();

    try {
      const delivered = [await iterator.next(), await iterator.next()];
      // Reading from the start of the retained stream is what closes the gap
      // between a caller's ledger replay and its subscription.
      expect(delivered.map(({ value }) => value?.eventId)).toEqual([
        first.eventId,
        second.eventId,
      ]);
    } finally {
      abort.abort();
      await iterator.next();
    }
  });
});
