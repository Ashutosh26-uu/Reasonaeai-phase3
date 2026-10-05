import type { PlanProposal } from "@reasonateai/contracts/execution-protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PlanCard } from "./plan-card";

const mockPlan: PlanProposal = {
  files: [
    { action: "create", description: "Config file", path: "src/config.ts" },
    { action: "modify", description: "Main entry", path: "src/main.ts" },
    { action: "delete", description: "Deprecated code", path: "src/old.ts" },
  ],
  rationale: "Refactor system architecture for reliability",
  risk: "high",
  steps: ["Step 1: Create config", "Step 2: Update main", "Step 3: Remove old"],
  summary: "Comprehensive architecture refactoring",
  title: "Architecture Refactor Plan",
};

describe("PlanCard", () => {
  it("renders plan details, risk badge, steps, and affected files", () => {
    const html = renderToStaticMarkup(
      <PlanCard onApprove={vi.fn()} onReject={vi.fn()} plan={mockPlan} />
    );

    expect(html).toContain("Architecture Refactor Plan");
    expect(html).toContain("Comprehensive architecture refactoring");
    expect(html).toContain("Refactor system architecture for reliability");
    expect(html).toContain("high risk");
    expect(html).toContain("src/config.ts");
    expect(html).toContain("create");
    expect(html).toContain("src/main.ts");
    expect(html).toContain("modify");
    expect(html).toContain("src/old.ts");
    expect(html).toContain("delete");
    expect(html).toContain("Step 1: Create config");
    expect(html).toContain("Approve Plan");
    expect(html).toContain("Reject with Feedback");
  });

  it("renders resolved approved state", () => {
    const html = renderToStaticMarkup(
      <PlanCard plan={mockPlan} resolved={{ approved: true }} />
    );

    expect(html).toContain("Plan Approved");
    expect(html).not.toContain("Approve Plan");
    expect(html).not.toContain("Reject with Feedback");
  });

  it("renders resolved rejected state with feedback", () => {
    const html = renderToStaticMarkup(
      <PlanCard
        plan={mockPlan}
        resolved={{
          approved: false,
          feedback: "Please do not delete old.ts yet",
        }}
      />
    );

    expect(html).toContain("Plan Rejected");
    expect(html).toContain("Feedback: Please do not delete old.ts yet");
    expect(html).not.toContain("Approve Plan");
  });
});
