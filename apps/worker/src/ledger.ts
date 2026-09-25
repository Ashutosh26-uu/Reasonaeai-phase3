import type { AgentControllerEvent } from "@mastra/core/agent-controller";
import type { BuildSessionId } from "@reasonateai/contracts/execution";
import type {
  RunEventEnvelope,
  RunEventType,
} from "@reasonateai/contracts/execution-protocol";
import type {
  OrganizationId,
  ProjectId,
  RunId,
} from "@reasonateai/contracts/identity";
import { toRunEventEnvelope } from "@reasonateai/cto-runtime/run-events";
import type {
  ProjectStateStore,
  TenantScope,
} from "@reasonateai/project-state/postgres";
import { describeFailure } from "./failure.js";
import type { LogFields, Logger } from "./logger.js";

/**
 * The durable record of a run.
 *
 * Two things reach the ledger from the execution plane: the controller events
 * the runtime decides carry durable meaning, mapped through
 * `@reasonateai/cto-runtime/run-events`, and the run-level transitions only the
 * worker can know — the claim, and the terminal outcome with its reason. Both go
 * through `appendRunEvent`, so the store allocates the sequence inside the same
 * transaction that writes the ledger row and its outbox record: an event is
 * either committed with a sequence and publishable, or it does not exist.
 */

export interface RunIdentity {
  buildSessionId: BuildSessionId;
  organizationId: OrganizationId;
  projectId: ProjectId;
  runId: RunId;
}

export interface Ledger {
  /**
   * Records one controller event, when the mapper considers it durable, and
   * returns the record that was committed. The mapper decides meaning; the
   * store decides sequence.
   */
  appendControllerEvent: (input: {
    event: AgentControllerEvent;
    identity: RunIdentity;
    occurredAt: Date;
  }) => Promise<RunEventEnvelope | undefined>;
  /** Records a run-level transition the worker itself performed. */
  appendTransition: (input: {
    identity: RunIdentity;
    payload: Record<string, unknown>;
    type: RunEventType;
  }) => Promise<RunEventEnvelope>;
}

function tenantScopeOf(identity: RunIdentity): TenantScope {
  return {
    organizationId: identity.organizationId,
    projectId: identity.projectId,
  };
}

export function createLedger(input: { store: ProjectStateStore }): Ledger {
  const { store } = input;

  return {
    appendControllerEvent: async ({ event, identity, occurredAt }) => {
      const envelope = toRunEventEnvelope({
        event,
        occurredAt,
        runId: identity.runId,
        scope: {
          buildSessionId: identity.buildSessionId,
          organizationId: identity.organizationId,
          projectId: identity.projectId,
        },
      });
      if (envelope === undefined) {
        return;
      }

      return await store.appendRunEvent({
        payload: envelope.payload,
        runId: identity.runId,
        scope: tenantScopeOf(identity),
        type: envelope.type,
      });
    },
    appendTransition: async ({ identity, payload, type }) =>
      await store.appendRunEvent({
        payload,
        runId: identity.runId,
        scope: tenantScopeOf(identity),
        type,
      }),
  };
}

/** How much of the append queue may accumulate before it is worth reporting. */
const BACKLOG_WARNING = 64;

/**
 * The event types that end a run. A controller reaches one of these when its
 * agent finishes, errors, or is aborted, and the type it reported is the
 * controller's own verdict on the run.
 */
const TERMINAL_EVENT_TYPES: Record<string, true> = {
  "run.cancelled": true,
  "run.completed": true,
  "run.failed": true,
};

/**
 * The most useful sentence in a terminal event's payload. A controller error
 * carries its own message; an `agent_end` carries only the reason it ended, so
 * the first real message is kept rather than the last label.
 */
function messageFrom(payload: Record<string, unknown>): string | undefined {
  const { message, reason } = payload;
  if (typeof message === "string" && message.trim() !== "") {
    return message;
  }
  return typeof reason === "string" && reason.trim() !== ""
    ? reason
    : undefined;
}

/** The controller's own verdict on the run, once it reported one. */
export interface RunVerdict {
  reason: string | undefined;
  type: RunEventType;
}

/**
 * Serializes controller-event appends for one run.
 *
 * A session emits its events faster than a round trip to PostgreSQL, and the
 * ledger is ordered, so the appends are chained rather than issued in parallel:
 * one writer, in emission order. A failed append is reported and dropped — it
 * cannot be retried without inventing an order the ledger never had — and the
 * terminal transition the worker appends afterwards still records the outcome.
 */
export class RunEventAppender {
  #chain: Promise<void> = Promise.resolve();
  readonly #fields: LogFields;
  readonly #identity: RunIdentity;
  readonly #ledger: Ledger;
  readonly #logger: Logger;
  #pending = 0;
  #verdict: RunVerdict | undefined;

  constructor(input: {
    fields: LogFields;
    identity: RunIdentity;
    ledger: Ledger;
    logger: Logger;
  }) {
    this.#fields = input.fields;
    this.#identity = input.identity;
    this.#ledger = input.ledger;
    this.#logger = input.logger;
  }

  push(event: AgentControllerEvent, occurredAt: Date): void {
    this.#pending += 1;
    if (this.#pending === BACKLOG_WARNING) {
      this.#logger.warn("run.ledger.backlog", {
        ...this.#fields,
        reason: `${BACKLOG_WARNING} controller events are queued for the ledger`,
      });
    }

    this.#chain = this.#chain.then(async () => {
      this.#pending -= 1;
      try {
        const recorded = await this.#ledger.appendControllerEvent({
          event,
          identity: this.#identity,
          occurredAt,
        });
        if (recorded !== undefined) {
          this.#record(recorded);
        }
      } catch (error) {
        this.#logger.error("run.ledger.append.failed", {
          ...this.#fields,
          controllerEvent: event.type,
          failure: describeFailure(error).message,
        });
      }
    });
  }

  async drain(): Promise<void> {
    await this.#chain;
  }

  /**
   * What the controller said about the run, once every queued append is
   * committed. The last terminal event wins, because a run that failed and then
   * reported a completed turn is still the run that failed.
   */
  verdict(): RunVerdict | undefined {
    return this.#verdict;
  }

  #record(envelope: RunEventEnvelope): void {
    if (TERMINAL_EVENT_TYPES[envelope.type] !== true) {
      return;
    }
    const reason = messageFrom(envelope.payload);
    this.#verdict = {
      reason: this.#verdict?.reason ?? reason,
      type: envelope.type,
    };
  }
}
