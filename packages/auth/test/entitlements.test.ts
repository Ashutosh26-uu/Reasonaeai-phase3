import {
  EntitlementDecisionSchema,
  EntitlementsSchema,
  PLAN_ENTITLEMENTS,
  type UsageSnapshot,
} from "@reasonateai/contracts/entitlements";
import { describe, expect, it } from "vitest";
import {
  decideEntitlement,
  decideModelAccess,
  decideRateLimit,
} from "../src/entitlements.js";

const { free, pro } = PLAN_ENTITLEMENTS;

interface UsageCounts {
  projects?: number;
  runs?: number;
  sandboxMinutes?: number;
  spendMicros?: number;
  tokens?: number;
  workspaceBytes?: number;
}

const snapshot = (counts: UsageCounts = {}): UsageSnapshot => ({
  periodEnd: "2026-10-01T00:00:00.000Z",
  periodStart: "2026-09-01T00:00:00.000Z",
  projects: counts.projects ?? 0,
  runs: counts.runs ?? 0,
  sandboxMinutes: counts.sandboxMinutes ?? 0,
  spendMicros: counts.spendMicros ?? 0,
  tokens: counts.tokens ?? 0,
  workspaceBytes: counts.workspaceBytes ?? 0,
});

const contractValid = (decision: unknown): boolean =>
  EntitlementDecisionSchema.safeParse(decision).success;

describe("decideEntitlement", () => {
  it("allows a request that lands exactly on the plan limit", () => {
    const decision = decideEntitlement({
      entitlements: free,
      request: { amount: 1, metric: "runs" },
      usage: snapshot({ runs: free.runsPerPeriod - 1 }),
    });

    expect(decision).toMatchObject({
      allowed: true,
      limit: free.runsPerPeriod,
      metric: "runs",
      observed: free.runsPerPeriod - 1,
    });
    expect(contractValid(decision)).toBe(true);
  });

  it("refuses the unit over the limit and reports metric, limit and observed", () => {
    const decision = decideEntitlement({
      entitlements: free,
      request: { amount: 1, metric: "runs" },
      usage: snapshot({ runs: free.runsPerPeriod }),
    });

    expect(decision).toMatchObject({
      allowed: false,
      limit: free.runsPerPeriod,
      metric: "runs",
      observed: free.runsPerPeriod,
    });
    expect(decision.reason).toContain(String(free.runsPerPeriod));
    expect(decision.reason.toLowerCase()).toContain("run");
    expect(contractValid(decision)).toBe(true);
  });

  it("meters each dimension against its own plan limit", () => {
    const spend = decideEntitlement({
      entitlements: pro,
      request: { amount: 1, metric: "spend_micros" },
      usage: snapshot({ spendMicros: pro.spendMicrosPerPeriod }),
    });
    expect(spend).toMatchObject({
      allowed: false,
      limit: pro.spendMicrosPerPeriod,
      metric: "spend_micros",
    });

    const tokens = decideEntitlement({
      entitlements: pro,
      request: { amount: 1, metric: "tokens" },
      usage: snapshot({ tokens: pro.tokensPerPeriod - 1 }),
    });
    expect(tokens).toMatchObject({ allowed: true, limit: pro.tokensPerPeriod });
  });

  it("takes the request amount into account, not just the observed total", () => {
    const decision = decideEntitlement({
      entitlements: free,
      request: { amount: 3, metric: "runs" },
      usage: snapshot({ runs: free.runsPerPeriod - 2 }),
    });

    expect(decision.allowed).toBe(false);
  });
});

describe("decideModelAccess", () => {
  it("allows a model the plan lists", () => {
    const decision = decideModelAccess(free, "deepseek/deepseek-flash");

    expect(decision.allowed).toBe(true);
    expect(contractValid(decision)).toBe(true);
  });

  it("denies a model the plan does not list and names the allowlist", () => {
    const decision = decideModelAccess(free, "deepseek/deepseek-v4-pro");

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("deepseek/deepseek-flash");
    expect(contractValid(decision)).toBe(true);
  });

  it("denies every model when the plan allows none", () => {
    const none = EntitlementsSchema.parse({ ...free, models: [] });

    expect(decideModelAccess(none, "deepseek/deepseek-flash").allowed).toBe(
      false
    );
    expect(
      contractValid(decideModelAccess(none, "deepseek/deepseek-flash"))
    ).toBe(true);
  });
});

describe("decideRateLimit", () => {
  it("allows traffic inside both windows", () => {
    const decision = decideRateLimit(free, {
      perDay: free.rateLimit.requestsPerDay - 1,
      perMinute: free.rateLimit.burstPerMinute - 1,
    });

    expect(decision.allowed).toBe(true);
    expect(contractValid(decision)).toBe(true);
  });

  it("refuses the minute window with a one-minute retry", () => {
    const decision = decideRateLimit(free, {
      perDay: 0,
      perMinute: free.rateLimit.burstPerMinute,
    });

    expect(decision).toMatchObject({ allowed: false, retryAfterSeconds: 60 });
    expect(contractValid(decision)).toBe(true);
  });

  it("refuses the day window with the seconds left in the day", () => {
    const decision = decideRateLimit(
      free,
      { perDay: free.rateLimit.requestsPerDay, perMinute: 0 },
      new Date("2026-09-17T12:00:00.000Z")
    );

    expect(decision).toMatchObject({
      allowed: false,
      retryAfterSeconds: 12 * 60 * 60,
    });
    expect(contractValid(decision)).toBe(true);
  });

  it("reports the minute retry before the day retry when both windows are spent", () => {
    const decision = decideRateLimit(
      free,
      {
        perDay: free.rateLimit.requestsPerDay,
        perMinute: free.rateLimit.burstPerMinute,
      },
      new Date("2026-09-17T12:00:00.000Z")
    );

    expect(decision.retryAfterSeconds).toBe(60);
  });

  it("never reports a retry shorter than a second at the edge of the day", () => {
    const decision = decideRateLimit(
      free,
      { perDay: free.rateLimit.requestsPerDay, perMinute: 0 },
      new Date("2026-09-17T23:59:59.500Z")
    );

    expect(decision.retryAfterSeconds).toBe(1);
  });
});
