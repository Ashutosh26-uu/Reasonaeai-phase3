/**
 * The authoritative control-plane schema.
 *
 * PostgreSQL is the source of truth for commands, state transitions,
 * idempotency keys, run leases, artifact metadata, and the sequenced event
 * ledger that browser reconnect depends on. Redis Streams is transport and
 * never the only record of work.
 */
export const PROJECT_STATE_SCHEMA_VERSION = 4;

export const PROJECT_STATE_MIGRATION_SQL = `
create table if not exists organizations (
  organization_id uuid primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists projects (
  project_id uuid primary key,
  organization_id uuid not null references organizations (organization_id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (organization_id, project_id)
);

create table if not exists build_sessions (
  build_session_id uuid primary key,
  organization_id uuid not null,
  project_id uuid not null,
  user_session_id uuid not null,
  run_id uuid not null,
  sandbox_environment_id uuid not null,
  workspace_uri text not null,
  stage text not null,
  status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, project_id)
    references projects (organization_id, project_id) on delete cascade
);

-- Conversations are separate build sessions within one project. An explicit
-- idempotency key reconnects to the same conversation; a new key creates one.
drop index if exists build_sessions_active_project_key;
create index if not exists build_sessions_project_recent_idx
  on build_sessions (organization_id, project_id, created_at desc);

create table if not exists runs (
  run_id uuid primary key,
  organization_id uuid not null,
  project_id uuid not null,
  build_session_id uuid not null references build_sessions (build_session_id) on delete cascade,
  status text not null,
  user_message text,
  next_sequence bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table runs add column if not exists user_message text;
alter table runs add column if not exists user_attachments jsonb not null default '[]'::jsonb;
alter table runs add column if not exists cancellation_requested_at timestamptz;
alter table runs add column if not exists pending_tool_call_id text;
alter table runs add column if not exists pending_mastra_run_id text;
alter table runs add column if not exists pending_answer text;
alter table runs add column if not exists pending_answered_by uuid;
create index if not exists runs_session_recent_idx
  on runs (build_session_id, created_at desc);

drop index if exists runs_one_running_project_idx;
create unique index if not exists runs_one_active_project_idx
  on runs (organization_id, project_id)
  where status in ('running', 'awaiting_approval');

create table if not exists conversation_turn_keys (
  organization_id uuid not null,
  project_id uuid not null,
  build_session_id uuid not null references build_sessions (build_session_id) on delete cascade,
  idempotency_key text not null,
  run_id uuid not null references runs (run_id) on delete cascade,
  primary key (organization_id, project_id, build_session_id, idempotency_key)
);

create table if not exists run_leases (
  run_id uuid primary key references runs (run_id) on delete cascade,
  lease_id uuid not null,
  holder text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create table if not exists idempotency_records (
  organization_id uuid not null,
  scope text not null,
  idempotency_key text not null,
  build_session_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, scope, idempotency_key)
);

-- The event ledger is an append-only, per-run ordered log. The sequence column
-- starts at 1 for the first event of a run and increases by one, so a
-- reconnecting client can resume from an exact cursor (0 means from the start).
create table if not exists run_events (
  run_id uuid not null references runs (run_id) on delete cascade,
  sequence bigint not null,
  event_id uuid not null unique,
  organization_id uuid not null,
  project_id uuid not null,
  type text not null,
  payload jsonb not null,
  occurred_at timestamptz not null default now(),
  primary key (run_id, sequence)
);

create table if not exists outbox (
  outbox_id bigserial primary key,
  topic text not null,
  run_id uuid not null,
  organization_id uuid not null,
  project_id uuid not null,
  event_id uuid not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  published_at timestamptz
);

create index if not exists outbox_unpublished_idx
  on outbox (outbox_id)
  where published_at is null;

create table if not exists sandbox_environments (
  sandbox_environment_id uuid primary key,
  organization_id uuid not null,
  project_id uuid not null,
  build_session_id uuid not null references build_sessions (build_session_id) on delete cascade,
  status text not null,
  workspace_uri text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists artifacts (
  artifact_id uuid primary key,
  organization_id uuid not null,
  project_id uuid not null,
  build_session_id uuid,
  run_id uuid,
  kind text not null,
  manifest_object_key text not null,
  sha256 text not null,
  total_size bigint not null,
  status text not null,
  created_at timestamptz not null default now()
);

create index if not exists artifacts_scope_idx
  on artifacts (organization_id, project_id, created_at desc);

create table if not exists deployments (
  deployment_id uuid primary key,
  organization_id uuid not null,
  project_id uuid not null,
  run_id uuid not null,
  status text not null,
  exposure text not null,
  url text,
  provider_reference text not null,
  source_checkpoint text not null,
  rollback_deployment_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists deployments_scope_idx
  on deployments (organization_id, project_id, created_at desc);
`;
