# `@reasonateai/project-state`

**Status:** ✅ implemented and verified against real PostgreSQL 16 and Redis 7
**Owns:** `packages/project-state`
**Owner role:** Project State & Data

---

## Purpose

The authoritative durable state layer, shared by the control plane and the execution plane.

Without a single authoritative store, the API and workers each hold part of the truth and diverge on restart. This package makes one place responsible for what happened, what is happening, and who is allowed to act next.

PostgreSQL is authoritative. Redis Streams is transport. A Redis outage delays progress; it never loses it.

---

## Public surface

| Subpath | Provides |
| --- | --- |
| `postgres` | `createProjectStateStore`, `ProjectStateStore`, `TenantScope`, record types |
| `sessions` | `createSessionRepository`, `SessionRepository`, `IssuedSession` |
| `relay` | `createRedisStreamPublisher`, `createOutboxRelay`, `StreamPublisher`, `OutboxRelay` |
| `schema` | `PROJECT_STATE_MIGRATION_SQL`, `PROJECT_STATE_SCHEMA_VERSION` |

Schema for sessions lives in `src/session-schema.ts` and is applied by `migrate()` alongside the main migration.

---

## `ProjectStateStore`

| Method | Guarantee |
| --- | --- |
| `allocateBuildSession` | Idempotent by key; adopts an existing active session instead of duplicating |
| `getBuildSession` | Returns `undefined` for another tenant, never a filtered row |
| `appendRunEvent` | Allocates the next sequence and writes the outbox row in one transaction |
| `listRunEvents` | Returns events strictly after a cursor, ordered by sequence |
| `claimRunLease` | Grants the lease to exactly one holder, respecting expiry |
| `releaseRunLease` | Releases only the lease the caller holds |
| `setRunStatus` | Scoped status transition |
| `listPendingOutbox` / `markOutboxPublished` | Drives the relay; never marks before publishing |
| `recordArtifact` / `listArtifacts` | Tenant-scoped artifact metadata |
| `recordDeployment` | Release record with checkpoint and rollback reference |
| `sessions` | Session repository (see below) |
| `migrate` | Applies both migrations under an advisory lock |
| `close` | Closes the pool |

Every method takes a `TenantScope` of `{ organizationId, projectId }`, and every query carries both values.

---

## `SessionRepository`

| Method | Guarantee |
| --- | --- |
| `createSession` | Returns a session plus the opaque token, and persists only the token digest |
| `resolveSession` | Returns a live session and extends idle expiry, capped by absolute expiry |
| `rotateSession` | Revokes the previous session and links the replacement |
| `revokeSession` | Idempotent; reports whether a live session was revoked |
| `revokeAllUserSessions` | Revokes every live session for one user |

---

## `OutboxRelay`

```ts
const relay = createOutboxRelay({ batchSize, publisher, store });
await relay.drainOnce();   // publish one batch
relay.start(1000);         // background loop
relay.stop();              // clears the interval synchronously
```

| Property | Behaviour |
| --- | --- |
| Delivery | At-least-once. A crash between publish and mark republishes. |
| Deduplication | Consumers deduplicate by the ledger's unique `event_id` |
| Ordering | Publishes sequentially, preserving arrival order within a run's topic |
| Failure | Stops at the first publish failure, marks only what was published, and rethrows |
| Overlap | `start` skips a tick while a drain is still running |

---

## Key invariants and their tests

| Invariant | Test |
| --- | --- |
| One active build session per project | `test/postgres.test.ts` — replay and reconnect return the same session |
| Cross-tenant access fails at the query boundary | `test/postgres.test.ts` — foreign scope returns `undefined` and rejects appends |
| Ledger is contiguous from 1 and cursor replay is exact | `test/postgres.test.ts` — sequence ordering and cursor boundary |
| Exactly one lease holder | `test/postgres.test.ts` — a second holder is refused until release |
| Concurrent migrations do not collide | `test/postgres.test.ts` — four concurrent `migrate()` calls |
| Only a token digest is stored | `test/sessions.test.ts` — stored hash differs from the token and matches SHA-256 hex |
| Revocation is immediate | `test/sessions.test.ts` — resolve fails right after revoke |
| Rotation invalidates the previous token | `test/sessions.test.ts` — old token fails, lineage recorded |
| Absolute expiry governs over idle | `test/sessions.test.ts` — idle extension is capped |
| Transport failure loses nothing | `test/relay.test.ts` — records stay pending, a healthy relay recovers them |
| Marked records are not republished | `test/relay.test.ts` — stream length is unchanged on a second drain |

---

## How it works

### Allocation

`allocateBuildSession` runs in one transaction:

1. Idempotency key already recorded → return the referenced session, `created: false`.
2. An active session exists for the project → adopt it, record the key, `created: false`.
3. Otherwise insert the build session, sandbox environment record, and run; append `run.queued` at sequence 1; write the outbox row; record the key.

Steps 2 and 3 are why a repeated browser request reconnects rather than creating a second, disconnected project.

### Sequence allocation

`runs.next_sequence` defaults to `1` and is incremented in the same statement that returns the previous value, so concurrent appends cannot produce a duplicate or a gap. The first event of a run is sequence `1`; cursor `0` means "from the start".

### Lease contention

```sql
insert into run_leases … on conflict (run_id) do update
  set lease_id = excluded.lease_id, …
  where run_leases.expires_at <= now()
     or run_leases.holder = excluded.holder
```

The `WHERE` on the conflict path is what makes the claim atomic: an unexpired lease held by someone else matches no row, so the statement returns nothing and the caller knows it lost.

### Migrations

`migrate()` opens a transaction, takes `pg_advisory_xact_lock`, and applies both migrations. The lock is required because `create table if not exists` is not concurrency-safe: two replicas racing the same DDL collide in the PostgreSQL system catalog (`pg_type_typname_nsp_index`).

---

## Testing

```bash
export DATABASE_URL="postgres://reasonate:reasonate@127.0.0.1:55432/reasonate"
export REDIS_URL="redis://127.0.0.1:56379"
pnpm --filter @reasonateai/project-state test
```

Tests skip when these are unset, and the Turborepo test cache is keyed on both, so a run without services cannot be replayed as a passing integration result.

---

## Current limitations

- No retention or pruning for `run_events`, `outbox`, or `artifacts`.
- No partitioning for high-volume tables.
- `migrate()` is hand-written DDL rather than a versioned migration ledger, so there is no recorded applied-state table yet.
- The relay has no dead-letter path; a permanently failing record blocks its batch until it is published.
- Session lookups are a single-row update per request; no caching layer.
