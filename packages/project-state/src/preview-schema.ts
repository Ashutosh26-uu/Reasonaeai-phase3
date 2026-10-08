/**
 * Persistent preview registry storage.
 *
 * PostgreSQL records the authorized run sandbox that owns an app preview, its
 * private relay port, scope, status, and idle lease.
 *
 * This allows API processes to restart without losing track of live previews,
 * gracefully recover running containers, and intentionally retire expired or
 * dead preview sandboxes.
 *
 * Expand-only: safe during rolling deployments.
 * Rollback: \`drop table if exists previews;\`
 * Forward recovery: every statement is \`if not exists\`, so re-running
 * \`migrate()\` repairs a partially applied deployment without touching data.
 */
export const PREVIEW_MIGRATION_SQL = `
create table if not exists previews (
  preview_id uuid primary key,
  build_session_id uuid not null references build_sessions (build_session_id) on delete cascade,
  run_id uuid,
  organization_id uuid not null,
  project_id uuid not null,
  status text not null,
  host_port integer,
  detail text,
  sandbox_id text not null,
  container_name text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, project_id)
    references projects (organization_id, project_id) on delete cascade
);

alter table previews add column if not exists run_id uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'previews_run_id_fk') then
    alter table previews add constraint previews_run_id_fk
      foreign key (run_id) references runs (run_id) on delete cascade;
  end if;
end $$;

create index if not exists previews_scope_idx
  on previews (organization_id, project_id, created_at desc);

create index if not exists previews_session_idx
  on previews (build_session_id, created_at desc);

create index if not exists previews_status_idx
  on previews (status, last_used_at);
`;
