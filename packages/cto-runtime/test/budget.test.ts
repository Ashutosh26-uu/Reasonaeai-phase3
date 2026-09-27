import { LocalFilesystem, Workspace } from "@mastra/core/workspace";
import { describe, expect, it } from "vitest";
import {
  type BudgetStep,
  createRunBudget,
  describeBudgetStop,
  type RunBudget,
} from "../src/budget.js";
import { createReasonateCtoRuntime } from "../src/runtime.js";

const MODEL = "deepseek/deepseek-flash";

// Patterns stay at module level, as `useTopLevelRegex` requires.
const CEILING_PATTERN = /at least one ceiling/;
const POSITIVE_INTEGER_PATTERN = /positive integer/;

const workspace = new Workspace({
  filesystem: new LocalFilesystem({ basePath: "." }),
  id: "budget-test-workspace",
  name: "Budget test workspace",
});

/** A step that reports the tokens a provider always reports, and nothing else. */
function tokenStep(inputTokens: number, outputTokens: number): BudgetStep {
  return { usage: { inputTokens, outputTokens } };
}

/**
 * The conditions a loop would evaluate, however Mastra hands them over: one
 * condition or an array of them.
 */
function stopConditionsOf(
  stopWhen: unknown
): ((options: { steps: readonly BudgetStep[] }) => boolean)[] {
  if (stopWhen === undefined) {
    return [];
  }
  const conditions = Array.isArray(stopWhen) ? stopWhen : [stopWhen];
  return conditions as ((options: {
    steps: readonly BudgetStep[];
  }) => boolean)[];
}

function budgetOf(runtime: { budget: RunBudget | undefined }): RunBudget {
  const { budget } = runtime;
  if (budget === undefined) {
    throw new Error("Expected the runtime to hold the budget it was given.");
  }
  return budget;
}

describe("run budget", () => {
  it("stops at the step that crosses the token ceiling and describes the stop", () => {
    const budget = createRunBudget({ tokens: 300 });
    const steps: BudgetStep[] = [];
    const observed: number[] = [];

    for (const tokens of [100, 100, 150]) {
      steps.push(tokenStep(tokens - 40, 40));
      observed.push(budget.consumed(steps).tokens);
      if (budget.stopWhen({ steps })) {
        break;
      }
    }

    expect(observed).toEqual([100, 200, 350]);
    expect(describeBudgetStop(budget, steps)).toEqual({
      limit: 300,
      metric: "tokens",
      observed: 350,
      reason: "budget",
    });
  });

  it("leaves a run under every ceiling unaffected", () => {
    const budget = createRunBudget({ spendMicros: 5000, tokens: 1000 });
    const steps: BudgetStep[] = [
      { usage: { costMicros: 1000, inputTokens: 60, outputTokens: 40 } },
      { usage: { costMicros: 1000, inputTokens: 60, outputTokens: 40 } },
    ];

    expect(budget.stopWhen({ steps })).toBe(false);
    expect(budget.consumed(steps)).toEqual({ spendMicros: 2000, tokens: 200 });
    expect(describeBudgetStop(budget, steps)).toBeUndefined();
  });

  it("ignores spend when only a token ceiling is set", () => {
    const budget = createRunBudget({ tokens: 1000 });
    const steps: BudgetStep[] = [
      { usage: { costMicros: 9_000_000, inputTokens: 10, outputTokens: 10 } },
    ];

    expect(budget.stopWhen({ steps })).toBe(false);
    expect(describeBudgetStop(budget, steps)).toBeUndefined();
  });

  it("stops on reported spend", () => {
    const budget = createRunBudget({ spendMicros: 1_500_000 });
    const steps: BudgetStep[] = [
      { usage: { costMicros: 1_000_000, inputTokens: 10, outputTokens: 5 } },
      { usage: { costMicros: 1_000_000, inputTokens: 10, outputTokens: 5 } },
    ];

    expect(budget.stopWhen({ steps })).toBe(true);
    expect(describeBudgetStop(budget, steps)).toEqual({
      limit: 1_500_000,
      metric: "spend_micros",
      observed: 2_000_000,
      reason: "budget",
    });
  });

  it("counts spend a router reports in USD under the provider's metadata", () => {
    const budget = createRunBudget({ spendMicros: 1_500_000 });
    const steps: BudgetStep[] = [
      {
        providerMetadata: { openrouter: { usage: { cost: 2 } } },
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ];

    expect(budget.consumed(steps).spendMicros).toBe(2_000_000);
    expect(describeBudgetStop(budget, steps)?.metric).toBe("spend_micros");
  });

  it("treats a step that reports no cost as unknown, not free", () => {
    const budget = createRunBudget({ spendMicros: 1 });
    const steps: BudgetStep[] = [
      tokenStep(10, 10),
      { usage: { costMicros: 5, inputTokens: 1, outputTokens: 1 } },
    ];

    expect(budget.consumed(steps).spendMicros).toBeNull();
    expect(budget.stopWhen({ steps })).toBe(false);
  });

  it("counts the provider's own total, reasoning tokens included", () => {
    const budget = createRunBudget({ tokens: 100 });
    const steps: BudgetStep[] = [
      { usage: { inputTokens: 10, outputTokens: 10, totalTokens: 120 } },
    ];

    expect(budget.consumed(steps).tokens).toBe(120);
    expect(budget.stopWhen({ steps })).toBe(true);
  });

  it("refuses a budget that could never stop a run", () => {
    expect(() => createRunBudget({})).toThrow(CEILING_PATTERN);
    expect(() => createRunBudget({ tokens: 0 })).toThrow(
      POSITIVE_INTEGER_PATTERN
    );
    expect(() => createRunBudget({ spendMicros: 1.5 })).toThrow(
      POSITIVE_INTEGER_PATTERN
    );
  });
});

describe("runtime budget wiring", () => {
  it("installs the budget beside the step cap and stops the third step", async () => {
    const runtime = createReasonateCtoRuntime({
      budget: { tokens: 300 },
      limits: { mainMaxSteps: 40 },
      model: MODEL,
      workspace,
    });
    const options = await runtime.mainAgent.getDefaultOptions();
    const conditions = stopConditionsOf(options.stopWhen);

    expect(conditions).toHaveLength(2);
    expect(options.maxSteps).toBe(40);

    const steps: BudgetStep[] = [];
    for (const tokens of [100, 100, 150]) {
      steps.push(tokenStep(tokens - 40, 40));
      if (conditions.some((condition) => condition({ steps }))) {
        break;
      }
    }

    expect(steps).toHaveLength(3);
    expect(describeBudgetStop(budgetOf(runtime), steps)).toEqual({
      limit: 300,
      metric: "tokens",
      observed: 350,
      reason: "budget",
    });
  });

  it("adds no stop condition without a budget", async () => {
    const runtime = createReasonateCtoRuntime({ model: MODEL, workspace });
    const options = await runtime.mainAgent.getDefaultOptions();

    expect(runtime.budget).toBeUndefined();
    expect(options.stopWhen).toBeUndefined();
    expect(options.maxSteps).toBeUndefined();
  });
});
