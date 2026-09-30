import { describe, expect, it } from "vitest";
import {
  isReplayableSequence,
  RunCommandEnvelopeSchema,
  RunEventEnvelopeSchema,
  RunLiveEventSchema,
  runCommandTopic,
  runEventTopic,
  runLiveTopic,
} from "../src/execution-protocol.js";

const ids = {
  buildSessionId: "00000000-0000-4000-8000-000000000001",
  commandId: "00000000-0000-4000-8000-000000000002",
  eventId: "00000000-0000-4000-8000-000000000003",
  organizationId: "00000000-0000-4000-8000-000000000004",
  projectId: "00000000-0000-4000-8000-000000000005",
  runId: "00000000-0000-4000-8000-000000000006",
  workloadGrantId: "00000000-0000-4000-8000-000000000007",
};
const now = "2026-09-19T12:00:00.000Z";

describe("execution protocol contracts", () => {
  it("accepts an authorized command envelope that carries authority by reference", () => {
    const command = RunCommandEnvelopeSchema.parse({
      buildSessionId: ids.buildSessionId,
      commandId: ids.commandId,
      expiresAt: now,
      idempotencyKey: "first-browser-request",
      issuedAt: now,
      organizationId: ids.organizationId,
      payload: { instruction: "build the product" },
      projectId: ids.projectId,
      runId: ids.runId,
      schemaVersion: 1,
      type: "run.start",
      workloadGrantId: ids.workloadGrantId,
    });

    expect(command.type).toBe("run.start");
    expect(command.idempotencyKey).toBe("first-browser-request");
  });

  it("rejects a command that smuggles a caller-supplied identity field", () => {
    expect(() =>
      RunCommandEnvelopeSchema.parse({
        buildSessionId: ids.buildSessionId,
        commandId: ids.commandId,
        cookie: "session=secret",
        expiresAt: now,
        idempotencyKey: "first-browser-request",
        issuedAt: now,
        organizationId: ids.organizationId,
        payload: {},
        projectId: ids.projectId,
        runId: ids.runId,
        schemaVersion: 1,
        type: "run.start",
        workloadGrantId: ids.workloadGrantId,
      })
    ).toThrow();
  });

  it("rejects a command with an unusable idempotency key", () => {
    expect(() =>
      RunCommandEnvelopeSchema.parse({
        buildSessionId: ids.buildSessionId,
        commandId: ids.commandId,
        expiresAt: now,
        idempotencyKey: "short",
        issuedAt: now,
        organizationId: ids.organizationId,
        payload: {},
        projectId: ids.projectId,
        runId: ids.runId,
        schemaVersion: 1,
        type: "run.start",
        workloadGrantId: ids.workloadGrantId,
      })
    ).toThrow();
  });

  it("accepts a sequenced event envelope and rejects negative sequences", () => {
    const event = RunEventEnvelopeSchema.parse({
      eventId: ids.eventId,
      occurredAt: now,
      organizationId: ids.organizationId,
      payload: { sequence: 0 },
      projectId: ids.projectId,
      runId: ids.runId,
      schemaVersion: 1,
      sequence: 0,
      type: "run.queued",
    });

    expect(event.sequence).toBe(0);
    expect(() =>
      RunEventEnvelopeSchema.parse({ ...event, sequence: -1 })
    ).toThrow();
  });

  it("guards the reconnect cursor and namespaces transport topics per run", () => {
    expect(isReplayableSequence(0)).toBe(true);
    expect(isReplayableSequence(42)).toBe(true);
    expect(isReplayableSequence(-1)).toBe(false);
    expect(isReplayableSequence(1.5)).toBe(false);

    expect(runEventTopic(ids.runId)).toBe(
      `reasonateai.run.events.${ids.runId}`
    );
    expect(runCommandTopic).toBe("reasonateai.run.commands");
    expect(runLiveTopic(ids.runId)).toBe(`reasonateai.run.live.${ids.runId}`);
  });

  it("accepts a live delta for each streamed source and rejects a bare one", () => {
    const message = RunLiveEventSchema.parse({
      delta: "Checking the checkout route",
      kind: "message.delta",
      messageId: "msg-1",
      mode: "append",
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      runId: ids.runId,
      schemaVersion: 1,
    });
    expect(message.kind).toBe("message.delta");

    const subagent = RunLiveEventSchema.parse({
      agentType: "scout",
      delta: "app/api/checkout/route.ts",
      kind: "subagent.delta",
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      runId: ids.runId,
      schemaVersion: 1,
      toolCallId: "call-1",
    });
    expect(subagent.kind).toBe("subagent.delta");
  });

  it("rejects a live delta that carries no text to append", () => {
    expect(() =>
      RunLiveEventSchema.parse({
        delta: "",
        kind: "message.delta",
        messageId: "msg-1",
        mode: "append",
        organizationId: ids.organizationId,
        projectId: ids.projectId,
        runId: ids.runId,
        schemaVersion: 1,
      })
    ).toThrow();
  });

  it("rejects a live delta that smuggles an unsequenced position", () => {
    expect(() =>
      RunLiveEventSchema.parse({
        delta: "text",
        kind: "message.delta",
        messageId: "msg-1",
        mode: "append",
        organizationId: ids.organizationId,
        projectId: ids.projectId,
        runId: ids.runId,
        schemaVersion: 1,
        sequence: 7,
      })
    ).toThrow();
  });
});
