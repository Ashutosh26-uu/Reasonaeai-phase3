import type { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import {
  type TestFramework,
  TestReportSchema,
} from "@reasonateai/contracts/repair";
import { z } from "zod";
import { parseTestExecutionOutput } from "./test-parser.js";

export interface TestExecutionCommandRequest {
  args: string[];
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface TestExecutionCommandResult {
  durationMs: number;
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface TestToolOptions {
  resolveSandbox?: (requestContext: RequestContext) => Promise<{
    executeCommand?: (
      command: string,
      args: string[],
      options?: {
        cwd?: string;
        env?: Record<string, string>;
        timeout?: number;
      }
    ) => Promise<{
      durationMs?: number;
      executionTimeMs?: number;
      exitCode: number;
      stderr: string;
      stdout: string;
    }>;
  }>;
  runCommand?: (
    request: TestExecutionCommandRequest
  ) => Promise<TestExecutionCommandResult>;
  workspaceRoot?: string;
}

export function buildTestCommand(input: {
  framework?: TestFramework | "auto" | undefined;
  testFile?: string;
  testNamePattern?: string;
  updateSnapshots?: boolean;
}): { args: string[]; command: string; frameworkType: TestFramework } {
  const framework = input.framework ?? "auto";

  if (framework === "node:test" || framework === "tap") {
    const args = ["--test", "--test-reporter=tap"];
    if (input.testNamePattern) {
      args.push(`--test-name-pattern=${input.testNamePattern}`);
    }
    if (input.testFile) {
      args.push(input.testFile);
    }
    return { args, command: "node", frameworkType: "tap" };
  }

  if (framework === "jest") {
    const args = ["exec", "jest", "--json"];
    if (input.testNamePattern) {
      args.push("-t", input.testNamePattern);
    }
    if (input.updateSnapshots) {
      args.push("-u");
    }
    if (input.testFile) {
      args.push(input.testFile);
    }
    return { args, command: "pnpm", frameworkType: "jest" };
  }

  const args = ["exec", "vitest", "run", "--reporter=json"];
  if (input.testNamePattern) {
    args.push("-t", input.testNamePattern);
  }
  if (input.updateSnapshots) {
    args.push("-u");
  }
  if (input.testFile) {
    args.push(input.testFile);
  }
  return { args, command: "pnpm", frameworkType: "vitest" };
}

async function executeTestCommand(
  options: TestToolOptions,
  requestContext: RequestContext,
  command: string,
  args: string[],
  timeoutMs?: number
): Promise<TestExecutionCommandResult> {
  if (options.runCommand) {
    return await options.runCommand({
      args,
      command,
      ...(options.workspaceRoot === undefined
        ? {}
        : { cwd: options.workspaceRoot }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }

  if (options.resolveSandbox) {
    const sandbox = await options.resolveSandbox(requestContext);
    if (!sandbox.executeCommand) {
      throw new Error("The resolved sandbox cannot execute commands.");
    }
    const execRes = await sandbox.executeCommand(command, args, {
      ...(options.workspaceRoot === undefined
        ? {}
        : { cwd: options.workspaceRoot }),
      ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
    });
    return {
      durationMs: execRes.durationMs ?? execRes.executionTimeMs ?? 0,
      exitCode: execRes.exitCode,
      stderr: execRes.stderr,
      stdout: execRes.stdout,
    };
  }

  throw new Error(
    "No test command executor configured: provide runCommand or resolveSandbox."
  );
}

export function createTestExecutionTool(options: TestToolOptions = {}) {
  return createTool({
    description:
      "Execute tests in the workspace (Vitest, Jest, or Node test runner) and extract structured failure diagnostics including failing file, assertion message, expected vs actual values, and source location.",
    execute: async (
      { framework, testFile, testNamePattern, timeoutMs, updateSnapshots },
      context
    ) => {
      const { args, command, frameworkType } = buildTestCommand({
        ...(framework === undefined ? {} : { framework }),
        ...(testFile === undefined ? {} : { testFile }),
        ...(testNamePattern === undefined ? {} : { testNamePattern }),
        ...(updateSnapshots === undefined ? {} : { updateSnapshots }),
      });

      const result = await executeTestCommand(
        options,
        context.requestContext,
        command,
        args,
        timeoutMs
      );

      const report = parseTestExecutionOutput({
        exitCode: result.exitCode,
        framework: frameworkType,
        stderr: result.stderr,
        stdout: result.stdout,
      });

      return {
        ...report,
        durationMs: result.durationMs,
      };
    },
    id: "test_execution",
    inputSchema: z.strictObject({
      framework: z
        .enum(["vitest", "jest", "node:test", "auto"])
        .default("auto")
        .optional(),
      testFile: z.string().min(1).optional(),
      testNamePattern: z.string().min(1).optional(),
      timeoutMs: z
        .number()
        .int()
        .min(100)
        .max(300_000)
        .default(30_000)
        .optional(),
      updateSnapshots: z.boolean().optional(),
    }),
    outputSchema: TestReportSchema,
  });
}
