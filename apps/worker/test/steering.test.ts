import { randomUUID } from "node:crypto";
import type { Session } from "@mastra/core/agent-controller";
import { RequestContext } from "@mastra/core/request-context";
import { BuildSessionIdSchema } from "@reasonateai/contracts/execution";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
} from "@reasonateai/contracts/identity";
import type { RunSteeringRepository } from "@reasonateai/project-state/steering";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startRunSteering } from "../src/steering.js";

afterEach(() => vi.useRealTimers());

function fixture(action: "deliver" | "discard" = "deliver") {
  vi.useFakeTimers();
  const steeringId = randomUUID();
  const steering: RunSteeringRepository = {
    claim: vi
      .fn<RunSteeringRepository["claim"]>()
      .mockResolvedValueOnce({ message: "Change direction", steeringId })
      .mockResolvedValue(undefined),
    finish: vi.fn<RunSteeringRepository["finish"]>().mockResolvedValue(true),
    request: vi
      .fn<RunSteeringRepository["request"]>()
      .mockResolvedValue(undefined),
    retire: vi
      .fn<RunSteeringRepository["retire"]>()
      .mockResolvedValue(undefined),
  };
  const sendSignal = vi.fn<Session["sendSignal"]>().mockReturnValue({
    accepted: Promise.resolve({ accepted: true, action }),
    id: steeringId,
    type: "user",
  });
  const onFailure = vi.fn();
  const worker = startRunSteering({
    holder: "owner",
    leaseId: randomUUID(),
    logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    onFailure,
    requestContext: new RequestContext(),
    scope: {
      buildSessionId: BuildSessionIdSchema.parse(randomUUID()),
      organizationId: OrganizationIdSchema.parse(randomUUID()),
      projectId: ProjectIdSchema.parse(randomUUID()),
      runId: RunIdSchema.parse(randomUUID()),
    },
    session: { sendSignal },
    store: { steering },
  });
  return { onFailure, sendSignal, steering, steeringId, worker };
}

describe("worker steering delivery", () => {
  it("delivers a user signal in the active run without starting another turn", async () => {
    const input = fixture();
    await vi.advanceTimersByTimeAsync(500);
    expect(input.sendSignal).toHaveBeenCalledWith(
      { contents: "Change direction", id: input.steeringId, type: "user" },
      expect.objectContaining({
        ifActive: { behavior: "deliver" },
        ifIdle: { behavior: "discard" },
        requireDelivery: true,
      })
    );
    expect(input.steering.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        delivered: true,
        holder: "owner",
        steeringId: input.steeringId,
      })
    );
    await input.worker.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(input.sendSignal).toHaveBeenCalledTimes(1);
    expect(input.steering.retire).toHaveBeenCalledTimes(1);
  });

  it("records an idle discard as failure without waking the run", async () => {
    const input = fixture("discard");
    await vi.advanceTimersByTimeAsync(500);
    expect(input.steering.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        delivered: false,
        reason: expect.stringContaining("stopped"),
      })
    );
    await input.worker.stop();
  });

  it("preserves uncertainty after a signal failure and does not expose provider errors", async () => {
    const input = fixture();
    input.sendSignal.mockImplementationOnce(() => ({
      accepted: Promise.reject(new Error("private provider payload")),
      id: input.steeringId,
      type: "user",
    }));
    await vi.advanceTimersByTimeAsync(500);
    expect(input.steering.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        delivered: false,
        reason: expect.stringContaining("may have reached"),
      })
    );
    expect(input.onFailure).not.toHaveBeenCalled();
    await input.worker.stop();
  });

  it("stops the run when durable delivery state cannot be persisted", async () => {
    const input = fixture();
    input.steering.finish = vi
      .fn<RunSteeringRepository["finish"]>()
      .mockRejectedValue(new Error("database unavailable"));
    await vi.advanceTimersByTimeAsync(500);
    expect(input.onFailure).toHaveBeenCalledWith(
      expect.stringContaining("preserve delivery state")
    );
    await input.worker.stop();
  });
});
