import { describe, expect, it } from "vitest";
import {
  classifyTestFailure,
  cleanStackTrace,
  extractExpectedActual,
  extractSourceLocation,
  parseHumanReadableOutput,
  parseTapOutput,
  parseTestExecutionOutput,
  stripAnsi,
} from "../src/repair/test-parser.js";

describe("test execution output parser", () => {
  describe("stripAnsi and cleanStackTrace", () => {
    it("strips ANSI color codes from terminal text", () => {
      const colored =
        "\u001b[31mFAIL\u001b[39m \u001b[2msrc/index.test.ts\u001b[22m";
      expect(stripAnsi(colored)).toBe("FAIL src/index.test.ts");
    });

    it("cleans internal runner and node_modules frames from stack trace", () => {
      const rawStack = `AssertionError: expected 3 to equal 4
  at /workspace/src/math.ts:10:15
  at /workspace/node_modules/vitest/dist/chunk-runtime.js:123:45
  at node:internal/process/task_queues:95:5
  at /workspace/test/math.test.ts:25:7`;

      const cleaned = cleanStackTrace(rawStack);
      expect(cleaned).toContain("/workspace/src/math.ts:10:15");
      expect(cleaned).toContain("/workspace/test/math.test.ts:25:7");
      expect(cleaned).not.toContain("node_modules/vitest");
      expect(cleaned).not.toContain("node:internal");
    });
  });

  describe("source location extraction", () => {
    it("extracts source location from stack trace line", () => {
      const stack =
        "at calculateTotal (/workspace/src/cart.ts:42:15)\nat runner (node_modules/vitest:1:1)";
      const loc = extractSourceLocation(stack);
      expect(loc).toBeDefined();
      expect(loc?.file).toBe("/workspace/src/cart.ts");
      expect(loc?.line).toBe(42);
      expect(loc?.column).toBe(15);
    });

    it("extracts relative posix file:line", () => {
      const text = "error at src/calculator.ts:18";
      const loc = extractSourceLocation(text);
      expect(loc).toBeDefined();
      expect(loc?.file).toBe("src/calculator.ts");
      expect(loc?.line).toBe(18);
    });
  });

  describe("expected vs actual extraction", () => {
    it("extracts Expected / Received format", () => {
      const message = `AssertionError: expected values to match
Expected: "42"
Received: "40"`;
      const values = extractExpectedActual(message);
      expect(values.expected).toBe('"42"');
      expect(values.actual).toBe('"40"');
    });

    it("extracts diff format (- Expected / + Received)", () => {
      const diffMsg = `- Expected
+ Received
- "hello"
+ "world"`;
      const values = extractExpectedActual(diffMsg);
      expect(values.expected).toBe('"hello"');
      expect(values.actual).toBe('"world"');
    });

    it("extracts 'expected X to equal Y' format", () => {
      const msg = "AssertionError: expected 3 to equal 4";
      const values = extractExpectedActual(msg);
      expect(values.actual).toBe("3");
      expect(values.expected).toBe("4");
    });
  });

  describe("failure classification", () => {
    it("classifies assertion errors", () => {
      expect(
        classifyTestFailure({
          message: "AssertionError: expected false to be true",
        })
      ).toBe("assertion_failure");
      expect(
        classifyTestFailure({
          rawError: "ERR_ASSERTION: values differ",
        })
      ).toBe("assertion_failure");
    });

    it("classifies type errors", () => {
      expect(
        classifyTestFailure({
          message: "TypeError: user.getName is not a function",
        })
      ).toBe("type_error");
    });

    it("classifies syntax errors", () => {
      expect(
        classifyTestFailure({
          message: "SyntaxError: Unexpected token '{'",
        })
      ).toBe("syntax_error");
    });

    it("classifies timeout errors", () => {
      expect(
        classifyTestFailure({
          message: "Error: Test timed out in 5000ms",
        })
      ).toBe("timeout");
    });

    it("classifies unhandled rejections", () => {
      expect(
        classifyTestFailure({
          message: "UnhandledRejection: database connection failed",
        })
      ).toBe("unhandled_rejection");
    });

    it("falls back to runtime_error for generic failed status", () => {
      expect(
        classifyTestFailure({
          message: "Error: Failed to process request",
          status: "failed",
        })
      ).toBe("runtime_error");
    });
  });

  describe("Vitest / Jest JSON output parsing", () => {
    it("parses valid Vitest JSON output with passing and failing tests", () => {
      const vitestJson = JSON.stringify({
        numFailedTests: 1,
        numPassedTests: 1,
        numTotalTests: 2,
        startTime: 1_728_000_000_000,
        testResults: [
          {
            assertionResults: [
              {
                ancestorTitles: ["Math suite"],
                duration: 5,
                fullName: "Math suite adds numbers",
                status: "passed",
                title: "adds numbers",
              },
              {
                ancestorTitles: ["Math suite"],
                duration: 12,
                failureMessages: [
                  "AssertionError: expected 3 to equal 4\n  at /workspace/src/math.ts:15:20\n  at /workspace/test/math.test.ts:8:10",
                ],
                fullName: "Math suite subtracts numbers",
                location: { column: 10, line: 8 },
                status: "failed",
                title: "subtracts numbers",
              },
            ],
            name: "test/math.test.ts",
            status: "failed",
          },
        ],
      });

      const report = parseTestExecutionOutput({
        exitCode: 1,
        stdout: `Console prefix before json\n${vitestJson}\nTrailing logs`,
      });

      expect(report.passed).toBe(false);
      expect(report.totalCount).toBe(2);
      expect(report.passedCount).toBe(1);
      expect(report.failedCount).toBe(1);
      expect(report.tests.length).toBe(2);

      const failedTest = report.tests.find((t) => t.status === "failed");
      expect(failedTest).toBeDefined();
      expect(failedTest?.testTitle).toBe("subtracts numbers");
      expect(failedTest?.suite).toBe("Math suite");
      expect(failedTest?.expected).toBe("4");
      expect(failedTest?.actual).toBe("3");
      expect(failedTest?.location?.file).toBe("test/math.test.ts");
      expect(failedTest?.location?.line).toBe(8);
      expect(failedTest?.stackFrame).toContain("src/math.ts:15:20");
    });
  });

  describe("TAP output parsing", () => {
    it("parses Node test runner TAP output", () => {
      const tap = `TAP version 13
# Subtest: test/calculator.test.ts
    # Subtest: multiplies numbers
    ok 1 - multiplies numbers
      ---
      duration_ms: 1.1
      ...
    # Subtest: divides numbers
    not ok 2 - divides numbers
      ---
      duration_ms: 2.3
      failureType: 'testCodeFailure'
      error: 'expected 5 to equal 6'
      code: 'ERR_ASSERTION'
      expected: 6
      actual: 5
      stack: |-
        at TestContext.<anonymous> (test/calculator.test.ts:25:12)
      ...
    1..2
not ok 1 - test/calculator.test.ts
  ---
  duration_ms: 5.0
  ...
1..1`;

      const report = parseTapOutput(tap);
      expect(report.passed).toBe(false);
      expect(report.totalCount).toBe(2);
      expect(report.passedCount).toBe(1);
      expect(report.failedCount).toBe(1);

      const failedTest = report.tests.find((t) => t.status === "failed");
      expect(failedTest).toBeDefined();
      expect(failedTest?.testTitle).toBe("divides numbers");
      expect(failedTest?.message).toBe("expected 5 to equal 6");
      expect(failedTest?.expected).toBe("6");
      expect(failedTest?.actual).toBe("5");
      expect(failedTest?.location?.file).toBe("test/calculator.test.ts");
      expect(failedTest?.location?.line).toBe(25);
    });

    it("parses multiline YAML error blocks in TAP without setting '|-' as message", () => {
      const tap = `TAP version 13
# Subtest: test/multiline.test.js
    # Subtest: asserts deeply
    not ok 1 - asserts deeply
      ---
      duration_ms: 1.9
      failureType: 'testCodeFailure'
      error: |-
        Expected values to be strictly equal:

        2 !== 3
      code: 'ERR_ASSERTION'
      expected: 3
      actual: 2
      stack: |-
        at TestContext.<anonymous> (test/multiline.test.js:10:5)
      ...
    # Subtest: skipped test
    ok 2 - skipped test # SKIP reason
      ---
      duration_ms: 0.2
      ...
    1..2
not ok 1 - test/multiline.test.js
  ---
  duration_ms: 5.0
  ...
1..1`;

      const report = parseTapOutput(tap, 1);
      expect(report.passed).toBe(false);
      expect(report.failedCount).toBe(1);
      expect(report.skippedCount).toBe(1);
      expect(report.passedCount).toBe(0);

      const failedTest = report.tests.find((t) => t.status === "failed");
      expect(failedTest).toBeDefined();
      expect(failedTest?.message).toBe("Expected values to be strictly equal:");
      expect(failedTest?.assertionFailure).toContain("2 !== 3");
      expect(failedTest?.expected).toBe("3");
      expect(failedTest?.actual).toBe("2");

      const skippedTest = report.tests.find((t) => t.status === "skipped");
      expect(skippedTest).toBeDefined();
      expect(skippedTest?.testTitle).toBe("skipped test");
      expect(skippedTest?.message).toBe("Skipped: reason");
    });
  });

  describe("Robust JSON and diff parsing", () => {
    it("parses Vitest JSON even when surrounded by console.log output with JSON", () => {
      const mixed = `
[info] Build completed
console.log({ user: "test", debug: true })
{"numTotalTests":1,"numPassedTests":1,"numFailedTests":0,"testResults":[{"name":"test/unit.test.ts","status":"passed","assertionResults":[{"title":"works","status":"passed"}]}]}
console.log({ after: 123 })
`;
      const report = parseTestExecutionOutput({
        exitCode: 0,
        framework: "vitest",
        stdout: mixed,
      });

      expect(report.passed).toBe(true);
      expect(report.framework).toBe("vitest");
      expect(report.totalCount).toBe(1);
      expect(report.passedCount).toBe(1);
    });

    it("extracts expected and actual from Vitest/Jest diff with header counts and blank lines", () => {
      const diff = `- Expected  - 1
+ Received  + 1

- 4
+ 3`;
      const values = extractExpectedActual(diff);
      expect(values.expected).toBe("4");
      expect(values.actual).toBe("3");
    });

    it("extracts expected and actual from 'expected X to be Y' assertions", () => {
      const msg = "AssertionError: expected false to be true";
      const values = extractExpectedActual(msg);
      expect(values.actual).toBe("false");
      expect(values.expected).toBe("true");
    });

    it("marks report failed when exitCode is non-zero even if JSON or TAP reported 0 test failures", () => {
      const crashedTap = `TAP version 13
ok 1 - passes initially
1..1
# Node process crashed with unhandled rejection`;

      const report = parseTapOutput(crashedTap, 1);
      expect(report.passed).toBe(false);
      expect(report.failedCount).toBe(1);
      expect(report.tests.some((t) => t.status === "failed")).toBe(true);
    });
  });

  describe("Human-readable terminal fallback parsing", () => {
    it("parses terminal test failures when JSON is absent", () => {
      const output = `
 FAIL  test/greeting.test.ts > Greeting > formats formal greeting
AssertionError: expected 'Hi' to equal 'Hello'
  - Expected: "Hello"
  + Received: "Hi"
    at test/greeting.test.ts:14:18

Tests: 1 failed, 2 passed, 3 total
`;

      const report = parseHumanReadableOutput(output, 1);
      expect(report.passed).toBe(false);
      expect(report.failedCount).toBe(1);
      const [failed] = report.tests;
      expect(failed?.testTitle).toBe("Greeting > formats formal greeting");
      expect(failed?.expected).toBe('"Hello"');
      expect(failed?.actual).toBe('"Hi"');
      expect(failed?.location?.file).toBe("test/greeting.test.ts");
      expect(failed?.location?.line).toBe(14);
    });

    it("handles non-zero exit code with generic error message", () => {
      const report = parseTestExecutionOutput({
        exitCode: 1,
        stderr: "Cannot find module 'non-existent'\n  at src/app.ts:3:5",
        stdout: "",
      });

      expect(report.passed).toBe(false);
      expect(report.failedCount).toBe(1);
      expect(report.tests[0]?.message).toContain("Cannot find module");
      expect(report.tests[0]?.location?.file).toBe("src/app.ts");
    });
  });
});
