import type {
  RunEventEnvelope,
  RunEventType,
} from "@reasonateai/contracts/execution-protocol";
import { RunEventEnvelopeSchema } from "@reasonateai/contracts/execution-protocol";

export type StreamConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error"
  | "closed";

export interface StreamStateDetail {
  attempt?: number | undefined;
  error?: Error | undefined;
  nextRetryMs?: number | undefined;
}

export interface RunEventStreamOptions {
  /** Base backoff duration in milliseconds (default 1000) */
  baseBackoffMs?: number | undefined;
  /** Optional base API URL (e.g. "http://localhost:3000" or ""). Defaults to current origin in browser. */
  baseUrl?: string | undefined;
  /** The target BuildSession UUID */
  buildSessionId: string;
  /** Optional custom EventSource constructor for testing or custom environments */
  eventSourceConstructor?: typeof EventSource | undefined;
  /** Starting sequence cursor (default 0) */
  initialSequence?: number | undefined;
  /** Maximum backoff ceiling in milliseconds (default 15000) */
  maxBackoffMs?: number | undefined;
  /** Maximum consecutive reconnect attempts before transitioning to error (default 30) */
  maxReconnectAttempts?: number | undefined;
  /** Callback on connection state transitions */
  onConnectionStateChange?:
    | ((
        state: StreamConnectionState,
        detail?: StreamStateDetail | undefined
      ) => void)
    | undefined;
  /** Error callback */
  onError?: ((error: Error) => void) | undefined;
  /** Callback fired for every valid, sequenced event */
  onEvent: (event: RunEventEnvelope) => void;
  /** Organization UUID scope */
  organizationId: string;
  /** Project UUID scope */
  projectId: string;
}

const TERMINAL_TYPES: ReadonlySet<RunEventType> = new Set([
  "run.completed",
  "run.failed",
  "run.cancelled",
]);

const TRAILING_SLASHES_REGEX = /\/+$/;

export class RunEventStream {
  private readonly baseUrl: string;
  private readonly buildSessionId: string;
  private readonly organizationId: string;
  private readonly projectId: string;
  private readonly onEvent: (event: RunEventEnvelope) => void;
  private readonly onConnectionStateChange?:
    | ((
        state: StreamConnectionState,
        detail?: StreamStateDetail | undefined
      ) => void)
    | undefined;
  private readonly onError?: ((error: Error) => void) | undefined;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly EventSourceClass: typeof EventSource;

  private state: StreamConnectionState = "idle";
  private lastSeenSequence: number;
  private readonly seenEventIds = new Set<string>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private eventSource: EventSource | null = null;

  constructor(options: RunEventStreamOptions) {
    this.baseUrl = (options.baseUrl ?? "").replace(TRAILING_SLASHES_REGEX, "");
    this.buildSessionId = options.buildSessionId;
    this.organizationId = options.organizationId;
    this.projectId = options.projectId;
    this.lastSeenSequence = options.initialSequence ?? 0;
    this.onEvent = options.onEvent;
    this.onConnectionStateChange = options.onConnectionStateChange;
    this.onError = options.onError;
    this.baseBackoffMs = options.baseBackoffMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 15_000;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 30;
    this.EventSourceClass =
      options.eventSourceConstructor ??
      (typeof EventSource === "undefined"
        ? (null as unknown as typeof EventSource)
        : EventSource);
  }

  getState(): StreamConnectionState {
    return this.state;
  }

  getLastSeenSequence(): number {
    return this.lastSeenSequence;
  }

  connect(): void {
    if (this.state === "connected" || this.state === "connecting") {
      return;
    }

    if (!this.EventSourceClass) {
      const err = new Error(
        "EventSource is not supported in this environment."
      );
      this.transitionState("error", { error: err });
      this.onError?.(err);
      return;
    }

    this.clearReconnectTimer();
    this.openEventSource();
  }

