/** Additive v9 migration. Existing accounts retain their completed setup.
 * Recovery keeps additive state; identity traffic must be paused and pending
 * flows invalidated before an older redemption implementation is restored.
 */
export const IDENTITY_MIGRATION_SQL = `
alter table users add column if not exists onboarding_completed_at timestamptz default now();
alter table users alter column onboarding_completed_at drop default;
alter table magic_link_tokens add column if not exists browser_hash text;
create table if not exists identity_oidc_requests (
  state_hash text primary key,
  expires_at timestamptz not null,
  consumed_at timestamptz
);
create index if not exists identity_oidc_expiry_idx on identity_oidc_requests(expires_at);
create table if not exists identity_provider_accounts (
  provider text not null check (provider = 'google'),
  subject text not null,
  user_id uuid not null references users(user_id) on delete cascade,
  primary key (provider, subject)
);
`;
