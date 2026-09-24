/**
 * Browser session persistence.
 *
 * A session cookie carries an opaque, high-entropy token. Only the SHA-256
 * digest of that token is stored, so a database read cannot be replayed as a
 * session. Idle and absolute expiry are both evaluated at the moment of use, in
 * the same statement that touches the session, so a revoked or expired session
 * can never be resolved by a concurrent request.
 */
export const AUTH_SESSION_MIGRATION_SQL = `
create table if not exists users (
  user_id uuid primary key,
  primary_email text,
  created_at timestamptz not null default now()
);

create table if not exists auth_sessions (
  session_id uuid primary key,
  token_hash text not null unique,
  user_id uuid not null references users (user_id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  idle_expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  revoked_at timestamptz,
  rotated_from_session_id uuid,
  user_agent_hash text,
  ip_hash text
);

create index if not exists auth_sessions_user_idx
  on auth_sessions (user_id);

create index if not exists auth_sessions_live_idx
  on auth_sessions (token_hash)
  where revoked_at is null;
`;
