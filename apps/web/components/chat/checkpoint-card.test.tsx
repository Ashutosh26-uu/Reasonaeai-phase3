import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CheckpointCard } from "./checkpoint-card";
import type { CheckpointScope, TurnCheckpoint } from "./checkpoint-state";

const scope: CheckpointScope = {
  buildSessionId: randomUUID(),
  organizationId: randomUUID(),
  projectId: randomUUID(),
};

const turn: TurnCheckpoint = {
  checkpoint: {
    added: 5,
    baseCommit: null,
    checkpointId: `${scope.organizationId}.${scope.projectId}.${"a".repeat(64)}`,
    commit: "b".repeat(40),
    fileCount: 1,
    files: [{ added: 5, path: "src/index.ts", removed: 0, status: "added" }],
    removed: 0,
    status: "available",
    truncated: false,
    version: 1,
  },
  checkpointId: `${scope.organizationId}.${scope.projectId}.${"a".repeat(64)}`,
  outcome: "succeeded",
  runId: randomUUID(),
  sequence: 2,
};

describe("CheckpointCard", () => {
  it("renders checkpoint summary and Restore Checkpoint button when scope is present", () => {
    const html = renderToStaticMarkup(
      <CheckpointCard onRestore={vi.fn()} scope={scope} turn={turn} />
    );

    expect(html).toContain("Checkpoint saved");
    expect(html).toContain("Restore Checkpoint");
    expect(html).toContain("+5");
    expect(html).toContain("src/index.ts");
  });

  it("does not render Restore Checkpoint button when scope is missing", () => {
    const html = renderToStaticMarkup(<CheckpointCard turn={turn} />);

    expect(html).toContain("Checkpoint saved");
    expect(html).not.toContain("Restore Checkpoint");
  });
});
