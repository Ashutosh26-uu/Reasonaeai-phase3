import { randomUUID } from "node:crypto";
import type { BuildSessionId } from "@reasonateai/contracts/execution";
import type { RunEventType } from "@reasonateai/contracts/execution-protocol";
import type { RunId, UserId } from "@reasonateai/contracts/identity";
import type { RunSteeringAccepted } from "@reasonateai/contracts/steering";
import type { PoolClient } from "pg";
import type { TenantScope } from "./postgres.js";

interface SteeringScope {
  buildSessionId: BuildSessionId;
  runId: RunId;
  scope: TenantScope;
}
interface SteeringLease extends SteeringScope {
  holder: string;
  leaseId: string;
}
export interface SteeringDelivery {
  message: string;
  steeringId: string;
}
export interface RunSteeringRepository {
  claim: (input: SteeringLease) => Promise<SteeringDelivery | undefined>;
  finish: (
    input: SteeringLease & {
      delivered: boolean;
      reason?: string;
      steeringId: string;
    }
  ) => Promise<boolean>;
  request: (
    input: SteeringScope & {
      idempotencyKey: string;
      message: string;
      requestedByUserId: UserId;
    }
  ) => Promise<RunSteeringAccepted | undefined>;
  retire: (input: SteeringLease) => Promise<void>;
}

export class SteeringConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SteeringConflictError";
  }
}

interface SteeringRow {
  message: string;
  status: RunSteeringAccepted["status"];
  steering_id: string;
}

/** Run locking serializes admission with cancellation and terminal transitions. */
async function lockRun(client: PoolClient, input: SteeringScope) {
  const result = await client.query<{ active: boolean }>(
    `select status = 'running' and cancellation_requested_at is null as active
       from runs where run_id = $1 and organization_id = $2 and project_id = $3
       and build_session_id = $4 for update`,
    [
      input.runId,
      input.scope.organizationId,
      input.scope.projectId,
      input.buildSessionId,
    ]
  );
  return {
    active: result.rows[0]?.active === true,
    found: result.rows.length === 1,
  };
}

async function ownsLease(client: PoolClient, input: SteeringLease) {
  const result = await client.query(
    `select 1 from run_leases where run_id = $1 and lease_id = $2
       and holder = $3 and expires_at > now() for update`,
    [input.runId, input.leaseId, input.holder]
  );
  return result.rows.length === 1;
}

