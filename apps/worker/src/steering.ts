import type { Session } from "@mastra/core/agent-controller";
import type { RequestContext } from "@mastra/core/request-context";
import type { RunScope } from "@reasonateai/cto-runtime/run-scope";
import type { ProjectStateStore } from "@reasonateai/project-state/postgres";
import { describeFailure } from "./failure.js";
import type { Logger } from "./logger.js";

/** Only the lease owner can take a steering message or acknowledge delivery. */
export function startRunSteering(input: {
  holder: string;
  leaseId: string;
  logger: Logger;
  onFailure: (reason: string) => void;
  requestContext: RequestContext;
  scope: RunScope;
  session: Partial<Pick<Session, "sendSignal">>;
  store: Pick<ProjectStateStore, "steering">;
}): { stop: () => Promise<void> } {
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  const lease = {
    buildSessionId: input.scope.buildSessionId,
    holder: input.holder,
    leaseId: input.leaseId,
    runId: input.scope.runId,
    scope: {
      organizationId: input.scope.organizationId,
      projectId: input.scope.projectId,
    },
  };
  const poll = async () => {
    const pending = await input.store.steering.claim(lease);
    if (!pending) {
      return;
    }
    let delivered = false;
    let reason: string | undefined;
    let acceptanceTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!input.session.sendSignal) {
        throw new Error(
          "This CTO runtime does not support active-run steering."
        );
      }
      const signal = input.session.sendSignal(
        {
          contents: pending.message,
          id: pending.steeringId,
          type: "user",
        },
        {
          ifActive: { behavior: "deliver" },
          ifIdle: { behavior: "discard" },
          requestContext: input.requestContext,
          requireDelivery: true,
        }
      );
      const accepted = await Promise.race([
        signal.accepted,
        new Promise<never>((_, reject) => {
          acceptanceTimer = setTimeout(
            () => reject(new Error("Steering acceptance timed out.")),
            15_000
          );
        }),
      ]);
      delivered = accepted.action === "deliver";
      if (!delivered) {
        reason =
          "The CTO stopped before it could receive this steering message.";
      }
    } catch {
      // Provider errors may contain prompt content; persist only the safe boundary failure.
      reason =
        "Steering delivery could not be confirmed. The message may have reached the CTO.";
    } finally {
      clearTimeout(acceptanceTimer);
    }
    const persisted = await input.store.steering.finish({
      ...lease,
      delivered,
      ...pending,
      ...(reason ? { reason } : {}),
    });
    if (!persisted) {
      throw new Error(
        "Steering delivery authority was lost before acknowledgment."
      );
    }
    input.logger.info(
      delivered ? "run.steering.delivered" : "run.steering.failed",
      {
        ...input.scope,
        steeringId: pending.steeringId,
      }
    );
  };
  const tick = () => {
    if (stopped || inFlight) {
      return;
    }
    inFlight = poll()
      .catch((error: unknown) => {
        input.logger.error("run.steering.persistence.failed", {
          ...input.scope,
          failure: describeFailure(error).message,
        });
        input.onFailure(
          "Steering persistence failed; stopping this run to preserve delivery state."
        );
      })
      .finally(() => {
        inFlight = undefined;
      });
  };
  const timer = setInterval(tick, 500);
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
      await input.store.steering.retire(lease);
    },
  };
}