  close(): void {
    this.clearReconnectTimer();
    this.teardownEventSource();
    this.transitionState("closed");
  }

  reconnectNow(): void {
    this.clearReconnectTimer();
    this.teardownEventSource();
    this.reconnectAttempt = 0;
    this.connect();
  }

  private openEventSource(): void {
    this.transitionState(
      this.reconnectAttempt > 0 ? "reconnecting" : "connecting",
      {
        attempt: this.reconnectAttempt,
      }
    );

    const params = new URLSearchParams({
      organizationId: this.organizationId,
      projectId: this.projectId,
    });

    if (this.lastSeenSequence > 0) {
      params.set("after", String(this.lastSeenSequence));
    }

    const url = `${this.baseUrl}/v1/build-sessions/${encodeURIComponent(
      this.buildSessionId
    )}/events?${params.toString()}`;

    try {
      this.eventSource = new this.EventSourceClass(url, {
        withCredentials: true,
      });

      this.eventSource.onopen = () => {
        this.reconnectAttempt = 0;
        this.transitionState("connected");
      };

      this.eventSource.onmessage = (event: MessageEvent) => {
        this.handleRawMessage(event.data);
      };

      this.eventSource.onerror = (_event: Event) => {
        if (this.state === "closed") {
          return;
        }

        const err = new Error("SSE connection error or dropped.");
        this.teardownEventSource();

        if (this.reconnectAttempt >= this.maxReconnectAttempts) {
          this.transitionState("error", {
            error: new Error(
              `Max reconnect attempts (${this.maxReconnectAttempts}) exceeded.`
            ),
          });
          this.onError?.(err);
          return;
        }

        this.scheduleReconnect(err);
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.teardownEventSource();
      this.scheduleReconnect(error);
    }
  }

  private handleRawMessage(data: string): void {
    if (!data || data.trim() === "" || data.startsWith(":")) {
      return; // Heartbeat or comment
    }

    try {
      const parsed = JSON.parse(data);
      const validation = RunEventEnvelopeSchema.safeParse(parsed);

      if (!validation.success) {
        return;
      }

      const event = validation.data;

      // Monotonic sequence and deduplication check
      if (
        event.sequence <= this.lastSeenSequence &&
        this.lastSeenSequence > 0
      ) {
        return;
      }

      if (this.seenEventIds.has(event.eventId)) {
        return;
      }

      this.seenEventIds.add(event.eventId);
      if (event.sequence > this.lastSeenSequence) {
        this.lastSeenSequence = event.sequence;
      }

      // Dispatch to listener
      this.onEvent(event);

      // Check if terminal event
      if (TERMINAL_TYPES.has(event.type)) {
        this.close();
      }
    } catch {
      // Ignore unparseable non-JSON lines
    }
  }

  private scheduleReconnect(error: Error): void {
    this.reconnectAttempt += 1;

    // Exponential backoff with jitter: min(maxBackoff, base * 1.5^(attempt-1)) + jitter
    const backoff = Math.min(
      this.maxBackoffMs,
      this.baseBackoffMs * 1.5 ** Math.max(0, this.reconnectAttempt - 1)
    );
    const jitter = Math.random() * 400;
    const delayMs = Math.round(backoff + jitter);

    this.transitionState("reconnecting", {
      attempt: this.reconnectAttempt,
      error,
      nextRetryMs: delayMs,
    });

    this.reconnectTimer = setTimeout(() => {
      if (this.state !== "closed") {
        this.openEventSource();
      }
    }, delayMs);
  }

  private teardownEventSource(): void {
    if (this.eventSource) {
      this.eventSource.onopen = null;
      this.eventSource.onmessage = null;
      this.eventSource.onerror = null;
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private transitionState(
    nextState: StreamConnectionState,
    detail?: StreamStateDetail | undefined
  ): void {
    this.state = nextState;
    this.onConnectionStateChange?.(nextState, detail);
  }
}
