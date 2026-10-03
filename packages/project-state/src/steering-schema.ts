/** Additive v1 migration. Existing run history and commands are unchanged. */
export const RUN_STEERING_MIGRATION_SQL = `
create table if not exists run_steering (
  steering_id uuid primary key,
  run_id uuid not null references runs (run_id) on delete cascade,
  organization_id uuid not null,
  project_id uuid not null,
  build_session_id uuid not null,
  requested_by_user_id uuid not null,
  idempotency_key text not null,
  message text not null check (length(message) between 1 and 20000),
  status text not null check (status in ('requested', 'delivering', 'delivered', 'failed')),
  delivery_lease_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, project_id, run_id, idempotency_key)
);
create index if not exists run_steering_requested_idx
  on run_steering (run_id, created_at, steering_id) where status = 'requested';
`;
