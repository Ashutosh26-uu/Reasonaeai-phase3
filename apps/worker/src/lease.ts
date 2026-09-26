import type { RunId } from "@reasonateai/contracts/identity";
import { describeFailure } from "./failure.js";
import type { LogFields, Logger } from "./logger.js";

/**
 * The lease a run executes under.
 *
 * A run may not execute without a live lease and a lease may never be held past
 * its expiry, so the keeper owns both halves: it renews while the run is being
 * driven, and the moment it cannot hold the lease it reports the loss once and
 * stops renewing. The caller treats that report as a stop condition — the run's
 * work is aborted and the run is ended rather than continued blind.
 *
 * Expiry is authoritative and lives in the store. The expiry tracked here
 * mirrors it only to decide, before a renewal has even been attempted, whether
 * there is still time left to renew at all.
 */

const EXPIRY_MESSAGE =
  "this worker no longer holds the run lease: the store refused the renewal";
const UNREACHABLE_MESSAGE =
  "this worker could not renew the run lease and the lease expires within one renewal interval";

export interface LeaseRenewal {
  holder: string;
  leaseId: string;
  ttlMs: number;
}

export interface LeaseKeeperOptions {
  /** When the store says the lease lapses, as this process last observed it. */
  expiresAt: Date;
  fields: LogFields;
  holder: string;
  leaseId: string;
  logger: Logger;
  /** Reported once, the first time the lease cannot be held. */
  onLost: (reason: string) => void;
  renew: (input: LeaseRenewal) => Promise<boolean>;
  renewIntervalMs: number;
  runId: RunId;
  ttlMs: number;
}

export class LeaseKeeper {
  #expiresAtMs: number;
  /** Why this keeper stopped renewing, once it did. */
  #halt: { cause: "lost" | "stopped"; reason: string } | undefined;
  #inFlight: Promise<void> | undefined;
  readonly #options: LeaseKeeperOptions;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: LeaseKeeperOptions) {
    this.#options = options;
    this.#expiresAtMs = options.expiresAt.getTime();
  }

  get lost(): boolean {
    return this.#halt?.cause === "lost";
  }

  /**
   * Starts renewing. The timer is deliberately not unref'd: a lease that must be
   * renewed cannot depend on something else keeping the process alive.
   */
  start(): void {
    if (this.#halt !== undefined || this.#timer !== undefined) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#inFlight = this.#renewTick();
    }, this.#options.renewIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.#halt === undefined) {
      this.#halt = { cause: "stopped", reason: "the run is over" };
    }
    clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#inFlight;
  }

  /**
   * One renewal attempt. `true` means this worker still holds the lease: either
   * the store renewed it, or the renewal failed for a reason that leaves time
   * for the next attempt.
   */
  async renewNow(): Promise<boolean> {
    if (this.#halt !== undefined) {
      return false;
    }

    const { fields, holder, leaseId, logger, ttlMs } = this.#options;
    try {
      const held = await this.#options.renew({ holder, leaseId, ttlMs });
      if (!held) {
        this.#lose(EXPIRY_MESSAGE);
        return false;
      }
      this.#expiresAtMs = Date.now() + ttlMs;
      logger.debug("run.lease.renewed", {
        ...fields,
        expiresAt: new Date(this.#expiresAtMs).toISOString(),
      });
      return true;
    } catch (error) {
      const failure = describeFailure(error);
      logger.warn("run.lease.renew.failed", {
        ...fields,
        failure: failure.message,
      });
      if (this.#expiresAtMs - Date.now() <= this.#options.renewIntervalMs) {
        this.#lose(UNREACHABLE_MESSAGE);
        return false;
      }
      return true;
    }
  }

  async #renewTick(): Promise<void> {
    try {
      await this.renewNow();
    } finally {
      this.#inFlight = undefined;
      if (this.#halt === undefined) {
        this.start();
      }
    }
  }

  #lose(reason: string): void {
    if (this.#halt !== undefined) {
      return;
    }
    this.#halt = { cause: "lost", reason };
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#options.logger.error("run.lease.lost", {
      ...this.#options.fields,
      reason,
    });
    this.#options.onLost(reason);
  }
}
