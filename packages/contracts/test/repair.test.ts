import { describe, expect, it } from "vitest";
import { RunEventTypeSchema } from "../src/execution-protocol.js";
import {
  DefectClassificationSchema,
  DefectDetectedPayloadSchema,
  DefectIdSchema,
  FailureEnvelopeSchema,
  RepairAttemptedPayloadSchema,
  RepairAttemptSchema,
  RepairFailedPayloadSchema,
  RepairOutcomeSchema,
  RepairVerifiedPayloadSchema,
  SourceLocationSchema,
  TestDiagnosticSchema,
  TestReportSchema,
} from "../src/repair.js";

const defectId = "00000000-0000-4000-8000-000000000010";
const runId = "00000000-0000-4000-8000-000000000011";
const now = "2026-10-04T12:00:00.000Z";

describe("defect and repair contracts", () => {
  it("validates DefectId format as branded UUID", () => {
    expect(DefectIdSchema.parse(defectId)).toBe(defectId);
    expect(() => DefectIdSchema.parse("invalid-uuid")).toThrow();
  });

  it("validates SourceLocationSchema strictly", () => {
    const loc = SourceLocationSchema.parse({
      column: 12,
      file: "src/math.ts",
      line: 42,
    });
    expect(loc.file).toBe("src/math.ts");
    expect(loc.line).toBe(42);
    expect(loc.column).toBe(12);

    expect(() =>
      SourceLocationSchema.parse({
        column: -1,
        file: "src/math.ts",
        line: 0,
      })
    ).toThrow();
  });

  it("validates TestDiagnosticSchema for a failed assertion", () => {
    const diagnostic = TestDiagnosticSchema.parse({
      actual: "3",
      assertionFailure: "expected 3 to equal 4",
      durationMs: 14,
      expected: "4",
      location: { file: "test/math.test.ts", line: 15 },
      message: "AssertionError: expected 3 to equal 4",
      stackFrame: "at test/math.test.ts:15:5",
      status: "failed",
      suite: "math operations",
      testFile: "test/math.test.ts",
      testTitle: "adds 1 + 2 to equal 4",
    });

    expect(diagnostic.status).toBe("failed");
    expect(diagnostic.expected).toBe("4");
    expect(diagnostic.actual).toBe("3");
    expect(diagnostic.location?.line).toBe(15);
  });

  it("validates TestReportSchema with multiple diagnostics", () => {
    const report = TestReportSchema.parse({
      durationMs: 125,
      failedCount: 1,
      framework: "vitest",
      passed: false,
      passedCount: 2,
      rawOutput: "FAIL test/math.test.ts",
      skippedCount: 0,
      summary: "1 of 3 tests failed",
      tests: [
        {
          durationMs: 5,
          message: "adds numbers correctly",
          status: "passed",
          testFile: "test/math.test.ts",
          testTitle: "adds numbers",
        },
        {
          actual: "false",
          assertionFailure: "expected true",
          durationMs: 10,
          expected: "true",
          message: "AssertionError: expected true",
          status: "failed",
          testFile: "test/math.test.ts",
          testTitle: "checks truthiness",
        },
      ],
      totalCount: 3,
    });

    expect(report.passed).toBe(false);
    expect(report.tests.length).toBe(2);
  });

  it("validates FailureEnvelopeSchema and classifies defects correctly", () => {
    const envelope = FailureEnvelopeSchema.parse({
      classification: "assertion_failure",
      defectId,
      diagnostics: [
        {
          message: "expected 'hello' to equal 'world'",
          status: "failed",
          testFile: "test/greeting.test.ts",
          testTitle: "returns friendly greeting",
        },
      ],
      occurredAt: now,
      owningFile: "src/greeting.ts",
      reproductionCommand: "pnpm vitest run test/greeting.test.ts",
      runId,
      summary: "Assertion failure in test/greeting.test.ts",
    });

    expect(envelope.classification).toBe("assertion_failure");
    expect(envelope.owningFile).toBe("src/greeting.ts");
    expect(() =>
      DefectClassificationSchema.parse("invalid_classification")
    ).toThrow();
  });

  it("validates RepairAttemptSchema with attempt bounds", () => {
    const attempt = RepairAttemptSchema.parse({
      attemptNumber: 1,
      brief: "Fix greeting string in src/greeting.ts",
      defectId,
      filesTouched: ["src/greeting.ts"],
      hypothesis: "Return value was hardcoded incorrectly",
      status: "in_progress",
      timestamp: now,
    });

    expect(attempt.attemptNumber).toBe(1);

    expect(() =>
      RepairAttemptSchema.parse({
        attemptNumber: 4, // Max allowed is 3
        brief: "Exceeded bounds",
        defectId,
        filesTouched: [],
        hypothesis: "Too many attempts",
        status: "in_progress",
        timestamp: now,
      })
    ).toThrow();
  });

  it("validates RepairOutcomeSchema for verified and failed repairs", () => {
    const verified = RepairOutcomeSchema.parse({
      attemptNumber: 2,
      defectId,
      fullSuitePassed: true,
      isolatedTestPassed: true,
      status: "verified",
      summary: "Repaired on attempt 2 with zero regressions",
    });
    expect(verified.status).toBe("verified");
    expect(verified.fullSuitePassed).toBe(true);

    const regression = RepairOutcomeSchema.parse({
      attemptNumber: 1,
      defectId,
      fullSuitePassed: false,
      isolatedTestPassed: true,
      status: "regression_detected",
      summary: "Isolated test passed but full suite failed",
    });
    expect(regression.status).toBe("regression_detected");
  });

  it("validates all four defect/repair event payloads", () => {
    const defectPayload = DefectDetectedPayloadSchema.parse({
      classification: "assertion_failure",
      defectId,
      diagnostics: [
        {
          message: "failed assertion",
          status: "failed",
          testFile: "test/a.test.ts",
          testTitle: "test A",
        },
      ],
      failingTestsCount: 1,
      owningFile: "src/a.ts",
      reproductionCommand: "vitest run test/a.test.ts",
      summary: "1 test failed",
    });
    expect(defectPayload.defectId).toBe(defectId);

    const attemptPayload = RepairAttemptedPayloadSchema.parse({
      attemptNumber: 1,
      brief: "Fix a.ts",
      defectId,
      hypothesis: "Wrong return value",
      targetFiles: ["src/a.ts"],
    });
    expect(attemptPayload.attemptNumber).toBe(1);

    const verifiedPayload = RepairVerifiedPayloadSchema.parse({
      attemptNumber: 1,
      defectId,
      fullSuitePassed: true,
      isolatedTestPassed: true,
      summary: "Verified!",
    });
    expect(verifiedPayload.isolatedTestPassed).toBe(true);

    const failedPayload = RepairFailedPayloadSchema.parse({
      attemptNumber: 3,
      defectId,
      escalated: true,
      fullSuitePassed: false,
      isolatedTestPassed: false,
      reason: "Could not fix after 3 attempts",
    });
    expect(failedPayload.escalated).toBe(true);
  });

  it("includes defect and repair event types in RunEventTypeSchema", () => {
    expect(RunEventTypeSchema.parse("run.defect_detected")).toBe(
      "run.defect_detected"
    );
    expect(RunEventTypeSchema.parse("run.repair_attempted")).toBe(
      "run.repair_attempted"
    );
    expect(RunEventTypeSchema.parse("run.repair_verified")).toBe(
      "run.repair_verified"
    );
    expect(RunEventTypeSchema.parse("run.repair_failed")).toBe(
      "run.repair_failed"
    );
  });
});
