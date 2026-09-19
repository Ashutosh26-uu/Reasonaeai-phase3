import {
  LocalFilesystem,
  WORKSPACE_TOOLS,
  Workspace,
} from "@mastra/core/workspace";
import { describe, expect, it } from "vitest";
import { REASONATE_CTO_NAME } from "../src/prompts.js";
import { createReasonateCtoRuntime } from "../src/runtime.js";
import {
  createCoreSubagents,
  fullWorkspaceTools,
  scoutWorkspaceTools,
} from "../src/subagents.js";

const FULL_LIFECYCLE_PATTERN = /complete product lifecycle/i;
const DEPLOYED_PRODUCT_PATTERN = /deployed, usable product/i;
const INVALID_LIMIT_PATTERN = /between 1 and 256/i;

const workspace = new Workspace({
  filesystem: new LocalFilesystem({ basePath: "." }),
  id: "runtime-test-workspace",
  name: "Runtime test workspace",
});

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
    expect(await runtime.mainAgent.getInstructions()).toMatch(
      DEPLOYED_PRODUCT_PATTERN
    );
  });

  it("keeps scout read-only while coder and debugger can edit and execute", () => {
    const [scout, coder, debugAgent] = createCoreSubagents({
      maxCoderSteps: 20,
      maxDebuggerSteps: 24,
      maxScoutSteps: 8,
    });

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

  it("rejects unbounded agent loops at construction", () => {
    expect(() =>
      createReasonateCtoRuntime({
        limits: { mainMaxSteps: 0 },
        model: "openai/gpt-5-mini",
        workspace,
      })
    ).toThrow(INVALID_LIMIT_PATTERN);
  });
});
