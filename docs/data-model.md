# Data Model

**Status:** ✅ implemented and verified against real PostgreSQL 16
**Owns:** `packages/project-state/src/schema.ts`, `packages/project-state/src/session-schema.ts`
**Owner role:** Project State & Data

---

## Purpose

PostgreSQL is the authoritative store. It holds commands, state transitions, idempotency keys, run leases, the sequenced event ledger, artifact metadata, deployment records, and browser sessions.

Redis Streams carries messages. It is **never** the only record of work or user-visible state, so a Redis failure can delay progress but cannot lose it.

---

## Storage ownership

| Data class | Lives in | Reason |
| --- | --- | --- |
| Project source | Git checkpoints | Multi-file structure, atomic snapshots, diffs, rollback |
| Active workspace | Sandbox filesystem | Real filesystem semantics; disposable and restorable |
| Evidence and releases | Object storage | Large immutable bytes, digest-verified |
| Everything above, described | PostgreSQL | Ownership, state, authorization, ordering |

A generated project is never stored as a single database object.

---

## Tables

### Identity and tenancy

| Table | Key | Notable constraints |
| --- | --- | --- |
| `organizations` | `organization_id` | Root tenant boundary |
| `projects` | `project_id` | `UNIQUE (organization_id, project_id)` — enables composite foreign keys from project-owned tables |
| `users` | `user_id` | Anchor for sessions, so a session cannot reference a non-existent user |
| `auth_sessions` | `session_id` | `UNIQUE token_hash`; `user_id` references `users` with `ON DELETE CASCADE` |

### Execution

| Table | Key | Notable constraints |
| --- | --- | --- |
| `build_sessions` | `build_session_id` | **Partial unique index** on `(organization_id, project_id)` where status is active — enforces one active session per project |
| `sandbox_environments` | `sandbox_environment_id` | `build_session_id` references `build_sessions` |
| `runs` | `run_id` | `next_sequence` allocates ledger positions |
| `run_leases` | `run_id` | Exactly one holder per run, with `expires_at` |
| `run_events` | `(run_id, sequence)` | `event_id` is `UNIQUE`; append-only |
| `outbox` | `outbox_id` (bigserial) | Partial index on unpublished rows |
| `idempotency_records` | `(organization_id, scope, idempotency_key)` | Makes allocation replay-safe |
| `artifacts` | `artifact_id` | Manifest object key plus digest; bytes live in object storage |
| `deployments` | `deployment_id` | References source checkpoint and rollback target |

---

## Invariants and the tests that defend them

| Invariant | Enforcement | Test |
| --- | --- | --- |
| One active build session per project | Partial unique index | `allocateBuildSession` returns the same session on replay and reconnect |
| Repeating a command cannot create a second session | `idempotency_records` primary key | `test/postgres.test.ts` — "allocates once per idempotency key and reuses the active session on reconnect" |
| No cross-tenant read or write | Composite scope in every query | `test/postgres.test.ts` — "refuses to resolve another tenant's build session" |
| Ledger is contiguous per run, starting at 1 | `next_sequence` increment inside the same transaction as the insert | `test/postgres.test.ts` — "orders the event ledger monotonically…" |
| Cursor replay returns exactly the newer events | `sequence > $cursor` ordering | same test — checks the cursor boundary |
| Exactly one worker holds a run | `ON CONFLICT DO UPDATE … WHERE expires_at <= now()` | `test/postgres.test.ts` — "grants a run lease to exactly one holder…" |
| An event is never marked delivered before it is published | Relay marks only after a successful publish | `test/relay.test.ts` — "leaves records unpublished when the transport fails…" |
| Only a session token digest is stored | `token_hash` column; plaintext never persisted | `test/sessions.test.ts` — "stores only a digest of the session token…" |
| Revocation takes effect immediately | `revoked_at` checked at resolve time | `test/sessions.test.ts` — "stops resolving a session immediately after revocation" |
| Rotation invalidates the previous token | Old row revoked, new row links `rotated_from_session_id` | `test/sessions.test.ts` — "invalidates the previous token on rotation…" |
| Concurrent replica migrations do not collide | `pg_advisory_xact_lock` around DDL | `test/postgres.test.ts` — "serializes concurrent migrations…" |

---

## Why the event ledger starts at 1

`runs.next_sequence` defaults to `1`. The first event of a run is therefore sequence `1`, and adding one per append keeps the log contiguous.

A browser reconnect sends `Last-Event-ID: 0` to mean *"send everything you still have"*, because `listRunEvents` filters `sequence > cursor`. Zero is a cursor sentinel, never an allocated sequence.

---

## Why the outbox is in the same transaction

Writing state and its outbound message separately produces two failure modes: a state change with no message, or a message for a state change that rolled back. Writing the outbox row inside the state transaction removes both. The relay then publishes afterwards, and delivery becomes at-least-once — a crash between publish and mark republishes, so consumers deduplicate by the `UNIQUE` `event_id`.

---

## Migrations

Migrations are idempotent DDL strings exported from TypeScript, applied by `store.migrate()`.

```bash
# Applied automatically by the store; run explicitly in tests
await store.migrate()
```

Rules:

- `create table if not exists` is **not** concurrency-safe — two replicas starting together collide in the system catalog. `migrate()` takes a transaction-scoped advisory lock so replicas serialize.
- Prefer expand → migrate → contract for changes that must survive a rolling deployment.
- Every schema change needs rollback or forward-recovery notes in its pull request.
- Historical data is never reinterpreted in place; contract changes are versioned.

---

## Current limitations

- No retention or pruning policy yet for `run_events`, `outbox`, or `artifacts`.
- No partitioning strategy for high-volume tables.
- `users` is minimal; memberships, roles, and invitations arrive with the identity workstream.
- Deployments store a rollback reference but no coordinated rollback execution yet.
