/**
 * Plan entitlements and metered limits.
 *
 * One vocabulary for "what this organization is allowed to do", shared by the
 * policy that decides, the store that meters, and the runtime that enforces a
 * budget mid-run. Limits are integers in the unit each metric is metered in, so
 * a comparison never needs floating point and a spend ceiling is expressed in
 * micro-USD rather than a float that drifts.
 *
 * Model access is an allowlist of router identifiers. It stays an allowlist
 * because the product forbids paid frontier APIs outright: a plan can only ever
 * name open-weight models, and an empty list means no model access at all.
 */

import { z } from "zod";

export const PlanIdSchema = z.enum(["free", "pro", "team", "enterprise"]);
export type PlanId = z.infer<typeof PlanIdSchema>;

/** A metered dimension. Every limit in {@link Entitlements} maps to one. */
export const UsageMetricSchema = z.enum([
  "runs",
  "tokens",
  "spend_micros",
  "sandbox_minutes",
  "workspace_bytes",
  "projects",
]);
export type UsageMetric = z.infer<typeof UsageMetricSchema>;

/** Request-rate ceiling, enforced per organization over a rolling window. */
export const RateLimitSchema = z.object({
  /** Requests allowed in any one minute. */
  burstPerMinute: z.number().int().positive(),
  /** Requests allowed in a rolling day. */
  requestsPerDay: z.number().int().positive(),
});
export type RateLimit = z.infer<typeof RateLimitSchema>;

export const EntitlementsSchema = z.object({
  /** Runs that may execute at the same time for one organization. */
  concurrentRuns: z.number().int().positive(),
  /** Router model identifiers this plan may call. Empty means none. */
  models: z.array(z.string().min(1)),
  /** Projects the organization may own at once. */
  projects: z.number().int().positive(),
  rateLimit: RateLimitSchema,
  /** Runs started per billing period. */
  runsPerPeriod: z.number().int().positive(),
  /** Sandbox minutes consumed per billing period. */
  sandboxMinutesPerPeriod: z.number().int().positive(),
  /** Inference spend ceiling per billing period, in micro-USD. */
  spendMicrosPerPeriod: z.number().int().positive(),
  /** Model tokens (input plus output) per billing period. */
  tokensPerPeriod: z.number().int().positive(),
  /** Bytes retained across the organization's workspaces and artifacts. */
  workspaceBytes: z.number().int().positive(),
});
export type Entitlements = z.infer<typeof EntitlementsSchema>;

/**
 * The plan catalogue. These are product decisions, kept in one place so the
 * policy, the store, and the runtime cannot disagree about a limit.
 */
export const PLAN_ENTITLEMENTS: Record<PlanId, Entitlements> = {
  enterprise: {
    concurrentRuns: 50,
    models: [
      "deepseek/deepseek-flash",
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-pro",
    ],
    projects: 500,
    rateLimit: { burstPerMinute: 2000, requestsPerDay: 2_000_000 },
    runsPerPeriod: 10_000,
    sandboxMinutesPerPeriod: 60_000,
    spendMicrosPerPeriod: 2_000_000_000,
    tokensPerPeriod: 250_000_000,
    workspaceBytes: 200 * 1024 * 1024 * 1024,
  },
  free: {
    concurrentRuns: 1,
    models: ["deepseek/deepseek-flash"],
    projects: 1,
    rateLimit: { burstPerMinute: 20, requestsPerDay: 200 },
    runsPerPeriod: 5,
    sandboxMinutesPerPeriod: 60,
    spendMicrosPerPeriod: 2_000_000,
    tokensPerPeriod: 250_000,
    workspaceBytes: 256 * 1024 * 1024,
  },
  pro: {
    concurrentRuns: 3,
    models: ["deepseek/deepseek-flash", "deepseek/deepseek-v4-flash"],
    projects: 10,
    rateLimit: { burstPerMinute: 120, requestsPerDay: 5000 },
    runsPerPeriod: 200,
    sandboxMinutesPerPeriod: 1200,
    spendMicrosPerPeriod: 40_000_000,
    tokensPerPeriod: 5_000_000,
    workspaceBytes: 4 * 1024 * 1024 * 1024,
  },
  team: {
    concurrentRuns: 10,
    models: [
      "deepseek/deepseek-flash",
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-pro",
    ],
    projects: 50,
    rateLimit: { burstPerMinute: 600, requestsPerDay: 100_000 },
    runsPerPeriod: 1000,
    sandboxMinutesPerPeriod: 6000,
    spendMicrosPerPeriod: 200_000_000,
    tokensPerPeriod: 25_000_000,
    workspaceBytes: 20 * 1024 * 1024 * 1024,
  },
};

/** Usage observed for one organization over one billing period. */
export const UsageSnapshotSchema = z.object({
  periodEnd: z.string(),
  periodStart: z.string(),
  projects: z.number().int().nonnegative(),
  runs: z.number().int().nonnegative(),
  sandboxMinutes: z.number().int().nonnegative(),
  spendMicros: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  workspaceBytes: z.number().int().nonnegative(),
});
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>;

/** One metered event, as recorded. Amounts are integers in the metric's unit. */
export const UsageRecordSchema = z.object({
  amount: z.number().int(),
  metric: UsageMetricSchema,
  organizationId: z.string().min(1),
  recordedAt: z.string(),
  runId: z.string().min(1).nullable(),
});
export type UsageRecord = z.infer<typeof UsageRecordSchema>;

/** Why a request was allowed or refused. `reason` is safe to show a user. */
export const EntitlementDecisionSchema = z.object({
  allowed: z.boolean(),
  limit: z.number().int().nonnegative().optional(),
  metric: UsageMetricSchema.optional(),
  observed: z.number().int().nonnegative().optional(),
  reason: z.string().min(1),
  retryAfterSeconds: z.number().int().positive().optional(),
});
export type EntitlementDecision = z.infer<typeof EntitlementDecisionSchema>;

/**
 * The outcome of an atomic reservation: whether the slot was granted and what
 * the usage was when it was decided, so a caller can act without re-reading.
 */
export const QuotaReservationSchema = z.object({
  allowed: z.boolean(),
  limit: z.number().int().nonnegative(),
  metric: UsageMetricSchema,
  observed: z.number().int().nonnegative(),
});
export type QuotaReservation = z.infer<typeof QuotaReservationSchema>;
