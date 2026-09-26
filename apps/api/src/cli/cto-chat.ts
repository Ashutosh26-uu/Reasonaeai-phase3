import { randomUUID } from "node:crypto";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

import { RequestContext } from "@mastra/core/request-context";
import { createReasonateCtoRuntime } from "@reasonateai/cto-runtime";
import { readRunScope, runScopeKeys } from "@reasonateai/cto-runtime/run-scope";
import { frontierModel } from "../mastra/model.js";
import {
  buildSandboxEnvironment,
  reasonateBuildWorkspace,
  SANDBOX_WORKING_DIRECTORY,
} from "../mastra/workspace.js";
import { describeFailure, reportControllerRun } from "./run-report.js";

const model = process.env.MASTRA_MODEL ?? frontierModel;

function createRunContext(): RequestContext {
  const requestContext = new RequestContext();
  requestContext.setRaw(runScopeKeys.organizationId, randomUUID());
  requestContext.setRaw(runScopeKeys.projectId, randomUUID());
  requestContext.setRaw(runScopeKeys.buildSessionId, randomUUID());
  requestContext.setRaw(runScopeKeys.runId, randomUUID());
  return requestContext;
}

function printHelp(): void {
  stdout.write(
    "Commands: /help shows this message, /scope shows the isolated run identifiers, /quit exits.\n"
  );
}

function reportFailure(error: unknown): void {
  const failure = describeFailure(error);
  stdout.write(`Run failed: ${failure.message}\n`);
  if (failure.shape) {
    stdout.write(`Rejected request shape:\n${failure.shape}\n`);
  }
  stdout.write("\n");
}

async function main(): Promise<void> {
  const requestContext = createRunContext();
  const runtime = createReasonateCtoRuntime({
    ...buildSandboxEnvironment,
    model,
    workspace: reasonateBuildWorkspace,
    workspaceRoot: SANDBOX_WORKING_DIRECTORY,
  });
  const input = createInterface({
    input: stdin,
    output: stdout,
    terminal: true,
  });
  const transcript: string[] = [];

  /**
   * The run is driven through a controller session, not the agent directly: the
   * session is what holds the delegation tool, the mode, the thread, and the
   * approval gates. The project is the memory resource, so sessions of one
   * project share durable state, and the build session is the isolation scope,
   * so two sessions over one project never share a run loop or a thread.
   */
  await runtime.controller.init();
  const scope = readRunScope(requestContext);
  const session = await runtime.controller.createSession({
    requestContext,
    resourceId: scope.projectId,
    scope: scope.buildSessionId,
  });

  stdout.write(`ReasonateAI CTO sandbox chat\nModel: ${model}\n`);
  stdout.write(
    "Each launch uses one new isolated Docker workspace. Type /help for commands.\n\n"
  );

  try {
    for await (const line of input) {
      const prompt = line.trim();
      if (prompt === "") {
        continue;
      }
      if (prompt === "/quit" || prompt === "/exit") {
        break;
      }
      if (prompt === "/help") {
        printHelp();
        continue;
      }
      if (prompt === "/scope") {
        stdout.write(
          `${JSON.stringify(
            Object.fromEntries(
              Object.entries(runScopeKeys).map(([name, key]) => [
                name,
                requestContext.getRaw(key),
              ])
            )
          )}\n`
        );
        continue;
      }

      const request = [...transcript, `User: ${prompt}`, "CTO:"].join("\n\n");
      try {
        const report = await reportControllerRun(
          session,
          { content: request, requestContext },
          (text) => stdout.write(text)
        );
        if (report.error === undefined) {
          const response = report.text.trim() || "The model returned no text.";
          transcript.push(`User: ${prompt}\n\nCTO: ${response}`);
          if (transcript.length > 8) {
            transcript.shift();
          }
        } else {
          stdout.write(`Run failed: ${report.error}\n`);
        }
        stdout.write("\n");
      } catch (error) {
        reportFailure(error);
      }
    }
  } finally {
    input.close();
  }
}

await main();
