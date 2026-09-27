import { describe, expect, it } from "vitest";
import { readWorkerConfig } from "../src/config.js";

const DATABASE_URL = "postgres://reasonate:reasonate@127.0.0.1:55432/reasonate";

const DATABASE_URL_FIELD = /DATABASE_URL/;
const MAX_RUNS_FIELD = /WORKER_MAX_RUNS_PER_POLL/;
const POLL_INTERVAL_FIELD = /WORKER_POLL_INTERVAL_MS/;
const RENEW_INTERVAL_FIELD = /WORKER_RENEW_INTERVAL_MS/;
const STOP_GRACE_FIELD = /WORKER_STOP_GRACE_MS/;

describe("worker configuration", () => {
  it("derives a bounded, coherent configuration from the environment", () => {
    const config = readWorkerConfig({
      DATABASE_URL,
      REASONATE_CHECKPOINT_ROOT: "C:/tmp/checkpoints",
      WORKER_HOLDER: "worker-1",
      WORKER_LEASE_TTL_MS: "30000",
      WORKER_MAX_RUNS_PER_POLL: "4",
      WORKER_POLL_INTERVAL_MS: "500",
      WORKER_POLL_JITTER_MS: "50",
      WORKER_RENEW_INTERVAL_MS: "5000",
    });

    expect(config).toMatchObject({
      checkpointRoot: "C:/tmp/checkpoints",
      databaseUrl: DATABASE_URL,
      holder: "worker-1",
      leaseTtlMs: 30_000,
      maxRunsPerPoll: 4,
      pollIntervalMs: 500,
      pollJitterMs: 50,
      renewIntervalMs: 5000,
    });
  });

  it("generates a distinct holder identity when none is configured", () => {
    const first = readWorkerConfig({ DATABASE_URL }).holder;
    const second = readWorkerConfig({ DATABASE_URL }).holder;

    expect(first.startsWith("worker-")).toBe(true);
    expect(first).not.toBe(second);
  });

  it("refuses a renewal interval that cannot keep the lease it takes", () => {
    expect(() =>
      readWorkerConfig({
        DATABASE_URL,
        WORKER_LEASE_TTL_MS: "1000",
        WORKER_RENEW_INTERVAL_MS: "400",
      })
    ).toThrow(RENEW_INTERVAL_FIELD);
  });

  it("refuses a value outside its bound", () => {
    expect(() =>
      readWorkerConfig({ DATABASE_URL, WORKER_MAX_RUNS_PER_POLL: "0" })
    ).toThrow(MAX_RUNS_FIELD);
    expect(() =>
      readWorkerConfig({ DATABASE_URL, WORKER_POLL_INTERVAL_MS: "1000000" })
    ).toThrow(POLL_INTERVAL_FIELD);
  });

  it("refuses a configuration that cannot run at all, without echoing the value", () => {
    const failure = (() => {
      try {
        readWorkerConfig({
          DATABASE_URL: "",
          REDIS_URL: "redis://secret-host",
        });
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error("The configuration was accepted.");
    })();

    expect(failure).toMatch(DATABASE_URL_FIELD);
    expect(failure).not.toContain("redis://secret-host");
  });

  it("refuses a stop window longer than the shutdown window", () => {
    expect(() =>
      readWorkerConfig({
        DATABASE_URL,
        WORKER_SHUTDOWN_GRACE_MS: "1000",
        WORKER_STOP_GRACE_MS: "2000",
      })
    ).toThrow(STOP_GRACE_FIELD);
  });
});
