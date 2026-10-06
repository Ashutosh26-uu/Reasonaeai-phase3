import { randomUUID } from "node:crypto";
import { PostgresStore } from "@mastra/pg";
import type { RunId } from "@reasonateai/contracts/identity";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedConversationHistory } from "../src/runtime.js";
import {
  allocateRunFixture,
  createHarness,
  type Harness,
} from "./support/harness.js";

const connectionString = process.env.DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
suite("retained conversation memory", { timeout: 60_000 }, () => {
  let harness: Harness;
  let storage: PostgresStore;
  const threads: string[] = [];
  beforeAll(async () => {
    harness = await createHarness({
      connectionString: connectionString as string,
    });
    storage = new PostgresStore({
      connectionString: connectionString as string,
      id: randomUUID(),
    });
    await storage.init();
  });
  afterAll(async () => {
    const memory = await storage.getStore("memory");
    await Promise.all(
      threads.map((threadId) => memory?.deleteThread({ threadId }))
    );
    await storage.close();
    await harness.cleanup();
    await harness.dispose();
  });
  it("keeps an attachment-only request in retained memory", async () => {
    const sketch = {
      data: "data:image/png;base64,aGVsbG8=",
      filename: "sketch.png",
      mediaType: "image/png",
    };
    const fixture = await allocateRunFixture(harness, "", [sketch]);
    await harness.store.setRunStatus({
      runId: fixture.candidate.runId,
      scope: fixture.scope,
      status: "completed",
    });
    const current = await harness.store.appendConversationTurn({
      buildSessionId: fixture.buildSessionId,
      idempotencyKey: randomUUID(),
      message: "Continue the idea",
      scope: fixture.scope,
    });
    const retained = {
      buildSessionId: fixture.buildSessionId,
      resourceId: randomUUID(),
      runId: current.runId,
      scope: fixture.scope,
      store: harness.store,
      threadId: randomUUID(),
    };
    threads.push(retained.threadId);
    await seedConversationHistory(storage, retained);
    const memory = await storage.getStore("memory");
    if (!memory) {
      throw new Error("No durable memory");
    }
    const result = await memory.listMessages({
      perPage: 100,
      resourceId: retained.resourceId,
      threadId: retained.threadId,
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      content: {
        experimental_attachments: [
          {
            contentType: sketch.mediaType,
            name: sketch.filename,
            url: sketch.data,
          },
        ],
        parts: [],
      },
      role: "user",
    });
  });
  it("imports only the retained prefix, delivered steering, saved question answers and original images, idempotently", async () => {
    const image = {
      data: "data:image/png;base64,aGVsbG8=",
      filename: "idea.png",
      mediaType: "image/png",
    };
    const fixture = await allocateRunFixture(harness, "Request 1", [image]);
    const { scope, buildSessionId } = fixture;
    const runs: RunId[] = [fixture.candidate.runId];
    await Array.from({ length: 10 }, (_, i) => i).reduce(
      async (previous, index) => {
        await previous;
        const runId =
          index === 0
            ? fixture.candidate.runId
            : (
                await harness.store.appendConversationTurn({
                  buildSessionId,
                  idempotencyKey: randomUUID(),
                  message: `Request ${index + 1}`,
                  scope,
                })
              ).runId;
        if (index > 0) {
          runs.push(runId);
        }
        await harness.store.appendRunEvent({
          payload: {
            kind: "message_end",
            messageId: randomUUID(),
            role: "assistant",
            text: `Answer ${index + 1}`,
          },
          runId,
          scope,
          type: "agent.progress",
        });
        await harness.store.setRunStatus({ runId, scope, status: "completed" });
      },
      Promise.resolve()
    );
    const [first] = runs;
    if (!first) {
      throw new Error("Missing first run");
    }
    await harness.store.appendRunEvent({
      payload: { message: "Keep navigation simple", steeringId: "delivered" },
      runId: first,
      scope,
      type: "run.steering.requested",
    });
    await harness.store.appendRunEvent({
      payload: { steeringId: "delivered" },
      runId: first,
      scope,
      type: "run.steering.delivered",
    });
    await harness.store.appendRunEvent({
      payload: { message: "Never delivered", steeringId: "undelivered" },
      runId: first,
      scope,
      type: "run.steering.requested",
    });
    await harness.store.appendRunEvent({
      payload: {
        answer: "Use purple",
        kind: "answer_submitted",
        toolCallId: "question",
      },
      runId: first,
      scope,
      type: "approval.resolved",
    });
    await harness.pool.query(
      "delete from conversation_history where build_session_id=$1 and position>=6",
      [buildSessionId]
    );
    const retained = {
      buildSessionId,
      resourceId: randomUUID(),
      runId: runs[5] as RunId,
      scope,
      store: harness.store,
      threadId: randomUUID(),
    };
    threads.push(retained.threadId);
    await seedConversationHistory(storage, retained);
    await seedConversationHistory(storage, retained);
    const memory = await storage.getStore("memory");
    if (!memory) {
      throw new Error("No durable memory");
    }
    const result = await memory.listMessages({
      perPage: 100,
      resourceId: retained.resourceId,
      threadId: retained.threadId,
    });
    const text = JSON.stringify(result.messages);
    expect(result.messages).toHaveLength(12);
    expect(text).toContain("Request 5");
    expect(text).not.toContain("Request 6");
    expect(text).not.toContain("Answer 10");
    expect(text).toContain("Keep navigation simple");
    expect(text).toContain("Use purple");
    expect(text).not.toContain("Never delivered");
    expect(text.split(image.data)).toHaveLength(2);
    expect(
      (
        await memory.listMessages({
          perPage: 100,
          resourceId: randomUUID(),
          threadId: retained.threadId,
        })
      ).messages
    ).toHaveLength(0);
  });
});
