import { randomUUID } from "node:crypto";

import { RequestContext } from "@mastra/core/request-context";
import {
  LocalFilesystem,
  WORKSPACE_TOOLS,
  Workspace,
} from "@mastra/core/workspace";
import { describe, expect, it } from "vitest";
import {
  fullWorkspaceTools,
  scoutWorkspaceTools,
} from "../src/agents/definitions/workers.js";
import { materializeDelegatableSubagents } from "../src/agents/materialize.js";
import { REASONATE_CTO_NAME } from "../src/prompts.js";
import { readRunScope, runScopeKeys } from "../src/run-scope.js";
import { createReasonateCtoRuntime } from "../src/runtime.js";

const FULL_LIFECYCLE_PATTERN = /complete product lifecycle/i;
const INVALID_LIMIT_PATTERN = /between 1 and 256/i;
const MISSING_SCOPE_PATTERN = /verified organization/i;

const workspace = new Workspace({
  filesystem: new LocalFilesystem({ basePath: "." }),
  id: "runtime-test-workspace",
  name: "Runtime test workspace",
});

function verifiedRunContext(): RequestContext {
  const requestContext = new RequestContext();
  for (const key of Object.values(runScopeKeys)) {
    requestContext.setRaw(key, randomUUID());
  }
  return requestContext;
}

describe("ReasonateAI CTO composition", () => {
  it("gives the main CTO an unrestricted mode and the full lifecycle identity", async () => {
    const runtime = createReasonateCtoRuntime({
      model: "openai/gpt-5-mini",
      workspace,
    });
    const [mode] = runtime.controller.listModes();

    expect(runtime.mainAgent.name).toBe(REASONATE_CTO_NAME);
    expect(runtime.mainAgent.getDescription()).toMatch(FULL_LIFECYCLE_PATTERN);
    expect(mode?.id).toBe("cto");
    expect(mode?.availableTools).toBeUndefined();
    expect(Object.keys(await runtime.mainAgent.listTools()).sort()).toEqual([
      "edit",
      "read",
      "write",
    ]);
  });

  it("composes the prompt for the verified run and refuses one without a scope", async () => {
    const runtime = createReasonateCtoRuntime({
      model: "openai/gpt-5-mini",
      workspace,
    });
    const requestContext = verifiedRunContext();
    const scope = readRunScope(requestContext);

    const instructions = await runtime.mainAgent.getInstructions({
      requestContext,
    });

    expect(typeof instructions).toBe("string");
    const prompt = instructions as string;
    expect(prompt).toContain(scope.organizationId);
    expect(prompt).toContain(scope.runId);
    expect(prompt).toContain(`reasonate-${scope.organizationId}`);

    let failure: unknown;
    try {
      await runtime.mainAgent.getInstructions();
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(
      failure instanceof Error ? failure.message : String(failure)
    ).toMatch(MISSING_SCOPE_PATTERN);
  });

  it("keeps scout read-only while coder and debugger can edit and execute", () => {
    const materialized = materializeDelegatableSubagents({
      overrides: {
        coder: { maxTurns: 20 },
        debugger: { maxTurns: 24 },
        scout: { maxTurns: 8 },
      },
    });
    const byId = Object.fromEntries(
      materialized.map((entry) => [entry.id, entry])
    );
    const { scout, coder, debugger: debugAgent } = byId;

    expect(scout?.allowedWorkspaceTools).toEqual([...scoutWorkspaceTools]);
    expect(scout?.allowedWorkspaceTools).not.toContain(
      WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE
    );
    expect(scout?.allowedWorkspaceTools).not.toContain(
      WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND
    );
    expect(coder?.allowedWorkspaceTools).toEqual(fullWorkspaceTools);
    expect(debugAgent?.allowedWorkspaceTools).toContain(
      WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE
    );
    expect(debugAgent?.allowedWorkspaceTools).toContain(
      WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND
    );
  });

  it("applies no step cap unless one is configured", async () => {
    const uncapped = createReasonateCtoRuntime({
      model: "openai/gpt-5-mini",
      workspace,
    });

    const uncappedOptions = await uncapped.mainAgent.getDefaultOptions();
    expect(uncappedOptions.maxSteps).toBeUndefined();
    expect(uncapped.limits).toEqual({});
  });

  it("rejects a configured step cap that a runtime cannot rely on", () => {
    expect(() =>
      createReasonateCtoRuntime({
        limits: { mainMaxSteps: 0 },
        model: "openai/gpt-5-mini",
        workspace,
      })
    ).toThrow(INVALID_LIMIT_PATTERN);
  });

  it("applies a configured step cap", async () => {
    const capped = createReasonateCtoRuntime({
      limits: { mainMaxSteps: 40 },
      model: "openai/gpt-5-mini",
      workspace,
    });

    const cappedOptions = await capped.mainAgent.getDefaultOptions();
    expect(cappedOptions.maxSteps).toBe(40);
  });
});
