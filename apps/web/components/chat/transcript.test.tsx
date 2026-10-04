import { randomUUID } from "node:crypto";
import { RunEventEnvelopeSchema } from "@reasonateai/contracts/execution-protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_TIMELINE, foldDurable } from "./timeline";
import { Transcript } from "./transcript";

const runId = randomUUID();
const organizationId = randomUUID();
const projectId = randomUUID();
function historyEntry(
  sequence: number,
  type: string,
  payload: Record<string, unknown>
) {
  return RunEventEnvelopeSchema.parse({
    eventId: randomUUID(),
    occurredAt: "2026-10-04T00:00:00.000Z",
    organizationId,
    payload,
    projectId,
    runId,
    schemaVersion: 1,
    sequence,
    type,
  });
}
const requested = historyEntry(1, "run.steering.requested", {
  message: "Use blue\nand keep the layout",
  steeringId: "steer",
});
const delivered = historyEntry(2, "run.steering.delivered", {
  steeringId: "steer",
});
function renderHistory(events: ReturnType<typeof historyEntry>[]) {
  return renderToStaticMarkup(
    <Transcript
      live={false}
      messages={[]}
      onEdit={vi.fn()}
      onRetry={vi.fn()}
      pending={false}
      timeline={events.reduce(foldDurable, EMPTY_TIMELINE)}
    />
  );
}

describe("steering message presentation", () => {
  it.each(["run.completed", "run.failed", "run.cancelled"])(
    "renders delivered steering as a normal message after %s, including history replay",
    (type) => {
      const html = renderHistory([
        requested,
        delivered,
        historyEntry(3, type, {}),
      ]);
      expect(html).toContain("Use blue\nand keep the layout");
      expect(html).toContain("msg-user-text");
      expect(html).not.toContain("Steering ·");
      expect(html).not.toContain("Delivered to the active CTO");
    }
  );
  it("keeps live delivery and waiting status visible", () => {
    expect(renderHistory([requested])).toContain(
      "Waiting for the CTO’s next step"
    );
    expect(renderHistory([requested, delivered])).toContain(
      "Delivered to the active CTO"
    );
  });
  it("keeps unconfirmed delivery visible after a terminal run", () => {
    const failed = historyEntry(2, "run.steering.failed", {
      reason: "Delivery unconfirmed after recovery",
      steeringId: "steer",
    });
    const html = renderHistory([
      requested,
      failed,
      historyEntry(3, "run.completed", {}),
    ]);
    expect(html).toContain("Delivery unconfirmed");
    expect(html).toContain("Delivery unconfirmed after recovery");
    expect(
      renderHistory([requested, historyEntry(3, "run.cancelled", {})])
    ).toContain("Waiting for the CTO’s next step");
  });
});

describe("collapsed tool group presentation", () => {
  it("describes consecutive actions with singular grammar and an accessible count", () => {
    const events = [
      historyEntry(1, "agent.progress", {
        args: { path: "index.html" },
        kind: "tool_start",
        toolCallId: "edit",
        toolName: "edit",
      }),
      historyEntry(2, "agent.progress", {
        isError: false,
        kind: "tool_end",
        result: "Saved",
        toolCallId: "edit",
      }),
      historyEntry(3, "agent.progress", {
        args: { command: "pnpm test" },
        kind: "tool_start",
        toolCallId: "command",
        toolName: "run_command",
      }),
      historyEntry(4, "agent.progress", {
        isError: false,
        kind: "tool_end",
        result: "Passed",
        toolCallId: "command",
      }),
    ];
    const html = renderHistory(events);
    expect(html).toContain("Edited a file, ran a command");
    expect(html).toContain("2 tool calls");
  });
});
