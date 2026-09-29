import type { PoolClient, QueryResult } from "pg";
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  MIGRATION_LEDGER_SQL,
  MIGRATION_STEPS,
  MigrationChecksumMismatchError,
  migrationChecksum,
  UnknownMigrationVersionError,
} from "../src/migrations.js";

interface QueryCall {
  text: string;
  values: readonly unknown[] | undefined;
}

function fakeClient(
  rows: readonly { checksum: string; version: number }[] = []
) {
  const calls: QueryCall[] = [];
  const client = {
    query: (
      text: string,
      values?: readonly unknown[]
    ): Promise<QueryResult<{ checksum: string; version: number }>> => {
      calls.push({ text, values });
      if (text.includes("from schema_migrations")) {
        return Promise.resolve({
          command: "SELECT",
          fields: [],
          oid: 0,
          rowCount: rows.length,
          rows: [...rows],
        });
      }
      return Promise.resolve({
        command: "COMMAND",
        fields: [],
        oid: 0,
        rowCount: 0,
        rows: [],
      });
    },
  };

  return {
    calls,
    client: client as unknown as PoolClient,
  };
}

describe("schema migration ledger", () => {
  it("numbers the existing schema in dependency order with stable checksums", () => {
    expect(MIGRATION_STEPS.map(({ version }) => version)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(new Set(MIGRATION_STEPS.map(({ name }) => name)).size).toBe(
      MIGRATION_STEPS.length
    );
    expect(
      MIGRATION_STEPS.every(({ sql }) => migrationChecksum(sql).length === 64)
    ).toBe(true);
  });

  it("applies each missing step and records it in the same transaction", async () => {
    const { calls, client } = fakeClient();

    await applyMigrations(client);

    expect(calls[0]?.text).toBe(MIGRATION_LEDGER_SQL);
    const recorded = calls
      .filter(({ text }) => text.includes("insert into schema_migrations"))
      .map(({ values }) => values);
    expect(recorded).toEqual(
      MIGRATION_STEPS.map((step) => [
        step.version,
        step.name,
        migrationChecksum(step.sql),
      ])
    );
  });

  it("does not re-run a step whose checksum still matches", async () => {
    const { calls, client } = fakeClient(
      MIGRATION_STEPS.map((step) => ({
        checksum: migrationChecksum(step.sql),
        version: step.version,
      }))
    );

    await applyMigrations(client);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.text).toBe(MIGRATION_LEDGER_SQL);
    expect(calls[1]?.text).toContain("from schema_migrations");
  });

  it("fails loudly when an applied step has been edited", async () => {
    const { calls, client } = fakeClient([
      { checksum: "0".repeat(64), version: MIGRATION_STEPS[0]?.version ?? 1 },
    ]);

    await expect(applyMigrations(client)).rejects.toBeInstanceOf(
      MigrationChecksumMismatchError
    );
    expect(calls).toHaveLength(2);
    expect(calls.some(({ text }) => text === MIGRATION_STEPS[0]?.sql)).toBe(
      false
    );
  });

  it("refuses a database created by a newer application version", async () => {
    const { client } = fakeClient([{ checksum: "a".repeat(64), version: 99 }]);

    await expect(applyMigrations(client)).rejects.toBeInstanceOf(
      UnknownMigrationVersionError
    );
  });
});
