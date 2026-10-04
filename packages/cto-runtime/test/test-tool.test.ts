import { RequestContext } from "@mastra/core/request-context";
import type { TestReport } from "@reasonateai/contracts/repair";
import { describe, expect, it } from "vitest";
import {
  buildTestCommand,
  createTestExecutionTool,
  escapeRegex,
} from "../src/repair/test-tool.js";

const NO_EXECUTOR_RE = /No test command executor configured/;

describe("structured test execution tool", () => {
  describe("buildTestCommand", () => {
    it("builds vitest command by default", () => {
      const cmd = buildTestCommand({
        testFile: "test/unit.test.ts",
        testNamePattern: "handles edge case",
        updateSnapshots: true,
      });

      expect(cmd.command).toBe("pnpm");
      expect(cmd.args).toEqual([
        "exec",
        "vitest",
        "run",
        "--reporter=json",
        "-t",
        "handles edge case",
        "-u",
        "test/unit.test.ts",
      ]);
      expect(cmd.frameworkType).toBe("vitest");
    });

    it("builds jest command when specified", () => {
      const cmd = buildTestCommand({
        framework: "jest",
        testFile: "test/math.spec.js",
        testNamePattern: "adds numbers",
      });

      expect(cmd.command).toBe("pnpm");
      expect(cmd.args).toEqual([
        "exec",
        "jest",
        "--json",
        "-t",
        "adds numbers",
        "test/math.spec.js",
      ]);
      expect(cmd.frameworkType).toBe("jest");
    });

    it("builds node:test command when specified", () => {
      const cmd = buildTestCommand({
        framework: "node:test",
        testFile: "test/node.test.mjs",
        testNamePattern: "runs in node",
      });

      expect(cmd.command).toBe("node");
      expect(cmd.args).toEqual([
        "--test",
        "--test-reporter=tap",
        "--test-name-pattern=runs in node",
        "test/node.test.mjs",
      ]);
      expect(cmd.frameworkType).toBe("tap");
    });

    it("escapes regex special characters safely", () => {
      expect(escapeRegex("adds 1 + 2 (returns 3)")).toBe(
        "adds 1 \\+ 2 \\(returns 3\\)"
      );
      expect(escapeRegex("checks [user.id]?")).toBe(
        "checks \\[user\\.id\\]\\?"
      );
    });
  });

  describe("tool execution", () => {
    const dummyContext = { requestContext: new RequestContext() } as never;
    const run = async (
      tool: ReturnType<typeof createTestExecutionTool>,
      args: Parameters<NonNullable<(typeof tool)["execute"]>>[0]
    ) => {
      if (!tool.execute) {
        throw new Error("tool.execute is undefined");
      }
      return (await tool.execute(args, dummyContext)) as TestReport;
    };

    it("executes tests using runCommand and returns parsed report", async () => {
      const vitestOutput = JSON.stringify({
        numFailedTests: 0,
        numPassedTests: 2,
        numTotalTests: 2,
        testResults: [
          {
            assertionResults: [
              { status: "passed", title: "test 1" },
              { status: "passed", title: "test 2" },
            ],
            name: "test/example.test.ts",
            status: "passed",
          },
        ],
      });

      const tool = createTestExecutionTool({
        runCommand: ({ args, command }) => {
          expect(command).toBe("pnpm");
          expect(args).toContain("test/example.test.ts");
          return Promise.resolve({
            durationMs: 45,
            exitCode: 0,
            stderr: "",
            stdout: vitestOutput,
          });
        },
      });

      const report = await run(tool, { testFile: "test/example.test.ts" });

      expect(report.passed).toBe(true);
      expect(report.totalCount).toBe(2);
      expect(report.passedCount).toBe(2);
      expect(report.failedCount).toBe(0);
      expect(report.durationMs).toBe(45);
    });

    it("executes tests via resolveSandbox", async () => {
      const tool = createTestExecutionTool({
        resolveSandbox: () =>
          Promise.resolve({
            executeCommand: (cmd, _args) => {
              expect(cmd).toBe("pnpm");
              return Promise.resolve({
                durationMs: 120,
                exitCode: 1,
                stderr:
                  "FAIL test/failed.test.ts\nAssertionError: expected 1 to equal 2",
                stdout: "",
              });
            },
          }),
      });

      const report = await run(tool, { testFile: "test/failed.test.ts" });

      expect(report.passed).toBe(false);
      expect(report.failedCount).toBe(1);
      const [firstTest] = report.tests;
      expect(firstTest?.assertionFailure).toContain("expected 1 to equal 2");
    });

    it("throws if no command executor is configured", async () => {
      const tool = createTestExecutionTool({});
      await expect(run(tool, {})).rejects.toThrow(NO_EXECUTOR_RE);
    });
  });
});
