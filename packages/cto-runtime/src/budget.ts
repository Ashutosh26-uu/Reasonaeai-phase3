/**
 * Per-run consumption ceilings.
 *
 * A budget is the last line of defence for a single agent loop, not a
 * scheduler: the loop hands its completed steps to a stop condition after each
 * step, so a ceiling ends the run at the first step boundary past it rather
 * than exactly on the limit. It bounds a run that went wrong in a way no
 * instruction can catch.
 *
 * Token counts are always reported by the provider. Spend is not: an open-weight
 * router may report it in micro-USD, as a USD float, or not at all, and a step
 * that reports no cost is *unknown*, never free — an unknown total must not be
 * reported as if the run had spent nothing.
 */

import type { UsageMetric } from "@reasonateai/contracts/entitlements";

const MICROS_PER_USD = 1_000_000;

/** The token and cost fields a step may report under its usage. */
export interface BudgetUsage {
  /** Spend for this step in USD, as some routers report it. */
  cost?: number | undefined;
  /** Spend for this step in micro-USD, the unit the plan catalogue uses. */
  costMicros?: number | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
}

/** The part of a loop step a budget reads. */
export interface BudgetStep {
  providerMetadata?: Record<string, unknown> | undefined;
  usage?: BudgetUsage | undefined;
}

/** The argument a loop hands to a stop condition. */
export interface BudgetLoopOptions {
  steps: readonly BudgetStep[];
}

export interface RunBudgetConfig {
  /** Inference spend the run may consume, in micro-USD. */
  spendMicros?: number | undefined;
  /** Tokens (input plus output) the run may consume. */
  tokens?: number | undefined;
}

/** What a set of steps consumed. `spendMicros` is null when a step reported none. */
export interface BudgetConsumption {
  spendMicros: number | null;
  tokens: number;
}

/** The ceiling a run crossed, shaped for the run report. */
export interface BudgetStop {
  limit: number;
  metric: UsageMetric;
  observed: number;
  reason: "budget";
}

/** A stop condition, structurally the predicate a Mastra loop calls. */
export type BudgetStopCondition = (options: BudgetLoopOptions) => boolean;

export interface RunBudget {
  /** What these steps consumed. */
  consumed: (steps: readonly BudgetStep[]) => BudgetConsumption;
  /** The ceiling these steps crossed, if any. */
  stop: (steps: readonly BudgetStep[]) => BudgetStop | undefined;
  /**
   * Stop condition for a Mastra loop.
   *
   * Stateless: totals are recomputed from the steps the loop hands over, so one
   * budget can serve every run a long-lived runtime drives and a re-ask cannot
   * double-count.
   */
  stopWhen: BudgetStopCondition;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A provider-reported count: a whole, non-negative number. */
function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

/**
 * The tokens one step consumed.
 *
 * The provider's own total wins when it reports one: it is what the provider
 * billed for and already includes the reasoning tokens a sum of input and
 * output would miss.
 */
function stepTokens(step: BudgetStep): number {
  const { usage } = step;
  if (usage === undefined) {
    return 0;
  }
  const total = asCount(usage.totalTokens);
  if (total !== undefined) {
    return total;
  }
  return (asCount(usage.inputTokens) ?? 0) + (asCount(usage.outputTokens) ?? 0);
}

function spendMicrosOf(record: unknown): number | undefined {
  const fields = asRecord(record);
  if (fields === undefined) {
    return undefined;
  }
  const micros = fields.costMicros;
  if (typeof micros === "number" && Number.isFinite(micros) && micros >= 0) {
    return Math.round(micros);
  }
  const usd = fields.cost;
  return typeof usd === "number" && Number.isFinite(usd) && usd >= 0
    ? Math.round(usd * MICROS_PER_USD)
    : undefined;
}

/**
 * The spend one step reported, in micro-USD, or null when it reported none.
 *
 * Cost travels beside the tokens rather than inside the standard usage shape,
 * so a router that reports it puts it under the step's usage or under the
 * provider's metadata. A step that reports neither is unknown.
 */
function stepSpendMicros(step: BudgetStep): number | null {
  const direct = spendMicrosOf(step.usage);
  if (direct !== undefined) {
    return direct;
  }
  const metadata = asRecord(step.providerMetadata);
  if (metadata === undefined) {
    return null;
  }
  for (const provider of Object.values(metadata)) {
    const fields = asRecord(provider);
    if (fields === undefined) {
      continue;
    }
    const spend = spendMicrosOf(fields) ?? spendMicrosOf(fields.usage);
    if (spend !== undefined) {
      return spend;
    }
  }
  return null;
}

function measure(steps: readonly BudgetStep[]): {
  consumption: BudgetConsumption;
  spendKnown: boolean;
} {
  let tokens = 0;
  let spendMicros = 0;
  let spendKnown = true;

  for (const step of steps) {
    tokens += stepTokens(step);
    const spend = stepSpendMicros(step);
    if (spend === null) {
      spendKnown = false;
    } else {
      spendMicros += spend;
    }
  }

  return {
    consumption: { spendMicros: spendKnown ? spendMicros : null, tokens },
    spendKnown,
  };
}

function ceiling(value: number | undefined, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer when provided.`);
  }
  return value;
}

export function createRunBudget(config: RunBudgetConfig): RunBudget {
  const tokens = ceiling(config.tokens, "tokens");
  const spendMicros = ceiling(config.spendMicros, "spendMicros");
  if (tokens === undefined && spendMicros === undefined) {
    throw new Error(
      "A run budget needs at least one ceiling; without one it could never stop a run."
    );
  }

  const stop = (steps: readonly BudgetStep[]): BudgetStop | undefined => {
    const { consumption, spendKnown } = measure(steps);
    if (tokens !== undefined && consumption.tokens >= tokens) {
      return {
        limit: tokens,
        metric: "tokens",
        observed: consumption.tokens,
        reason: "budget",
      };
    }
    if (
      spendMicros !== undefined &&
      spendKnown &&
      consumption.spendMicros !== null &&
      consumption.spendMicros >= spendMicros
    ) {
      return {
        limit: spendMicros,
        metric: "spend_micros",
        observed: consumption.spendMicros,
        reason: "budget",
      };
    }
    return undefined;
  };

  return {
    consumed: (steps) => measure(steps).consumption,
    stop,
    stopWhen: (options) => stop(options.steps) !== undefined,
  };
}

/**
 * The ceiling a run crossed, for the run report.
 *
 * Returns undefined while the run is under every ceiling, so a report can ask
 * after the loop has ended without knowing whether a budget stopped it.
 */
export function describeBudgetStop(
  budget: RunBudget,
  steps: readonly BudgetStep[]
): BudgetStop | undefined {
  return budget.stop(steps);
}
