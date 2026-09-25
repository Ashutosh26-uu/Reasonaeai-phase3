/**
 * The one shutdown signal a worker process owns.
 *
 * SIGINT and SIGTERM both have to reach the run that is currently executing, so
 * the signal is a first-class value rather than a process-level flag: the
 * executor subscribes to it, aborts the step it is driving when it fires, and a
 * subscription created after the request fires immediately — a run claimed
 * during shutdown must not start work nobody is waiting for.
 */

export interface StopSignal {
  /** The reason the stop was requested, once one was. */
  readonly reason: string | undefined;
  request: (reason: string) => void;
  subscribe: (listener: (reason: string) => void) => () => void;
}

export function createStopSignal(): StopSignal {
  const listeners = new Set<(reason: string) => void>();
  let reason: string | undefined;

  return {
    get reason(): string | undefined {
      return reason;
    },
    request(next: string): void {
      if (reason !== undefined) {
        return;
      }
      reason = next;
      for (const listener of [...listeners]) {
        listener(next);
      }
    },
    subscribe(listener: (reason: string) => void): () => void {
      listeners.add(listener);
      if (reason !== undefined) {
        listener(reason);
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
