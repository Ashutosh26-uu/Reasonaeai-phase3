---
name: data-and-persistence
description: "Schema, migration, query, and transaction discipline for relational persistence."
always: false
globs: ["**/migrations/**", "**/schema.prisma", "**/*.sql", "**/db/**", "**/models/**", "**/repositories/**"]
---

# Data and persistence
## Schema
- The database is the authority. Enforce invariants with `NOT NULL`, `UNIQUE`, `CHECK`, foreign keys, and defaults — not only in application validation.
- Model relationships with real foreign keys and an explicit delete behavior (`ON DELETE RESTRICT` by default; cascade only when the child has no independent meaning).
- Give every table a stable primary key. Use a sortable, non-guessable identifier for anything exposed in a URL; never expose a sequential internal id when enumeration matters.
- Store timestamps in UTC (`timestamptz`) with a default, and keep `created_at`/`updated_at` accurate.
- Store exactly one representation of a value. Do not cache a derived total in a column unless you also own its invalidation.
- Prefer a nullable column plus a clear meaning over a sentinel value like `""` or `-1`.
- Name tables and columns consistently (`snake_case`, plural tables) and keep names stable; a rename is a migration.

## Migrations
- Every schema change ships as a reviewable migration file, generated or hand-written, applied as its own step — never as an implicit sync at boot.
- Migrations are forward-safe and compatible with the running version during deployment: add nullable columns, backfill, then enforce. Do not add a `NOT NULL` column without a default to a populated table.
- Never edit an applied migration. Add a new one.
- State how the change is reversed or recovered. A destructive change (drop, narrow, rename, type change) needs an explicit plan for existing data.
- Backfill in bounded batches; never run an unbounded `UPDATE` over a live table in one statement.

## Queries
- Select the columns you need. `SELECT *` into an entity that then leaks to a response is two defects.
- Give every query a supporting index: foreign keys, lookup columns, and the exact columns and order of real `WHERE`/`ORDER BY` clauses. Verify with the query plan instead of assuming.
- Eliminate N+1 access: batch or join. A loop that issues a query per row is a defect even when it passes a small test.
- Paginate with a stable, unique ordering (keyset pagination over `OFFSET` for large or deep sets).
- Never build SQL by string concatenation with user input. Parameterize.
- Push filtering, aggregation, and counting into the database rather than loading rows to filter in memory.

## Transactions and concurrency
- Group writes that must both succeed in one transaction with the correct isolation level; keep the transaction short and free of network calls.
- Handle lost updates: use a row lock, a conditional update, or a version column. Do not read-modify-write without one.
- Make write paths idempotent where a retry is possible, keyed by a natural unique constraint or an idempotency record.
- Expect serialization and deadlock failures and retry them deliberately; do not retry every error.

## Access
- Scope every tenant-owned query by the owning organization (and project where applicable) in the query itself. Never fetch broadly and filter in application code.
- Keep persistence behind a repository or service boundary; handlers and components do not build queries.
- Deleting: prefer an explicit soft-delete column only when the product needs recovery or history; otherwise delete, and state the decision.
