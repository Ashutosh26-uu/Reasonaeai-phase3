import type { RunEventType } from "@reasonateai/contracts/execution-protocol";
import type { TestReport } from "@reasonateai/contracts/repair";
import { describe, expect, it } from "vitest";
import {
  buildReproductionCommand,
  resolveOwningFile,
  SelfDebuggingOrchestrator,
} from "../src/repair/orchestrator.js";

function passingReport(summary = "All tests passed"): TestReport {
  return {
    durationMs: 10,
    failedCount: 0,
    framework: "vitest",
    passed: true,
    passedCount: 3,
    skippedCount: 0,
    summary,
    tests: [
      {
        message: "Passed",
        status: "passed",
        testFile: "test/math.test.ts",
        testTitle: "test 1",
      },
      {
        message: "Passed",
        status: "passed",
        testFile: "test/math.test.ts",
        testTitle: "test 2",
      },
      {
        message: "Passed",
        status: "passed",
        testFile: "test/math.test.ts",
        testTitle: "test 3",
      },
    ],
    totalCount: 3,
  };
}

function failingReport(): TestReport {
  return {
    durationMs: 15,
    failedCount: 1,
    framework: "vitest",
    passed: false,
    passedCount: 2,
    skippedCount: 0,
    summary: "1 of 3 tests failed",
    tests: [
      {
        message: "Passed",
        status: "passed",
        testFile: "test/math.test.ts",
        testTitle: "test 1",
      },
      {
        actual: "3",
        assertionFailure: "expected 3 to equal 4",
        expected: "4",
        location: { column: 5, file: "src/math.ts", line: 12 },
        message: "AssertionError: expected 3 to equal 4",
        stackFrame: "at add (src/math.ts:12:5)\nat test/math.test.ts:8:10",
        status: "failed",
        testFile: "test/math.test.ts",
        testTitle: "adds numbers correctly",
      },
      {
        message: "Passed",
        status: "passed",
        testFile: "test/math.test.ts",
        testTitle: "test 3",
      },
    ],
    totalCount: 3,
  };
}

