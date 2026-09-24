/**
 * Membership storage.
 *
 * `authorize` is deliberately pure: it receives memberships rather than loading
 * them. This module is the loader that supplies them, and it is the only place
 * that decides whether a user belongs to an organization or a project.
 *
 * Organization and project memberships are separate tables rather than one
 * table with a nullable project column, because a primary key containing NULL
 * does not prevent duplicates in PostgreSQL.
 */
export const MEMBERSHIP_MIGRATION_SQL = `
create table if not exists organization_memberships (
  organization_id uuid not null references organizations (organization_id) on delete cascade,
  user_id uuid not null references users (user_id) on delete cascade,
  role text not null,
  status text not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table if not exists project_memberships (
  organization_id uuid not null,
  project_id uuid not null,
  user_id uuid not null references users (user_id) on delete cascade,
  role text not null,
  status text not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, project_id, user_id),
  foreign key (organization_id, project_id)
    references projects (organization_id, project_id) on delete cascade
);

create index if not exists project_memberships_user_idx
  on project_memberships (user_id, organization_id);
`;
