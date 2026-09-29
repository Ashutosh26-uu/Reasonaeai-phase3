import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import {
  AUDIT_MIGRATION_SQL,
  AUTH_TOKEN_MIGRATION_SQL,
} from "./auth-schema.js";
import { MEMBERSHIP_MIGRATION_SQL } from "./membership-schema.js";
import { PROJECT_STATE_MIGRATION_SQL } from "./schema.js";
import { AUTH_SESSION_MIGRATION_SQL } from "./session-schema.js";
import { USAGE_MIGRATION_SQL } from "./usage-schema.js";

/**
 * The ledger itself is a bootstrap invariant. It is created before the first
 * numbered step because a database that predates the ledger has no row with
 * which to verify the ledger's own DDL.
 */
export const MIGRATION_LEDGER_SQL = `
create table if not exists schema_migrations (
  version integer primary key,
  name text not null,
  checksum text not null,
  applied_at timestamptz not null default now()
);
`;

export interface MigrationStep {
  readonly name: string;
  readonly sql: string;
  readonly version: number;
}

/**
 * Existing schema constants become immutable, numbered steps. New schema
 * changes must append a step rather than editing an applied one in place.
 * Editing an existing step is intentionally detected as a checksum mismatch.
 */
export const MIGRATION_STEPS: readonly MigrationStep[] = Object.freeze([
  { name: "project-state", sql: PROJECT_STATE_MIGRATION_SQL, version: 1 },
  { name: "auth-sessions", sql: AUTH_SESSION_MIGRATION_SQL, version: 2 },
  { name: "memberships", sql: MEMBERSHIP_MIGRATION_SQL, version: 3 },
  { name: "usage", sql: USAGE_MIGRATION_SQL, version: 4 },
  { name: "auth-tokens", sql: AUTH_TOKEN_MIGRATION_SQL, version: 5 },
  { name: "audit", sql: AUDIT_MIGRATION_SQL, version: 6 },
]);

export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

export class MigrationChecksumMismatchError extends Error {
  override readonly name = "MigrationChecksumMismatchError";
  readonly recordedChecksum: string;
  readonly version: number;
  readonly expectedChecksum: string;

  constructor(input: {
    expectedChecksum: string;
    name: string;
    recordedChecksum: string;
    version: number;
  }) {
    super(
      `Migration ${input.version} (${input.name}) has changed after it was applied. ` +
        `Recorded checksum ${input.recordedChecksum}, current checksum ${input.expectedChecksum}. ` +
        "Append a new migration instead of editing an applied step."
    );
    this.expectedChecksum = input.expectedChecksum;
    this.recordedChecksum = input.recordedChecksum;
    this.version = input.version;
  }
}

export class UnknownMigrationVersionError extends Error {
  override readonly name = "UnknownMigrationVersionError";
  readonly version: number;

  constructor(version: number) {
    super(
      `Database contains migration version ${version}, but this build does not define it. ` +
        "Deploy the compatible application version before migrating."
    );
    this.version = version;
  }
}

interface MigrationRow {
  checksum: string;
  version: number;
}

/**
 * Applies numbered migrations in one caller-owned transaction.
 *
 * The SQL step and its ledger row are committed together. If either fails, the
 * next startup retries the step; a partially applied step can therefore use
 * idempotent SQL while a changed step can never be silently skipped.
 */
export async function applyMigrations(client: PoolClient): Promise<void> {
  await client.query(MIGRATION_LEDGER_SQL);

  const result = await client.query<MigrationRow>(
    `select version, checksum
       from schema_migrations
      order by version asc`
  );
  const recorded = new Map(
    result.rows.map((row) => [Number(row.version), row.checksum])
  );
  const definedVersions = new Set(MIGRATION_STEPS.map((step) => step.version));

  for (const version of recorded.keys()) {
    if (!definedVersions.has(version)) {
      throw new UnknownMigrationVersionError(version);
    }
  }

  for (const step of MIGRATION_STEPS) {
    const checksum = migrationChecksum(step.sql);
    const previous = recorded.get(step.version);

    if (previous !== undefined) {
      if (previous !== checksum) {
        throw new MigrationChecksumMismatchError({
          expectedChecksum: checksum,
          name: step.name,
          recordedChecksum: previous,
          version: step.version,
        });
      }
      continue;
    }

    // Migration steps must run in version order: a later step may depend on
    // objects created by an earlier one, and the ledger row follows its SQL.
    // biome-ignore lint/performance/noAwaitInLoops: ordered migrations are intentionally sequential
    await client.query(step.sql);
    await client.query(
      `insert into schema_migrations (version, name, checksum)
       values ($1, $2, $3)`,
      [step.version, step.name, checksum]
    );
  }
}
