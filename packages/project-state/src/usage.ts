import {
  type QuotaReservation,
  QuotaReservationSchema,
  type UsageMetric,
  UsageMetricSchema,
  UsageRecordSchema,
  type UsageSnapshot,
  UsageSnapshotSchema,
} from "@reasonateai/contracts/entitlements";
import type { OrganizationId } from "@reasonateai/contracts/identity";
import type { Pool, PoolClient } from "pg";

/**
 * Metered usage, and the atomic reservation an admission decision is made with.
 *
 * `reserve` writes the unit it grants, so the total it compared against and the
 * unit it took are one transaction; a caller must not also `record` that unit,
 * or it counts twice. `record` is for the amounts nobody reserves, such as
 * tokens and spend as a run produces them.
 */
export interface UsageRepository {
  record: (input: {
    amount: number;
    metric: UsageMetric;
    organizationId: OrganizationId;
    recordedAt?: Date;
    runId?: string | null;
  }) => Promise<void>;
  /**
   * Grants one metered unit when the organization's total for the period plus
   * `amount` still fits inside `limit`, and reports the total it observed while
   * deciding. Two concurrent calls for the last unit grant exactly one.
   */
  reserve: (input: {
    amount: number;
    limit: number;
    metric: UsageMetric;
    organizationId: OrganizationId;
    periodEnd: Date;
    periodStart: Date;
    runId?: string | null;
  }) => Promise<QuotaReservation>;
  /** Totals for the organization's current billing period, absent metrics zero. */
  snapshot: (organizationId: OrganizationId) => Promise<UsageSnapshot>;
}

type SnapshotField = Exclude<keyof UsageSnapshot, "periodEnd" | "periodStart">;

const SNAPSHOT_FIELD: Record<UsageMetric, SnapshotField> = {
  projects: "projects",
  runs: "runs",
  sandbox_minutes: "sandboxMinutes",
  spend_micros: "spendMicros",
  tokens: "tokens",
  workspace_bytes: "workspaceBytes",
};

const INSERT_USAGE_SQL = `
insert into usage_records
  (organization_id, metric, amount, run_id, period_start, period_end, recorded_at)
values ($1, $2, $3, $4, $5, $6, coalesce($7::timestamptz, now()))
`;

/**
 * The billing period is the UTC calendar month.
 *
 * `snapshot` takes no period argument, so the store owns the derivation and a
 * caller that passes explicit bounds to `reserve` takes them from a snapshot.
 * That keeps a reservation and the total that admitted it in the same period,
 * and it keeps the boundary the same for every replica.
 */
export function billingPeriodFor(instant: Date): { end: Date; start: Date } {
  return {
    end: new Date(
      Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth() + 1, 1)
    ),
    start: new Date(
      Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), 1)
    ),
  };
}

async function insertUsageRecord(
  client: Pool | PoolClient,
  input: {
    amount: number;
    metric: UsageMetric;
    organizationId: OrganizationId;
    periodEnd: Date;
    periodStart: Date;
    recordedAt?: Date | null;
    runId?: string | null;
  }
): Promise<void> {
  await client.query(INSERT_USAGE_SQL, [
    input.organizationId,
    input.metric,
    input.amount,
    input.runId ?? null,
    input.periodStart,
    input.periodEnd,
    input.recordedAt ?? null,
  ]);
}

export function createUsageRepository(
  pool: Pool,
  config: {
    withTransaction: <T>(run: (client: PoolClient) => Promise<T>) => Promise<T>;
  }
): UsageRepository {
  return {
    record: async (input) => {
      const recordedAt = input.recordedAt ?? new Date();
      const { end, start } = billingPeriodFor(recordedAt);

      // Validated against the contract rather than trusted: a non-integer
      // amount would otherwise land in a bigint column as a rounding decision
      // made by the driver.
      UsageRecordSchema.parse({
        amount: input.amount,
        metric: input.metric,
        organizationId: input.organizationId,
        recordedAt: recordedAt.toISOString(),
        runId: input.runId ?? null,
      });

      await insertUsageRecord(pool, {
        amount: input.amount,
        metric: input.metric,
        organizationId: input.organizationId,
        periodEnd: end,
        periodStart: start,
        recordedAt,
        runId: input.runId ?? null,
      });
    },

    reserve: async (input) =>
      await config.withTransaction(async (client) => {
        // The lock is what makes the decision atomic. The sum below runs in a
        // statement of its own, so under READ COMMITTED it reads a snapshot
        // taken after this lock was granted and therefore sees the reservation
        // that just committed; a single statement would read the pre-lock
        // snapshot and let both callers take the last unit.
        const locked = await client.query(
          `select organization_id from organizations
            where organization_id = $1
            for update`,
          [input.organizationId]
        );
        if (locked.rowCount === 0) {
          throw new Error(
            "Usage can only be reserved for an organization that exists."
          );
        }

        const observed = await client.query<{ total: string }>(
          `select coalesce(sum(amount), 0)::bigint as total
             from usage_records
            where organization_id = $1
              and period_start = $2
              and period_end = $3
              and metric = $4`,
          [
            input.organizationId,
            input.periodStart,
            input.periodEnd,
            input.metric,
          ]
        );

        const total = Number(observed.rows[0]?.total ?? 0);
        const allowed = total + input.amount <= input.limit;
        if (allowed) {
          await insertUsageRecord(client, {
            amount: input.amount,
            metric: input.metric,
            organizationId: input.organizationId,
            periodEnd: input.periodEnd,
            periodStart: input.periodStart,
            runId: input.runId ?? null,
          });
        }

        return QuotaReservationSchema.parse({
          allowed,
          limit: input.limit,
          metric: input.metric,
          observed: total,
        });
      }),

    snapshot: async (organizationId) => {
      const { end, start } = billingPeriodFor(new Date());
      const result = await pool.query<{ metric: string; total: string }>(
        `select metric, sum(amount)::bigint as total
           from usage_records
          where organization_id = $1
            and period_start = $2
            and period_end = $3
          group by metric`,
        [organizationId, start, end]
      );

      // A metric with no rows is zero usage, not a missing field, so every
      // field starts at zero and the query fills in only what it found.
      const totals: Record<SnapshotField, number> = {
        projects: 0,
        runs: 0,
        sandboxMinutes: 0,
        spendMicros: 0,
        tokens: 0,
        workspaceBytes: 0,
      };
      for (const row of result.rows) {
        totals[SNAPSHOT_FIELD[UsageMetricSchema.parse(row.metric)]] = Number(
          row.total
        );
      }

      return UsageSnapshotSchema.parse({
        ...totals,
        periodEnd: end.toISOString(),
        periodStart: start.toISOString(),
      });
    },
  };
}
