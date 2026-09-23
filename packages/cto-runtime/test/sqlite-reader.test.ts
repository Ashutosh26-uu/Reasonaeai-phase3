import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MAX_ROWS,
  parseSqliteTarget,
  sqliteReader,
} from "../src/tools/readers/sqlite.js";
import {
  DEFAULT_READER_LIMITS,
  type ReaderLimitError,
  type ReaderRequest,
  type ReaderResult,
  UnsupportedFormatError,
} from "../src/tools/readers/types.js";

const READ_ONLY_RE = /read-only/;
const LIMIT_EXCEEDED_RE = /maxResourceBytes exceeded/;

let cwd: string;
let databasePath: string;
let oversizedPath: string;

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "reasonate-sqlite-"));
  databasePath = join(cwd, "store.db");

  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
  database.exec("CREATE VIEW names AS SELECT name FROM users");
  database.exec("CREATE TABLE metrics (id INTEGER PRIMARY KEY, hits INTEGER)");
  database
    .prepare("INSERT INTO metrics (id, hits) VALUES (?, ?)")
    .run(1, 9_007_199_254_740_993n);
  database.exec(
    "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 1200) INSERT INTO users (id, name) SELECT n, 'user' FROM seq WHERE n > 3"
  );
  const insert = database.prepare("INSERT INTO users (id, name) VALUES (?, ?)");
  insert.run(1, "ada");
  insert.run(2, "grace");
  insert.run(3, "alan");
  database.close();

  // A file with the right extension but no database header: the reader must
  // refuse it rather than return its bytes as text.
  oversizedPath = join(cwd, "notes.db");
  await writeFile(oversizedPath, "this is not a database, it is prose");
});

afterAll(async () => {
  await rm(cwd, { force: true, recursive: true });
});

function request(
  selector?: string,
  overrides: Partial<ReaderRequest> = {}
): ReaderRequest {
  return {
    limits: DEFAULT_READER_LIMITS,
    path: databasePath,
    selector,
    ...overrides,
  };
}

async function read(selector?: string): Promise<ReaderResult> {
  return await sqliteReader.read(request(selector));
}

async function readJson(selector?: string): Promise<Record<string, unknown>> {
  const result = await read(selector);
  return JSON.parse(result.text) as Record<string, unknown>;
}

function names(body: Record<string, unknown>): unknown[] {
  const rows = body.rows as { name: string }[];
  return rows.map((row) => row.name);
}

describe("sqlite dispatch", () => {
  it("claims a database file and only a database file", () => {
    expect(
      sqliteReader.matches({ path: join(cwd, "store.db"), selector: undefined })
    ).toBe(true);
    expect(
      sqliteReader.matches({
        path: join(cwd, "store.sqlite3"),
        selector: undefined,
      })
    ).toBe(true);
    expect(
      sqliteReader.matches({
        path: join(cwd, "notes.txt"),
        selector: undefined,
      })
    ).toBe(false);
  });

  it("parses the path grammar spectra defined", () => {
    const target = parseSqliteTarget(
      `${join(cwd, "data", "v1.db")}:users:2?limit=5`,
      cwd
    );
    expect(target?.databasePath).toBe(join(cwd, "data", "v1.db"));
    expect(target?.table).toBe("users");
    expect(target?.key).toBe("2");
    expect(target?.query.get("limit")).toBe("5");
  });

  it("resolves the extension that ends the path, not the first one", () => {
    const nested = join(cwd, "cache.db", "store.sqlite");
    const target = parseSqliteTarget(`${nested}:users`, cwd);
    expect(target?.databasePath).toBe(nested);
    expect(target?.table).toBe("users");
  });

  it("decodes a percent-escaped selector", () => {
    expect(
      parseSqliteTarget(`${join(cwd, "a.db")}:my%20table:7`, cwd)?.table
    ).toBe("my table");
  });

  it("returns no target for a path that names no database", () => {
    expect(parseSqliteTarget(join(cwd, "notes.txt"), cwd)).toBeUndefined();
  });
});