export function createRunSteeringRepository(deps: {
  appendEvent: (
    client: PoolClient,
    input: {
      payload: Record<string, unknown>;
      runId: RunId;
      scope: TenantScope;
      type: RunEventType;
    }
  ) => Promise<unknown>;
  withTransaction: <T>(run: (client: PoolClient) => Promise<T>) => Promise<T>;
}): RunSteeringRepository {
  const event = async (
    client: PoolClient,
    input: SteeringScope,
    type: RunEventType,
    payload: Record<string, unknown>
  ) => {
    await deps.appendEvent(client, {
      payload,
      runId: input.runId,
      scope: input.scope,
      type,
    });
  };
  return {
    claim: async (input) =>
      await deps.withTransaction(async (client) => {
        if (
          !(
            (await lockRun(client, input)).active &&
            (await ownsLease(client, input))
          )
        ) {
          return;
        }
        // Never replay an ambiguous send after a takeover: it may have reached the model.
        const abandoned = await client.query<{ steering_id: string }>(
          `update run_steering set status = 'failed', updated_at = now()
         where run_id = $1 and status = 'delivering' and delivery_lease_id <> $2
         returning steering_id`,
          [input.runId, input.leaseId]
        );
        for (const row of abandoned.rows) {
          // biome-ignore lint/performance/noAwaitInLoops: sequence allocation must remain ordered in this transaction
          await event(client, input, "run.steering.failed", {
            reason:
              "Delivery was interrupted; the earlier message may have reached the CTO.",
            steeringId: row.steering_id,
          });
        }
        const result = await client.query<SteeringRow>(
          `update run_steering set status = 'delivering', delivery_lease_id = $2, updated_at = now()
         where steering_id = (select steering_id from run_steering
           where run_id = $1 and status = 'requested' order by created_at, steering_id limit 1)
         returning steering_id, message, status`,
          [input.runId, input.leaseId]
        );
        const [row] = result.rows;
        return row
          ? { message: row.message, steeringId: row.steering_id }
          : undefined;
      }),
    finish: async (input) =>
      await deps.withTransaction(async (client) => {
        if (!(await lockRun(client, input)).found) {
          return false;
        }
        if (!(await ownsLease(client, input))) {
          return false;
        }
        const result = await client.query(
          `update run_steering set status = $3, updated_at = now()
         where steering_id = $1 and run_id = $2 and status = 'delivering' and delivery_lease_id = $4
         returning steering_id`,
          [
            input.steeringId,
            input.runId,
            input.delivered ? "delivered" : "failed",
            input.leaseId,
          ]
        );
        if (result.rows.length === 0) {
          return false;
        }
        await event(
          client,
          input,
          input.delivered ? "run.steering.delivered" : "run.steering.failed",
          {
            ...(input.delivered
              ? {}
              : {
                  reason:
                    input.reason ?? "The CTO could not receive this message.",
                }),
            steeringId: input.steeringId,
          }
        );
        return true;
      }),
    request: async (input) =>
      await deps.withTransaction(async (client) => {
        const { active, found } = await lockRun(client, input);
        if (!found) {
          return;
        }
        const existing = await client.query<SteeringRow>(
          `select steering_id, message, status from run_steering
         where run_id = $1 and organization_id = $2 and project_id = $3 and idempotency_key = $4`,
          [
            input.runId,
            input.scope.organizationId,
            input.scope.projectId,
            input.idempotencyKey,
          ]
        );
        const [previous] = existing.rows;
        if (previous) {
          if (previous.message !== input.message) {
            throw new SteeringConflictError(
              "This steering key was already used for a different message."
            );
          }
          return {
            accepted: true,
            runId: input.runId,
            status: previous.status,
            steeringId: previous.steering_id,
          };
        }
        if (!active) {
          return;
        }
        const counted = await client.query<{ total: number }>(
          "select count(*)::int as total from run_steering where run_id = $1",
          [input.runId]
        );
        if ((counted.rows[0]?.total ?? 0) >= 10) {
          throw new SteeringConflictError(
            "This run has reached its limit of ten steering messages."
          );
        }
        const steeringId = randomUUID();
        await client.query(
          `insert into run_steering (steering_id, run_id, organization_id, project_id,
         build_session_id, requested_by_user_id, idempotency_key, message, status)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'requested')`,
          [
            steeringId,
            input.runId,
            input.scope.organizationId,
            input.scope.projectId,
            input.buildSessionId,
            input.requestedByUserId,
            input.idempotencyKey,
            input.message,
          ]
        );
        await event(client, input, "run.steering.requested", {
          message: input.message,
          requestedByUserId: input.requestedByUserId,
          steeringId,
        });
        return {
          accepted: true,
          runId: input.runId,
          status: "requested",
          steeringId,
        };
      }),
    retire: async (input) =>
      await deps.withTransaction(async (client) => {
        if (!(await lockRun(client, input)).found) {
          return;
        }
        if (!(await ownsLease(client, input))) {
          return;
        }
        const result = await client.query<{ steering_id: string }>(
          `update run_steering set status = 'failed', updated_at = now()
         where run_id = $1 and status in ('requested', 'delivering') returning steering_id`,
          [input.runId]
        );
        for (const row of result.rows) {
          // biome-ignore lint/performance/noAwaitInLoops: sequence allocation must remain ordered in this transaction
          await event(client, input, "run.steering.failed", {
            reason: "The run ended before steering delivery was confirmed.",
            steeringId: row.steering_id,
          });
        }
      }),
  };
}
