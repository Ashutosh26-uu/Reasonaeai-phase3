/**
 * Identity and tenancy storage: single-use magic-link tokens and the audit
 * trail that proves what identity and tenancy changed.
 *
 * A magic link is a bearer capability delivered by email, so only its SHA-256
 * digest is stored; a leaked database read cannot be turned back into a usable
 * link. Consumption is one conditional `update`, so two requests racing the
 * same link cannot both accept it. An audit event is validated against
 * `AuditEventSchema` on the way in and on the way out, so the trail can only
 * contain events the contract describes, and a reader can always parse what it
 * finds.
 *
 * Both constants are applied by `migrate()` inside its migration transaction,
 * after the organization, project, and user tables they reference exist.
 */

/**
 * Magic-link tokens, plus the case-insensitive uniqueness on a user's email
 * that claiming an account depends on.
 *
 * The token row is written before any user is claimed, so `user_id` is filled
 * in only when the address already resolves to an account: signing in never
 * reveals, and never creates, an account from the sign-in request alone.
 *
 * Rollback: `drop table if exists magic_link_tokens;` and
 * `drop index if exists users_primary_email_key;`. That discards in-flight
 * sign-in links, so a link already sent by email stops working and its
 * recipient must request another; dropping the index also re-permits two users
 * to share an address, so roll back only once no process claims users by email.
 * Forward recovery: every statement is `if not exists`, so re-running
 * `migrate()` repairs a partially applied deployment without touching data.
 */
export const AUTH_TOKEN_MIGRATION_SQL = `
create table if not exists magic_link_tokens (
  token_hash text primary key,
  email text not null,
  user_id uuid references users (user_id) on delete cascade,
  ip text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);

-- Refusal reads one token by its digest, and retiring expired rows sweeps by
-- expiry, so expires_at is the only column either needs to look up.
create index if not exists magic_link_tokens_expires_idx
  on magic_link_tokens (expires_at);

-- An address identifies one account however it was typed, so the uniqueness
-- that makes concurrent first sign-ins converge is on the lowercased address.
-- A user with no address is not a duplicate of another such user, hence the
-- partial predicate.
create unique index if not exists users_primary_email_key
  on users (lower(primary_email))
  where primary_email is not null;
`;

/**
 * The append-only audit trail.
 *
 * An event is immutable and carries its own `occurred_at`, so the trail is a
 * record of when the change happened rather than when the row was written, and
 * an event written by the same transaction as the change it describes commits
 * or rolls back with it.
 *
 * `organization_id` cascades with its organization, so deleting a tenant takes
 * its trail with it instead of leaving rows that name an organization nobody
 * can look up. `project_id` deliberately does not cascade that way: a project
 * may be removed while the events that created and changed it remain, and the
 * organization index keeps those events reachable.
 *
 * Rollback: `drop table if exists audit_events;`. That discards every recorded
 * identity, tenancy, and authorization decision, which no later reader can
 * reconstruct, so roll back only once nothing reads the trail.
 * Forward recovery: both statements are `if not exists`, so re-running
 * `migrate()` repairs a partially applied deployment without touching data.
 */
export const AUDIT_MIGRATION_SQL = `
create table if not exists audit_events (
  event_id uuid primary key,
  organization_id uuid references organizations (organization_id) on delete cascade,
  project_id uuid,
  action text not null,
  actor jsonb not null,
  occurred_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  request_id text
);

-- The trail is read per organization, most recent first, and filtered by
-- action when a reviewer asks what happened to identities or tenancy, so both
-- indexes lead with the column that selects and carry the ordering column.
create index if not exists audit_events_organization_idx
  on audit_events (organization_id, occurred_at desc);

create index if not exists audit_events_action_idx
  on audit_events (action, occurred_at desc);
`;
