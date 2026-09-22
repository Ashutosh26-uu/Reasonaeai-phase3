import { randomUUID } from "node:crypto";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

import { RequestContext } from "@mastra/core/request-context";
import { createReasonateCtoRuntime } from "@reasonateai/cto-runtime";
import { runScopeKeys } from "@reasonateai/cto-runtime/run-scope";
import { reasonateBuildWorkspace } from "../mastra/workspace.js";

const model = process.env.MASTRA_MODEL ?? "deepseek/deepseek-flash";

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

async function main(): Promise<void> {
  const requestContext = createRunContext();
  const runtime = createReasonateCtoRuntime({
    model,
    workspace: reasonateBuildWorkspace,
    workspaceRoot: "/workspace",
  });
  const input = createInterface({
    input: stdin,
    output: stdout,
    terminal: true,
  });
  const transcript: string[] = [];

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
      stdout.write("\nCTO: ");
      try {
        const result = await runtime.mainAgent.generate(request, {
          requestContext,
        });
        const response = result.text || "The model returned no text.";
        transcript.push(`User: ${prompt}\n\nCTO: ${response}`);
        if (transcript.length > 8) {
          transcript.shift();
        }
        stdout.write(`${response}\n\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stdout.write(`Run failed: ${message}\n\n`);
      }
    }
  } finally {
    input.close();
  }
}

await main();