describe("sqlite listing", () => {
  it("lists tables and views when no table is named", async () => {
    const result = await read();
    const body = JSON.parse(result.text) as {
      database: string;
      tables: { name: string; type: string }[];
    };

    expect(body.database).toBe(databasePath);
    expect(body.tables.map((table) => table.name)).toContain("users");
    expect(body.tables.map((table) => table.name)).toContain("names");
    expect(result.contentType).toBe("application/json");
    // A database is not an editable region of a file.
    expect(result.immutable).toBe(true);
  });
});

describe("sqlite table reads", () => {
  it("returns the rows of a named table", async () => {
    const body = await readJson("users?order=id&where=id%20%3C%204&limit=3");
    expect(names(body)).toEqual(["ada", "grace", "alan"]);
    expect(body.table).toBe("users");
    expect(body.total).toBe(3);
    const schema = body.schema as { name: string }[];
    expect(schema.map((column) => column.name)).toEqual(["id", "name"]);
  });

  it("honours a limit and says how many rows it left behind", async () => {
    const result = await read("users?order=id&limit=2");
    const body = JSON.parse(result.text) as Record<string, unknown>;

    expect(names(body)).toEqual(["ada", "grace"]);
    expect(body.limit).toBe(2);
    expect(body.total).toBe(1200);
    // A bound that is applied silently reads as a complete result.
    expect(result.notes?.[0]).toContain("2 of 1200");
  });

  it("reads one row by primary key", async () => {
    const body = await readJson("users:2");
    expect(body.key).toBe("2");
    expect(body.row).toEqual({ id: 2, name: "grace" });
  });

  it("fails on a row that is not there rather than returning an empty row", async () => {
    await expect(read("users:99999")).rejects.toThrow(
      "SQLite row not found: users:99999"
    );
  });

  it("reads an integer past the safe range instead of failing on it", async () => {
    const body = await readJson("metrics:1");
    expect(body.row).toEqual({ hits: "9007199254740993", id: 1 });
  });

  it("fails on a table that is not there", async () => {
    await expect(read("absent")).rejects.toThrow(
      "SQLite table not found: absent"
    );
  });

  it("refuses an order clause that is not a plain column", async () => {
    await expect(
      read("users?order=id%3B%20DROP%20TABLE%20users")
    ).rejects.toThrow("SQLite order must be <column> [ASC|DESC]");
  });
});

describe("sqlite queries", () => {
  it("runs a read-only select", async () => {
    const body = await readJson(
      "?q=select name from users where id < 3 order by id"
    );
    expect(body.rows).toEqual([{ name: "ada" }, { name: "grace" }]);
    expect(body.total).toBe(2);
    expect(body.truncated).toBe(false);
  });

  it("refuses a mutating statement", async () => {
    await expect(read("?q=DROP%20TABLE%20users")).rejects.toThrow(READ_ONLY_RE);
    await expect(
      read("?q=insert into users (id, name) values (99, 'mallory')")
    ).rejects.toThrow(READ_ONLY_RE);
    await expect(read("?q=select 1; delete from users")).rejects.toThrow(
      READ_ONLY_RE
    );

    // The refusal is a refusal: nothing was written.
    const body = await readJson("users?order=id&limit=1");
    expect(names(body)).toEqual(["ada"]);
  });

  it("states the real total when a query hits the row cap", async () => {
    const result = await read("?q=select * from users order by id");
    const body = JSON.parse(result.text) as {
      rows: unknown[];
      total: number;
      truncated: boolean;
    };

    expect(body.rows).toHaveLength(MAX_ROWS);
    expect(body.total).toBe(1200);
    expect(body.truncated).toBe(true);
    expect(result.notes?.[0]).toContain(`${MAX_ROWS} of 1200`);
  });
});

describe("sqlite limits and refusals", () => {
  it("enforces maxResourceBytes before it opens the database", async () => {
    const limited = request(undefined, {
      limits: { ...DEFAULT_READER_LIMITS, maxResourceBytes: 8 },
    });
    await expect(sqliteReader.read(limited)).rejects.toThrow(LIMIT_EXCEEDED_RE);
    await expect(sqliteReader.read(limited)).rejects.toMatchObject({
      limit: "maxResourceBytes",
    } satisfies Partial<ReaderLimitError>);
  });

  it("throws rather than dumping a file that is not a database", async () => {
    await expect(
      sqliteReader.read(request(undefined, { path: oversizedPath }))
    ).rejects.toThrow(UnsupportedFormatError);
  });
});
