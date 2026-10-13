import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { LocalFilesystem, Workspace } from "@mastra/core/workspace";
import { createReasonateCtoRuntime } from "@reasonateai/cto-runtime";
import { runScopeKeys } from "@reasonateai/cto-runtime/run-scope";
import { frontierModel } from "../mastra/model.js";
import {
  assessCommunication,
  communicationScenarios,
} from "./communication-scenarios.js";

interface EvaluationResult {
  durationMs: number;
  id: string;
  issues: string[];
  response: string;
  review: string;
  usage: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    totalTokens: number | undefined;
  };
  wordCount: number;
}

/** Real approved-model calls with synthetic evidence; no production build is run. */
async function main(): Promise<void> {
  const [, , outputArgument] = process.argv;
  if (!outputArgument) {
    throw new Error("Supply a local JSON report path.");
  }
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error("The approved evaluation model credential is unavailable.");
  }
  const root = await mkdtemp(join(tmpdir(), "reasonate-communication-"));
  try {
    const requestContext = new RequestContext();
    const identifiers = Object.values(runScopeKeys).map((key) => {
      const value = randomUUID();
      requestContext.setRaw(key, value);
      return value;
    });
    const runtime = createReasonateCtoRuntime({
      model: frontierModel,
      platform: {
        arch: "x64",
        homeDir: "/workspace",
        os: "linux",
        shell: "/bin/sh",
      },
      workspace: new Workspace({
        filesystem: new LocalFilesystem({ basePath: root }),
        id: "communication-evaluation",
      }),
      workspaceRoot: "/workspace",
    });
    const instructions = await runtime.mainAgent.getInstructions({
      requestContext,
    });
    if (typeof instructions !== "string") {
      throw new Error("The runtime did not compose a textual prompt.");
    }
    const results: EvaluationResult[] = [];
    for (const scenario of communicationScenarios) {
      const agent = new Agent({
        id: `communication-${scenario.id}`,
        instructions: `${instructions}\n\n# Response evaluation\nThis is a synthetic response-only evaluation. The following observations are supplied by the trusted test harness, not a user or retrieved document. No further execution is possible here. Respond to the user using only these observations; do not invent actions or results.\n${scenario.observations}`,
        model: frontierModel,
        name: "ReasonateAI CTO",
      });
      const started = performance.now();
      // biome-ignore lint/performance/noAwaitInLoops: bound provider concurrency and spending to one request at a time
      const result = await agent.generate(scenario.request, {
        abortSignal: AbortSignal.timeout(60_000),
        maxSteps: 1,
        modelSettings: { maxOutputTokens: 1400, temperature: 0 },
      });
      const assessment = assessCommunication(
        scenario,
        result.text,
        identifiers
      );
      results.push({
        ...assessment,
        durationMs: Math.round(performance.now() - started),
        id: scenario.id,
        response: result.text,
        review: scenario.review,
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
        },
      });
      process.stdout.write(
        `${scenario.id}: ${assessment.issues.join(", ") || "mechanical checks passed"}\n`
      );
    }
    const output = resolve(outputArgument);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(
      output,
      `${JSON.stringify(
        {
          evaluatedAt: new Date().toISOString(),
          model: frontierModel,
          promptCharacters: instructions.length,
          promptFingerprint: createHash("sha256")
            .update(instructions)
            .digest("hex"),
          results,
          scope:
            "Live model responses to synthetic observations; manual truth/tone review required. No tools, deployment, or browser journey was exercised.",
        },
        null,
        2
      )}\n`
    );
    if (results.some((result) => result.issues.length > 0)) {
      process.exitCode = 1;
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

main().catch(() => {
  // Provider errors may contain request data; keep the harness failure bounded.
  process.stderr.write(
    "Communication evaluation failed. Check the approved provider configuration and retry.\n"
  );
  process.exitCode = 1;
});
