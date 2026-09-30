import {
  type RunEventEnvelope,
  RunEventIdSchema,
} from "@reasonateai/contracts/execution-protocol";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
} from "@reasonateai/contracts/identity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RunEventStream,
  type StreamConnectionState,
} from "../lib/run-event-stream";

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  withCredentials?: boolean | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  constructor(url: string, init?: { withCredentials?: boolean | undefined }) {
    this.url = url;
    this.withCredentials = init?.withCredentials;
    MockEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  // Helper for test simulation
  triggerOpen(): void {
    if (this.onopen) {
      this.onopen();
    }
  }

  triggerMessage(data: unknown): void {
    if (this.onmessage) {
      this.onmessage(
        new MessageEvent("message", { data: JSON.stringify(data) })
      );
    }
  }

  triggerError(): void {
    if (this.onerror) {
      this.onerror(new Event("error"));
    }
  }
}

describe("RunEventStream", () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const mockOrgId = OrganizationIdSchema.parse(
    "00000000-0000-4000-8000-000000000001"
  );
  const mockProjId = ProjectIdSchema.parse(
    "00000000-0000-4000-8000-000000000002"
  );
  const mockSessionId = "00000000-0000-4000-8000-000000000003";

  it("connects with correct URL and handles messages with monotonic sequence", () => {
    const receivedEvents: RunEventEnvelope[] = [];
    const stateChanges: StreamConnectionState[] = [];

    const stream = new RunEventStream({
      baseUrl: "https://api.reasonate.internal",
      buildSessionId: mockSessionId,
      eventSourceConstructor: MockEventSource as unknown as typeof EventSource,
      onConnectionStateChange: (s) => stateChanges.push(s),
      onEvent: (e) => receivedEvents.push(e),
      organizationId: mockOrgId,
      projectId: mockProjId,
    });

    stream.connect();

    expect(MockEventSource.instances).toHaveLength(1);
    const [mockES] = MockEventSource.instances;
    expect(mockES).toBeDefined();
    if (!mockES) {
      return;
    }

    expect(mockES.url).toBe(
      `https://api.reasonate.internal/v1/build-sessions/${mockSessionId}/events?organizationId=${mockOrgId}&projectId=${mockProjId}`
    );
    expect(mockES.withCredentials).toBe(true);
    expect(stream.getState()).toBe("connecting");

    mockES.triggerOpen();
    expect(stream.getState()).toBe("connected");

    const event1: RunEventEnvelope = {
      eventId: RunEventIdSchema.parse("00000000-0000-4000-8000-000000000010"),
      occurredAt: new Date().toISOString(),
      organizationId: mockOrgId,
      payload: {},
      projectId: mockProjId,
      runId: RunIdSchema.parse("00000000-0000-4000-8000-000000000020"),
      schemaVersion: 1,
      sequence: 1,
      type: "agent.started",
    };

    mockES.triggerMessage(event1);
    expect(receivedEvents).toHaveLength(1);
    const [recEvent1] = receivedEvents;
    expect(recEvent1?.sequence).toBe(1);
    expect(stream.getLastSeenSequence()).toBe(1);

    // Replay/Duplicate of sequence 1 should be ignored
    mockES.triggerMessage(event1);
    expect(receivedEvents).toHaveLength(1);

    // Next sequence
    const event2: RunEventEnvelope = {
      ...event1,
      eventId: RunEventIdSchema.parse("00000000-0000-4000-8000-000000000011"),
      payload: {
        kind: "message_end",
        role: "assistant",
        text: "Hello from CTO!",
      },
      sequence: 2,
      type: "agent.progress",
    };

    mockES.triggerMessage(event2);
    expect(receivedEvents).toHaveLength(2);
    expect(stream.getLastSeenSequence()).toBe(2);

    stream.close();
    expect(mockES.closed).toBe(true);
    expect(stream.getState()).toBe("closed");
  });

  it("reconnects with exponential backoff and passes after=<sequence>", async () => {
    const stream = new RunEventStream({
      baseBackoffMs: 100,
      buildSessionId: mockSessionId,
      eventSourceConstructor: MockEventSource as unknown as typeof EventSource,
      maxBackoffMs: 500,
      onEvent: vi.fn(),
      organizationId: mockOrgId,
      projectId: mockProjId,
    });

    stream.connect();
    const [firstES] = MockEventSource.instances;
    expect(firstES).toBeDefined();
    if (!firstES) {
      return;
    }

    firstES.triggerOpen();

    // Trigger an event so cursor advances to 5
    firstES.triggerMessage({
      eventId: "00000000-0000-4000-8000-000000000015",
      occurredAt: new Date().toISOString(),
      organizationId: mockOrgId,
      payload: {},
      projectId: mockProjId,
      runId: "00000000-0000-4000-8000-000000000020",
      schemaVersion: 1,
      sequence: 5,
      type: "agent.progress",
    });

    expect(stream.getLastSeenSequence()).toBe(5);

    // Simulate error
    firstES.triggerError();
    expect(stream.getState()).toBe("reconnecting");
    expect(firstES.closed).toBe(true);

    // Fast-forward timer to trigger reconnect
    await vi.advanceTimersByTimeAsync(600);

    expect(MockEventSource.instances).toHaveLength(2);
    const [, secondES] = MockEventSource.instances;
    expect(secondES).toBeDefined();
    if (!secondES) {
      return;
    }

    expect(secondES.url).toContain("after=5");

    secondES.triggerOpen();
    expect(stream.getState()).toBe("connected");

    stream.close();
  });

  it("closes automatically on terminal event (run.completed)", () => {
    const stream = new RunEventStream({
      buildSessionId: mockSessionId,
      eventSourceConstructor: MockEventSource as unknown as typeof EventSource,
      onEvent: vi.fn(),
      organizationId: mockOrgId,
      projectId: mockProjId,
    });

    stream.connect();
    const [es] = MockEventSource.instances;
    expect(es).toBeDefined();
    if (!es) {
      return;
    }

    es.triggerOpen();

    es.triggerMessage({
      eventId: "00000000-0000-4000-8000-000000000099",
      occurredAt: new Date().toISOString(),
      organizationId: mockOrgId,
      payload: { reason: "All tasks verified and completed." },
      projectId: mockProjId,
      runId: "00000000-0000-4000-8000-000000000020",
      schemaVersion: 1,
      sequence: 10,
      type: "run.completed",
    });

    expect(stream.getState()).toBe("closed");
    expect(es.closed).toBe(true);
  });
});
