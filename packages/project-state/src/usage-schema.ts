/**
 * Metered usage and quota storage.
 *
 * Usage is append-only: every row carries the billing period it belongs to, so
 * a period total is an aggregate over the rows a period actually produced
 * rather than a counter that a partial write leaves permanently wrong. Two
 * callers can reserve the last unit at the same instant only if the total they
 * read and the row they insert are serialized, so `reserve` locks the
 * organization row before it sums; the lock lives in `src/usage.ts`.
 *
 * Expand-only, which is what makes it safe during a rolling deployment: it adds
 * one table, one index, and one nullable `outbox.claimed_at` column, and
 * rewrites no existing row, so the previous release keeps reading and writing
 * everything it knew about.
 *
 * Rollback: `drop table if exists usage_records;` and
 * `alter table outbox drop column if exists claimed_at;`. That discards metered
 * usage, so plan totals restart at zero and a reservation in flight is lost;
 * it is safe only once no process reads either.
 * Forward recovery: every statement is `if not exists`, so re-running
 * `migrate()` repairs a partially applied deployment without touching data.
 */
export const USAGE_MIGRATION_SQL = `
create table if not exists usage_records (
  usage_id bigserial primary key,
  organization_id uuid not null references organizations (organization_id) on delete cascade,
  metric text not null,
  amount bigint not null,
  run_id uuid,
  period_start timestamptz not null,
  period_end timestamptz not null,
  recorded_at timestamptz not null default now()
);

-- snapshot and reserve both aggregate one organization's rows for one period,
-- so the index leads with the organization and the period bounds and carries
-- the metric last, which keeps both reads inside the index.
create index if not exists usage_records_period_idx
  on usage_records (organization_id, period_start, period_end, metric);

-- A claim is exclusive only while it is recorded: a row locked by a
-- transaction is handed to the next relay the moment that transaction commits.
-- The claimant therefore marks the row, and published_at stays the durable
-- "delivered" marker, so a crash after claiming is recoverable instead of
-- losing its event.
alter table outbox add column if not exists claimed_at timestamptz;
`;
