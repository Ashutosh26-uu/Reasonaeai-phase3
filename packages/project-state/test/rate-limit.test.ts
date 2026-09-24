import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createRateLimiter } from "../src/rate-limit.js";

const redisUrl = process.env.REDIS_URL;
const describeWithRedis = redisUrl ? describe : describe.skip;

const UNAVAILABLE_PATTERN = /unavailable/i;

describeWithRedis("rate limiter", () => {
  const limiter = createRateLimiter({
    keyPrefix: `reasonateai-test-${randomUUID()}`,
    url: redisUrl,
  });

  afterAll(async () => {
    await limiter.close();
  });

  it("counts the request it admits and reports no wait", async () => {
    const organizationId = randomUUID();

    const decision = await limiter.consume({
      burstPerMinute: 2,
      organizationId,
      requestsPerDay: 100,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.observed).toEqual({ perDay: 1, perMinute: 1 });
    expect(decision.retryAfterSeconds).toBeUndefined();
  });

  it("refuses past the burst window, still counting the refused request", async () => {
    const organizationId = randomUUID();
    const limit = { burstPerMinute: 1, organizationId, requestsPerDay: 100 };

    await limiter.consume(limit);
    const refused = await limiter.consume(limit);

    expect(refused.allowed).toBe(false);
    expect(refused.observed.perMinute).toBe(2);
    expect(refused.observed.perDay).toBe(2);
    // The wait can only be the minute bucket's remainder, never a day.
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("refuses past the daily window even when the burst window is clear", async () => {
    const organizationId = randomUUID();
    const limit = { burstPerMinute: 100, organizationId, requestsPerDay: 1 };

    await limiter.consume(limit);
    const refused = await limiter.consume(limit);

    expect(refused.allowed).toBe(false);
    expect(refused.observed.perDay).toBe(2);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(86_400);
  });

  it("counts each organization separately", async () => {
    const limit = { burstPerMinute: 1, requestsPerDay: 1 };

    await limiter.consume({ ...limit, organizationId: randomUUID() });
    const other = await limiter.consume({
      ...limit,
      organizationId: randomUUID(),
    });

    expect(other.allowed).toBe(true);
  });

  it("fails closed with a clear error when Redis is unreachable", async () => {
    const unreachable = createRateLimiter({ url: "redis://127.0.0.1:1" });

    try {
      await expect(
        unreachable.consume({
          burstPerMinute: 10,
          organizationId: randomUUID(),
          requestsPerDay: 10,
        })
      ).rejects.toThrow(UNAVAILABLE_PATTERN);
    } finally {
      await unreachable.close();
    }
  });

  it("fails closed when no Redis is configured at all", async () => {
    const unconfigured = createRateLimiter({ url: undefined });

    await expect(
      unconfigured.consume({
        burstPerMinute: 10,
        organizationId: randomUUID(),
        requestsPerDay: 10,
      })
    ).rejects.toThrow(UNAVAILABLE_PATTERN);
  });
});