describe("SelfDebuggingOrchestrator", () => {
  describe("resolveOwningFile", () => {
    it("resolves from source location if not a test file", () => {
      const file = resolveOwningFile({
        location: { file: "src/calculator.ts", line: 10 },
        message: "error",
        status: "failed",
        testFile: "test/calculator.test.ts",
        testTitle: "adds",
      });
      expect(file).toBe("src/calculator.ts");
    });

    it("resolves from stack frame when location is the test file", () => {
      const file = resolveOwningFile({
        location: { file: "test/calculator.test.ts", line: 10 },
        message: "error",
        stackFrame:
          "at compute (src/engine.ts:40:5)\nat test/calculator.test.ts:10:5",
        status: "failed",
        testFile: "test/calculator.test.ts",
        testTitle: "adds",
      });
      expect(file).toBe("src/engine.ts");
    });

    it("infers src counterpart when no source stack frame exists", () => {
      const file = resolveOwningFile({
        message: "error",
        status: "failed",
        testFile: "test/helpers.test.ts",
        testTitle: "helpers",
      });
      expect(file).toBe("src/helpers.ts");
    });

    it("infers src counterpart across monorepo packages and tests folder", () => {
      const monorepoFile = resolveOwningFile({
        message: "error",
        status: "failed",
        testFile: "packages/contracts/test/repair.test.ts",
        testTitle: "contracts",
      });
      expect(monorepoFile).toBe("packages/contracts/src/repair.ts");

      const pluralTestDirFile = resolveOwningFile({
        message: "error",
        status: "failed",
        testFile: "tests/math.test.ts",
        testTitle: "math",
      });
      expect(pluralTestDirFile).toBe("src/math.ts");
    });
  });

  describe("buildReproductionCommand", () => {
    it("builds framework-specific reproduction commands", () => {
      expect(
        buildReproductionCommand({
          framework: "node:test",
          testFile: "test/discount.test.js",
          testTitle: "applies 20 percent discount",
        })
      ).toBe(
        'node --test --test-reporter=tap --test-name-pattern="applies 20 percent discount" test/discount.test.js'
      );

      expect(
        buildReproductionCommand({
          framework: "jest",
          testFile: "test/calc.test.js",
          testTitle: "adds numbers",
        })
      ).toBe('pnpm exec jest -t "adds numbers" test/calc.test.js');

      expect(
        buildReproductionCommand({
          framework: "vitest",
          testFile: "test/unit.test.ts",
          testTitle: "passes unit",
        })
      ).toBe('pnpm vitest run test/unit.test.ts -t "passes unit"');
    });
  });

  describe("orchestrator execution flow", () => {
    it("returns no_defects when test suite passes initially", async () => {
      const orchestrator = new SelfDebuggingOrchestrator({
        applyRepair: async () => ({ filesTouched: [], success: true }),
        runTests: async () => passingReport(),
      });

      const outcome = await orchestrator.execute();
      expect(outcome.status).toBe("no_defects");
    });

    it("detects defect, applies repair, and verifies on attempt 1", async () => {
      const emittedEvents: {
        payload: Record<string, unknown>;
        type: RunEventType;
      }[] = [];
      let testRunCount = 0;

      const orchestrator = new SelfDebuggingOrchestrator({
        applyRepair: (brief) => {
          expect(brief.attemptNumber).toBe(1);
          expect(brief.failingTest.testTitle).toBe("adds numbers correctly");
          expect(brief.owningFile).toBe("src/math.ts");
          return Promise.resolve({
            filesTouched: ["src/math.ts"],
            hypothesis: "Fixed off-by-one error",
            success: true,
          });
        },
        emitEvent: (ev) => {
          emittedEvents.push(ev);
        },
        runTests: (opts) => {
          testRunCount += 1;
          if (testRunCount === 1) {
            // Initial run: failed
            return Promise.resolve(failingReport());
          }
          if (opts.testFile) {
            // Isolated test run: passed
            return Promise.resolve(passingReport("Isolated test passed"));
          }
          // Full suite run: passed
          return Promise.resolve(passingReport("Full suite passed"));
        },
      });

      const outcome = await orchestrator.execute();
      expect(outcome.status).toBe("verified");
      if (outcome.status !== "verified") {
        throw new Error("Expected verified outcome");
      }
      expect(outcome.defectId).toBeDefined();
      expect(outcome.attempts.length).toBe(1);
      expect(outcome.attempts[0]?.status).toBe("verified");
      expect(outcome.attempts[0]?.isolatedTestPassed).toBe(true);
      expect(outcome.attempts[0]?.fullSuitePassed).toBe(true);

      const eventTypes = emittedEvents.map((e) => e.type);
      expect(eventTypes).toContain("run.defect_detected");
      expect(eventTypes).toContain("run.repair_attempted");
      expect(eventTypes).toContain("run.repair_verified");
      expect(eventTypes).not.toContain("run.repair_failed");
    });

    it("retries when attempt 1 fails isolated test and succeeds on attempt 2", async () => {
      const emittedEvents: {
        payload: Record<string, unknown>;
        type: RunEventType;
      }[] = [];
      let attemptsCount = 0;

      const orchestrator = new SelfDebuggingOrchestrator({
        applyRepair: () => {
          attemptsCount += 1;
          return Promise.resolve({
            filesTouched: ["src/math.ts"],
            success: true,
          });
        },
        emitEvent: (ev) => {
          emittedEvents.push(ev);
        },
        runTests: (opts) => {
          if (!opts.testFile && attemptsCount === 0) {
            // Initial failure
            return Promise.resolve(failingReport());
          }
          if (opts.testFile && attemptsCount === 1) {
            // Attempt 1 isolated test still fails
            return Promise.resolve(failingReport());
          }
          // Attempt 2: isolated test passes, and full suite passes
          return Promise.resolve(passingReport());
        },
      });

      const outcome = await orchestrator.execute();
      expect(outcome.status).toBe("verified");
      if (outcome.status !== "verified") {
        throw new Error("Expected verified outcome");
      }
      expect(outcome.attempts.length).toBe(2);
      expect(outcome.attempts[0]?.status).toBe("failed");
      expect(outcome.attempts[1]?.status).toBe("verified");

      const attemptsEvents = emittedEvents.filter(
        (e) => e.type === "run.repair_attempted"
      );
      expect(attemptsEvents.length).toBe(2);
      expect(emittedEvents.some((e) => e.type === "run.repair_verified")).toBe(
        true
      );
    });

    it("detects regression on attempt 1 and recovers on attempt 2", async () => {
      let attempt = 0;

      const orchestrator = new SelfDebuggingOrchestrator({
        applyRepair: () => {
          attempt += 1;
          return Promise.resolve({
            filesTouched: ["src/math.ts"],
            success: true,
          });
        },
        runTests: (opts) => {
          if (attempt === 0) {
            return Promise.resolve(failingReport());
          }
          if (attempt === 1) {
            if (opts.testFile) {
              // Isolated passed
              return Promise.resolve(passingReport());
            }
            // Full suite has regression!
            return Promise.resolve(failingReport());
          }
          // Attempt 2: both pass
          return Promise.resolve(passingReport());
        },
      });

      const outcome = await orchestrator.execute();
      expect(outcome.status).toBe("verified");
      if (outcome.status !== "verified") {
        throw new Error("Expected verified outcome");
      }
      expect(outcome.attempts.length).toBe(2);
      expect(outcome.attempts[0]?.status).toBe("regression_detected");
      expect(outcome.attempts[1]?.status).toBe("verified");
    });

    it("bounds retries to max 3 attempts and escalates with run.repair_failed", async () => {
      const emittedEvents: {
        payload: Record<string, unknown>;
        type: RunEventType;
      }[] = [];

      const orchestrator = new SelfDebuggingOrchestrator({
        applyRepair: async () => ({
          filesTouched: ["src/math.ts"],
          success: true,
        }),
        emitEvent: (ev) => {
          emittedEvents.push(ev);
        },
        runTests: async () => failingReport(),
      });

      const outcome = await orchestrator.execute();
      expect(outcome.status).toBe("failed");
      if (outcome.status !== "failed") {
        throw new Error("Expected failed outcome");
      }
      expect(outcome.escalated).toBe(true);
      expect(outcome.attempts.length).toBe(3);

      const failedEvent = emittedEvents.find(
        (e) => e.type === "run.repair_failed"
      );
      expect(failedEvent).toBeDefined();
      expect(failedEvent?.payload.escalated).toBe(true);
      expect(failedEvent?.payload.attemptNumber).toBe(3);
    });
  });
});
