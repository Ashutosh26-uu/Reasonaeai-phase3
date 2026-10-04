import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RunEventType } from "@reasonateai/contracts/execution-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SelfDebuggingOrchestrator } from "../src/repair/orchestrator.js";
import { parseTapOutput } from "../src/repair/test-parser.js";

const execFileAsync = promisify(execFile);

describe("Self-debugging and automatic test repair loop (MVP Criterion #9)", () => {
  let tempWorkspace: string;

  beforeEach(() => {
    tempWorkspace = join(tmpdir(), `reasonate-repair-test-${Date.now()}`);
    mkdirSync(join(tempWorkspace, "src"), { recursive: true });
    mkdirSync(join(tempWorkspace, "test"), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tempWorkspace, { force: true, recursive: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("detects controlled defect, repairs owning code, and re-tests through exact scenario", async () => {
    // 1. Setup controlled defect in source file
    const sourceFilePath = join(tempWorkspace, "src", "discount.js");
    const testFilePath = join(tempWorkspace, "test", "discount.test.js");

    // Defective code: adds discount instead of subtracting
    writeFileSync(
      sourceFilePath,
      `function applyDiscount(price, percentage) {
  // Controlled defect: adding discount instead of subtracting
  return price + (price * percentage / 100);
}

module.exports = { applyDiscount };
`
    );

    // Test file testing the function
    writeFileSync(
      testFilePath,
      `const test = require("node:test");
const assert = require("node:assert");
const { applyDiscount } = require("../src/discount.js");

test("applies 20 percent discount", () => {
  assert.strictEqual(applyDiscount(100, 20), 80);
});

test("applies zero discount", () => {
  assert.strictEqual(applyDiscount(50, 0), 50);
});
`
    );

    const emittedEvents: {
      payload: Record<string, unknown>;
      type: RunEventType;
    }[] = [];

    // Helper to run real Node tests
    const runNodeTests = async (opts: {
      testFile?: string;
      testNamePattern?: string;
    }) => {
      const args = ["--test", "--test-reporter=tap"];
      if (opts.testNamePattern) {
        args.push(`--test-name-pattern=${opts.testNamePattern}`);
      }
      const testFileToRun = opts.testFile
        ? opts.testFile.replace(/\\/g, "/")
        : "test/discount.test.js";
      args.push(testFileToRun);

      try {
        const { stdout, stderr } = await execFileAsync("node", args, {
          cwd: tempWorkspace,
          encoding: "utf8",
        });
        return parseTapOutput(`${stdout}\n${stderr}`, 0);
      } catch (error: unknown) {
        const err = error as {
          code?: number;
          stderr?: string;
          stdout?: string;
        };
        const combined = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
        return parseTapOutput(combined, err.code ?? 1);
      }
    };

    // 2. Instantiate orchestrator
    const orchestrator = new SelfDebuggingOrchestrator({
      applyRepair: (brief) => {
        expect(brief.attemptNumber).toBe(1);
        expect(brief.failingTest.testTitle).toBe("applies 20 percent discount");
        expect(brief.failingTest.message).not.toBe("|-");
        expect(brief.failingTest.message).toContain(
          "Expected values to be strictly equal"
        );
        expect(brief.failingTest.expected).toBe("80");
        expect(brief.failingTest.actual).toBe("120");
        expect(brief.failureEnvelope.classification).toBe("assertion_failure");

        // Repair owning file
        writeFileSync(
          sourceFilePath,
          `function applyDiscount(price, percentage) {
  // Repaired: subtracting discount
  return price - (price * percentage / 100);
}

module.exports = { applyDiscount };
`
        );

        return Promise.resolve({
          filesTouched: ["src/discount.js"],
          hypothesis:
            "Fixed addition operator to subtraction in discount calculation",
          success: true,
        });
      },
      emitEvent: (event) => {
        emittedEvents.push(event);
      },
      runTests: runNodeTests,
    });

    // 3. Execute self-debugging repair loop
    const outcome = await orchestrator.execute();

    // 4. Verify outcomes
    expect(outcome.status).toBe("verified");
    if (outcome.status !== "verified") {
      throw new Error(
        `Expected verified, got ${outcome.status}: ${"reason" in outcome ? outcome.reason : ""}`
      );
    }
    expect(outcome.outcome.status).toBe("verified");
    expect(outcome.outcome.isolatedTestPassed).toBe(true);
    expect(outcome.outcome.fullSuitePassed).toBe(true);
    expect(outcome.outcome.attemptNumber).toBe(1);
    expect(outcome.attempts.length).toBe(1);
    expect(outcome.attempts[0]?.isolatedTestPassed).toBe(true);
    expect(outcome.attempts[0]?.fullSuitePassed).toBe(true);

    // 5. Verify event sequence
    const types = emittedEvents.map((e) => e.type);
    expect(types).toEqual([
      "run.defect_detected",
      "run.repair_attempted",
      "run.repair_verified",
    ]);

    const defectEvent = emittedEvents.find(
      (e) => e.type === "run.defect_detected"
    );
    expect(defectEvent?.payload.classification).toBe("assertion_failure");
    expect(defectEvent?.payload.failingTestsCount).toBe(1);

    const repairVerifiedEvent = emittedEvents.find(
      (e) => e.type === "run.repair_verified"
    );
    expect(repairVerifiedEvent?.payload.isolatedTestPassed).toBe(true);
    expect(repairVerifiedEvent?.payload.fullSuitePassed).toBe(true);
  });
});
