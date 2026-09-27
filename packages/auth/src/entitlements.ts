/**
 * Plan entitlement decisions.
 *
 * The policy is pure: it compares one organization's plan against one usage
 * snapshot and returns a decision a caller can act on without re-reading the
 * store. Model access is an allowlist because paid frontier APIs are forbidden
 * outright, and every reason is written for the person who hit the limit, so a
 * reason names the metric and its limit and never an internal identifier.
 */

import type {
  EntitlementDecision,
  Entitlements,
  PlanId,
  UsageMetric,
  UsageSnapshot,
} from "@reasonateai/contracts/entitlements";

/**
 * The plan an organization is on. Billing owns the plan column the store will
 * eventually carry; until it ships, the free plan is the only truthful answer
 * for an organization that has never paid.
 */
export const defaultPlan: PlanId = "free";

/** How each metered dimension reads to a user. */
const metricLabels: Readonly<Record<UsageMetric, string>> = {
  projects: "project quota",
  runs: "run quota",
  sandbox_minutes: "sandbox-minute quota",
  spend_micros: "inference spend quota, in micro-USD",
  tokens: "token quota",
  workspace_bytes: "workspace storage quota, in bytes",
};

/** The plan limit a metric is metered against. */
const limitFor = (entitlements: Entitlements, metric: UsageMetric): number => {
  switch (metric) {
    case "projects":
      return entitlements.projects;
    case "runs":
      return entitlements.runsPerPeriod;
    case "sandbox_minutes":
      return entitlements.sandboxMinutesPerPeriod;
    case "spend_micros":
      return entitlements.spendMicrosPerPeriod;
    case "tokens":
      return entitlements.tokensPerPeriod;
    case "workspace_bytes":
      return entitlements.workspaceBytes;
    default: {
      // Exhaustive over the union; an unhandled metric is a programming error.
      const unhandled: never = metric;
      throw new Error(`Unhandled usage metric: ${String(unhandled)}`);
    }
  }
};

/** The usage already observed for a metric's window in this snapshot. */
const observedFor = (usage: UsageSnapshot, metric: UsageMetric): number => {
  switch (metric) {
    case "projects":
      return usage.projects;
    case "runs":
      return usage.runs;
    case "sandbox_minutes":
      return usage.sandboxMinutes;
    case "spend_micros":
      return usage.spendMicros;
    case "tokens":
      return usage.tokens;
    case "workspace_bytes":
      return usage.workspaceBytes;
    default: {
      // Exhaustive over the union; an unhandled metric is a programming error.
      const unhandled: never = metric;
      throw new Error(`Unhandled usage metric: ${String(unhandled)}`);
    }
  }
};

/**
 * Whether one metered request fits in the plan. The limit is inclusive: a
 * request that lands exactly on the limit is allowed and the next unit over is
 * the refusal, so a plan's headline number is what it actually grants.
 */
export const decideEntitlement = (input: {
  entitlements: Entitlements;
  request: { amount: number; metric: UsageMetric };
  usage: UsageSnapshot;
}): EntitlementDecision => {
  const { entitlements, request, usage } = input;
  const limit = limitFor(entitlements, request.metric);
  const observed = observedFor(usage, request.metric);
  const label = metricLabels[request.metric];

  if (observed + request.amount <= limit) {
    return {
      allowed: true,
      limit,
      metric: request.metric,
      observed,
      reason: `Within this plan's ${label} of ${limit}.`,
    };
  }

  return {
    allowed: false,
    limit,
    metric: request.metric,
    observed,
    reason: `This plan's ${label} is ${limit}, and ${observed} is already used.`,
  };
};

/**
 * Whether the plan may call a model. A denial names the allowlist so the
 * caller knows which open-weight models to switch to instead of guessing.
 */
export const decideModelAccess = (
  entitlements: Entitlements,
  modelId: string
): EntitlementDecision => {
  if (entitlements.models.includes(modelId)) {
    return { allowed: true, reason: `${modelId} is included in this plan.` };
  }

  if (entitlements.models.length === 0) {
    return { allowed: false, reason: "This plan does not include any models." };
  }

  return {
    allowed: false,
    reason: `This plan can only run ${entitlements.models.join(", ")}.`,
  };
};

/**
 * Whether the organization is inside both request-rate windows. The windows are
 * separate ceilings: a burst refusal clears within a minute, and a daily
 * refusal only clears when the day rolls over.
 */
export const decideRateLimit = (
  entitlements: Entitlements,
  observed: { perDay: number; perMinute: number },
  now: Date = new Date()
): EntitlementDecision => {
  const { burstPerMinute, requestsPerDay } = entitlements.rateLimit;

  if (observed.perMinute >= burstPerMinute) {
    return {
      allowed: false,
      reason: `This plan allows ${burstPerMinute} requests per minute, and ${observed.perMinute} are already spent in this minute.`,
      retryAfterSeconds: 60,
    };
  }

  if (observed.perDay >= requestsPerDay) {
    // The daily window is a calendar day, so the wait is the remainder of today
    // rather than a fixed 24 hours, floored at the second that is still left.
    const nextMidnight = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1
    );

    return {
      allowed: false,
      reason: `This plan allows ${requestsPerDay} requests per day, and ${observed.perDay} are already spent today.`,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((nextMidnight - now.getTime()) / 1000)
      ),
    };
  }

  return {
    allowed: true,
    reason: `Within this plan's rate limits of ${burstPerMinute} requests per minute and ${requestsPerDay} requests per day.`,
  };
};
