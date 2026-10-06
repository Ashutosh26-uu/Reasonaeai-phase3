import type { PlanProposal } from "@reasonateai/contracts/execution-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  createSubmitPlanTool,
  SUBMIT_PLAN_TOOL_ID,
  type SubmitPlanOutput,
} from "../src/tools/submit-plan.js";

const sampleProposal: PlanProposal = {
  files: [
    {
      action: "create",
      description: "Define the plan schema",
      path: "src/plan.ts",
    },
    {
      action: "modify",
      description: "Wire plan tool",
      path: "src/runtime.ts",
    },
  ],
  rationale: "Structured planning allows safe human-in-the-loop validation.",
  risk: "medium",
  steps: ["Define schemas", "Implement tool", "Add tests"],
  summary: "Implement structured plan submission flow.",
  title: "Phase 3 Plan Submission Flow",
};

const run = async (
  tool: ReturnType<typeof createSubmitPlanTool>,
  proposal: PlanProposal,
  context: Record<string, unknown>
): Promise<SubmitPlanOutput | undefined> => {
  if (!tool.execute) {
    throw new Error("tool.execute is undefined");
  }
  const result = await tool.execute(proposal, context as never);
  return result as SubmitPlanOutput | undefined;
};

describe("submit_plan tool", () => {
  it("initializes with the correct tool ID and schemas", () => {
    const tool = createSubmitPlanTool();
    expect(tool.id).toBe(SUBMIT_PLAN_TOOL_ID);
    expect(tool.inputSchema).toBeDefined();
    expect(tool.suspendSchema).toBeDefined();
    expect(tool.resumeSchema).toBeDefined();
    expect(tool.outputSchema).toBeDefined();
  });

  it("suspends execution when called without resumeData", async () => {
    const tool = createSubmitPlanTool();
    const suspendMock = vi.fn().mockResolvedValue(undefined);

    const result = await run(tool, sampleProposal, {
      agent: {
        suspend: suspendMock,
      },
    });

    expect(suspendMock).toHaveBeenCalledTimes(1);
    expect(suspendMock.mock.calls[0]?.[0]).toEqual(sampleProposal);
    expect(result).toBeUndefined();
  });

  it("returns error result if suspend mechanism is missing", async () => {
    const tool = createSubmitPlanTool();
    const result = await run(tool, sampleProposal, {});
    expect(result).toMatchObject({
      approved: false,
      isError: true,
    });
  });

  it("returns approved outcome when resumed with approved: true", async () => {
    const tool = createSubmitPlanTool();
    const result = await run(tool, sampleProposal, {
      agent: {
        resumeData: {
          approved: true,
          feedback: "Looks good!",
        },
      },
    });

    expect(result).toMatchObject({
      approved: true,
      feedback: "Looks good!",
      isError: false,
    });
    expect(result?.content).toContain("Plan approved by user");
  });

  it("returns approved outcome when resumed with action: 'approved'", async () => {
    const tool = createSubmitPlanTool();
    const result = await run(tool, sampleProposal, {
      agent: {
        resumeData: {
          action: "approved",
        },
      },
    });

    expect(result).toMatchObject({
      approved: true,
      isError: false,
    });
  });

  it("returns rejected outcome when resumed with approved: false and feedback", async () => {
    const tool = createSubmitPlanTool();
    const result = await run(tool, sampleProposal, {
      agent: {
        resumeData: {
          approved: false,
          feedback: "Please add integration tests.",
        },
      },
    });

    expect(result).toMatchObject({
      approved: false,
      feedback: "Please add integration tests.",
      isError: false,
    });
    expect(result?.content).toContain("Plan was not approved by user");
    expect(result?.content).toContain("Please add integration tests.");
  });

  it("handles stringified JSON resumeData gracefully", async () => {
    const tool = createSubmitPlanTool();
    const result = await run(tool, sampleProposal, {
      agent: {
        resumeData: JSON.stringify({
          approved: true,
        }),
      },
    });

    expect(result).toMatchObject({
      approved: true,
      isError: false,
    });
  });

  it("handles plain string 'approved' resumeData correctly", async () => {
    const tool = createSubmitPlanTool();
    const result = await run(tool, sampleProposal, {
      agent: {
        resumeData: "approved",
      },
    });

    expect(result).toMatchObject({
      approved: true,
      isError: false,
    });
    expect(result?.content).toContain("Plan approved by user");
  });

  it("handles plain string 'rejected' resumeData correctly", async () => {
    const tool = createSubmitPlanTool();
    const result = await run(tool, sampleProposal, {
      agent: {
        resumeData: "rejected",
      },
    });

    expect(result).toMatchObject({
      approved: false,
      isError: false,
    });
    expect(result?.content).toContain("Plan was not approved by user");
  });

  it("handles plain text feedback string as rejection with feedback", async () => {
    const tool = createSubmitPlanTool();
    const result = await run(tool, sampleProposal, {
      agent: {
        resumeData: "Do not modify the database schema without migration",
      },
    });

    expect(result).toMatchObject({
      approved: false,
      feedback: "Do not modify the database schema without migration",
      isError: false,
    });
    expect(result?.content).toContain(
      "Do not modify the database schema without migration"
    );
  });
});
