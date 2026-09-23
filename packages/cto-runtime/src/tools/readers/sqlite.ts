/**
 * The SQLite reader: a database's schema, a table's rows, one row by key, and
 * read-only queries, all from one file.
 *
 * The path grammar is spectra's — `<path>.db[:table[:key]][?q=…&where=…]` — and
 * the last database extension in the string wins, so a directory that happens to
 * be called `cache.db` does not swallow the path.
 *
 * Output is JSON rather than a rendering: a row has no line numbers, and the
 * caller wants the values. Every read is bounded by `MAX_ROWS` and states the
 * bound in `notes` when it applies one, because a silent cap reads as a complete
 * result — which is how a model concludes a table ends where the page did.
 */

import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  assertWithinLimit,
  type FormatReader,
  type ReaderRequest,
  type ReaderResult,
  UnsupportedFormatError,
} from "./types.js";

/** Spectra's target grammar: a database extension, then a selector or query. */
const SQLITE_PATH_PATTERN = /\.(?:sqlite3?|db3?)(?=[:?]|$)/gi;

/** The same extensions anchored, for claiming a target during dispatch. */
const SQLITE_EXTENSION_PATTERN = /\.(?:sqlite3?|db3?)$/i;

/** Most rows one read returns, whatever the caller asked for. */
export const MAX_ROWS = 1000;

/** Rows returned for a table read when no `limit` is given. */
const DEFAULT_ROW_LIMIT = 20;

/** A lone read-only statement: a SELECT, WITH, safe PRAGMA, or query plan. */
const READ_ONLY_QUERY_PATTERN =
  /^(?:select|with|pragma\s+(?:table_info|table_xinfo|index_list|index_info|foreign_key_list)\b|explain\s+query\s+plan)\b/i;

/** A statement whose row count can be measured by wrapping it in `COUNT(*)`. */
const ROW_QUERY_PATTERN = /^(?:select|with)\b/i;

/** A terminator followed by more SQL, or any keyword that mutates. */
const MUTATING_QUERY_PATTERN =
  /;\s*\S|\b(?:insert|update|delete|replace|drop|alter|create|attach|detach|vacuum|reindex)\b/i;

const COMMENT_LINE_PATTERN = /^--.*$/gm;
const STATEMENT_TERMINATOR_PATTERN = /;+\s*$/;
const LEADING_COLON_PATTERN = /^:/;
const SELECTOR_SEPARATOR_PATTERN = /^[:?]/;
const FORBIDDEN_WHERE_PATTERN = /[;]|--|\/\*/;
const ORDER_SPLIT_PATTERN = /\s+/;
const COLUMN_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SORT_DIRECTION_PATTERN = /^(?:ASC|DESC)$/i;

/**
 * Reading this forces SQLite to read the file header, so a file that is not a
 * database fails here rather than halfway through the first query.
 */
const PROBE_SQL = "PRAGMA schema_version";

const TABLE_LIST_SQL =
  "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name";

const TABLE_LOOKUP_SQL =
  "SELECT 1 AS found FROM sqlite_master WHERE type IN ('table','view') AND name = ? LIMIT 1";

/**
 * `node:sqlite` reads INTEGER columns as BigInt when `readBigInts` is on, and
 * throws when it must widen one that the option is off. These bounds let a
 * value small enough to survive as a number JSON-encode as one.
 */
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

/** A row as the database returned it, before normalisation. */
type SqliteRow = Record<string, unknown>;

/** What a read-only query turned out to be, which decides if it can be counted. */
type SqliteQueryKind = "metadata" | "rows";

/** A parsed SQLite target: the database file, an optional row, and the query. */
export interface SqliteTarget {
  databasePath: string;
  key?: string | undefined;
  query: URLSearchParams;
  table?: string | undefined;
}

/**
 * Parse a target into the file to open and how to read it.
 *
 * The grammar is spectra's, unchanged: the last `.db`-family extension in the
 * string ends the path, everything up to the first `?` is `table[:key]`, and the
 * rest is a `URLSearchParams`. Returns undefined when no extension matches, so
 * the caller can refuse rather than guess.
 */
export function parseSqliteTarget(
  input: string,
  cwd: string
): SqliteTarget | undefined {
  let selected: RegExpExecArray | null = null;
  for (const match of input.matchAll(SQLITE_PATH_PATTERN)) {
    selected = match;
  }

  if (selected === null) {
    return undefined;
  }

  const end = selected.index + selected[0].length;
  const remainder = input.slice(end);
  const queryIndex = remainder.indexOf("?");
  const selector = (
    queryIndex === -1 ? remainder : remainder.slice(0, queryIndex)
  ).replace(LEADING_COLON_PATTERN, "");
  const [table, ...keyParts] = selector.split(":");

  return {
    databasePath: resolve(cwd, input.slice(0, end)),
    key:
      keyParts.length > 0 ? decodeURIComponent(keyParts.join(":")) : undefined,
    query: new URLSearchParams(
      queryIndex === -1 ? "" : remainder.slice(queryIndex + 1)
    ),
    table:
      table === undefined || table === ""
        ? undefined
        : decodeURIComponent(table),
  };
}

/** Quote an identifier the way SQLite does, so a name cannot break the SQL. */
function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** A cell as something JSON can carry. */
function normalizeValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return `<BLOB ${value.byteLength} bytes>`;
  }
  if (typeof value === "bigint") {
    return value >= MIN_SAFE_BIGINT && value <= MAX_SAFE_BIGINT
      ? Number(value)
      : value.toString();
  }
  return value;
}

/** Normalise a result set for display. */
function normalizeRows(rows: SqliteRow[]): SqliteRow[] {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, normalizeValue(value)])
    )
  );
}

/** A `COUNT(*) AS total` row as a number. */
function countOf(row: SqliteRow | undefined): number {
  const total = row?.total;
  if (typeof total === "bigint") {
    return Number(total);
  }
  return typeof total === "number" ? total : 0;
}

/**
 * Reject anything that is not one read-only statement, and say which kind it is.
 *
 * The database is opened read-only too, but a refused statement is a clearer
 * answer than "attempt to write a readonly database", and it is the answer the
 * caller needs when it mistook a write for a read.
 */
function assertReadOnlyQuery(sql: string): SqliteQueryKind {
  const normalized = sql.trim().replace(COMMENT_LINE_PATTERN, "").trim();
  if (
    !READ_ONLY_QUERY_PATTERN.test(normalized) ||
    MUTATING_QUERY_PATTERN.test(normalized)
  ) {
    throw new Error(
      "SQLite query must be a single read-only SELECT, WITH, safe PRAGMA inspection, or EXPLAIN QUERY PLAN statement"
    );
  }
  return ROW_QUERY_PATTERN.test(normalized) ? "rows" : "metadata";
}

/**
 * Open the database read-only.
 *
 * `readBigInts` is on so an INTEGER past the safe range is readable at all;
 * `readOnly` is what stops a write from ever reaching the file. Reading a pragma
 * forces SQLite to read the file header, so a file that is not a database is
 * refused here — and closed, so the handle does not outlive the refusal — rather
 * than failing halfway through the first query.
 */
function openReadOnlyDatabase(filePath: string): DatabaseSync {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(filePath, {
      readBigInts: true,
      readOnly: true,
    });
    database.prepare(PROBE_SQL).get();
    return database;
  } catch (error) {
    database?.close();
    throw new UnsupportedFormatError(
      `Not a readable SQLite database: ${filePath}`,
      { cause: error }
    );
  }
}

/** The tables and views in the database, with the SQL that defines them. */
function readTables(
  database: DatabaseSync,
  databasePath: string
): ReaderResult {
  return {
    contentType: "application/json",
    immutable: true,
    text: JSON.stringify(
      {
        database: databasePath,
        tables: normalizeRows(database.prepare(TABLE_LIST_SQL).all()),
      },
      null,
      2
    ),
  };
}

/** The number of rows a read-only query would return, when it can be counted. */
function countQueryRows(
  database: DatabaseSync,
  sql: string
): number | undefined {
  if (sql.includes("?")) {
    // The caller's statement cannot be re-bound through the wrapper.
    return undefined;
  }
  const countable = sql.replace(STATEMENT_TERMINATOR_PATTERN, "");
  return countOf(
    database.prepare(`SELECT COUNT(*) AS total FROM (${countable})`).get()
  );
}

/** Run an arbitrary read-only query, bounded and with its real total. */
function readQuery(database: DatabaseSync, sql: string): ReaderResult {
  const kind = assertReadOnlyQuery(sql);
  const rows = database.prepare(sql).all().slice(0, MAX_ROWS);
  const shown = rows.length;
  const total = kind === "rows" ? countQueryRows(database, sql) : undefined;
  const truncated = total === undefined ? shown === MAX_ROWS : total > shown;

  const notes: string[] = [];
  if (truncated && total !== undefined) {
    notes.push(
      `Showing the first ${shown} of ${total} rows; ${total - shown} more rows exist. Narrow the query, because a read stops at ${MAX_ROWS} rows.`
    );
  } else if (truncated) {
    notes.push(
      `Showing ${shown} rows, the read limit; more rows may exist. Add a narrower query to see past it.`
    );
  }

  return {
    contentType: "application/json",
    immutable: true,
    ...(notes.length === 0 ? {} : { notes }),
    text: JSON.stringify(
      { rows: normalizeRows(rows), total: total ?? null, truncated },
      null,
      2
    ),
  };
}

/** A named table or view: its schema, then either one keyed row or a page. */
function readTable(
  database: DatabaseSync,
  table: string,
  target: SqliteTarget
): ReaderResult {
  const { key, query } = target;
  const found = database.prepare(TABLE_LOOKUP_SQL).get(table);
  if (found === undefined) {
    throw new Error(`SQLite table not found: ${table}`);
  }

  const quoted = quoteIdentifier(table);
  const schema = database.prepare(`PRAGMA table_info(${quoted})`).all();

  if (key !== undefined) {
    const primaryKey = schema.find((column) => Number(column.pk) > 0)?.name;
    const keyColumn =
      typeof primaryKey === "string" ? quoteIdentifier(primaryKey) : "rowid";
    const row = database
      .prepare(`SELECT * FROM ${quoted} WHERE ${keyColumn} = ? LIMIT 1`)
      .get(key);
    if (row === undefined) {
      throw new Error(`SQLite row not found: ${table}:${key}`);
    }
    return {
      contentType: "application/json",
      immutable: true,
      text: JSON.stringify(
        { key, row: normalizeRows([row])[0], table },
        null,
        2
      ),
    };
  }

  const limit = Math.min(
    MAX_ROWS,
    Math.max(
      1,
      Number(query.get("limit") ?? DEFAULT_ROW_LIMIT) || DEFAULT_ROW_LIMIT
    )
  );
  const offset = Math.max(0, Number(query.get("offset") ?? 0) || 0);
  const order = query.get("order");
  const where = query.get("where");

  let whereClause = "";
  if (where !== null && where !== "") {
    if (FORBIDDEN_WHERE_PATTERN.test(where)) {
      throw new Error("SQLite where clause contains forbidden syntax");
    }
    whereClause = ` WHERE ${where}`;
  }

  let select = `SELECT * FROM ${quoted}${whereClause}`;
  if (order !== null && order !== "") {
    const [column, direction = "ASC"] = order.trim().split(ORDER_SPLIT_PATTERN);
    if (
      column === undefined ||
      !COLUMN_NAME_PATTERN.test(column) ||
      !SORT_DIRECTION_PATTERN.test(direction)
    ) {
      throw new Error("SQLite order must be <column> [ASC|DESC]");
    }
    select += ` ORDER BY ${quoteIdentifier(column)} ${direction.toUpperCase()}`;
  }

  const rows = database
    .prepare(`${select} LIMIT ? OFFSET ?`)
    .all(limit, offset);
  const total = countOf(
    database
      .prepare(`SELECT COUNT(*) AS total FROM ${quoted}${whereClause}`)
      .get()
  );
  const shown = rows.length;

  return {
    contentType: "application/json",
    immutable: true,
    ...(total > shown
      ? {
          notes: [
            `Showing rows ${offset + 1}-${offset + shown} of ${total} in ${table}; ${total - shown} more rows exist. Use offset= to page or where= to narrow, because a read stops at ${MAX_ROWS} rows.`,
          ],
        }
      : {}),
    text: JSON.stringify(
      {
        limit,
        offset,
        rows: normalizeRows(rows),
        schema: normalizeRows(schema),
        table,
        total,
      },
      null,
      2
    ),
  };
}

/** Read a parsed target: a query, the table list, a keyed row, or a table page. */
function readSqlite(
  database: DatabaseSync,
  target: SqliteTarget
): ReaderResult {
  const { databasePath, query, table } = target;
  const rawSql = query.get("q");
  if (rawSql !== null && rawSql !== "") {
    return readQuery(database, rawSql);
  }
  return table === undefined
    ? readTables(database, databasePath)
    : readTable(database, table, target);
}

/**
 * The selector as the path grammar spells it.
 *
 * The tool peels a selector off the path before it reaches a reader, so
 * `users:1` arrives without the `:` that the grammar expects; a selector that
 * still carries its separator is left alone.
 */
function selectorSuffix(selector: string | undefined): string {
  if (selector === undefined || selector === "") {
    return "";
  }
  return SELECTOR_SEPARATOR_PATTERN.test(selector) ? selector : `:${selector}`;
}

/** The SQLite format reader. */
export const sqliteReader: FormatReader = {
  extensions: [".db", ".db3", ".sqlite", ".sqlite3"],
  matches: (request) => SQLITE_EXTENSION_PATTERN.test(request.path),
  name: "sqlite",
  read: async (request: ReaderRequest): Promise<ReaderResult> => {
    const { limits, path: filePath, selector } = request;
    const target = parseSqliteTarget(
      `${filePath}${selectorSuffix(selector)}`,
      process.cwd()
    );
    if (target === undefined) {
      throw new UnsupportedFormatError(`Not a SQLite target: ${filePath}`);
    }

    const info = await stat(target.databasePath).catch((error: unknown) => {
      throw new Error(`Cannot read SQLite database ${target.databasePath}`, {
        cause: error,
      });
    });
    assertWithinLimit("maxResourceBytes", info.size, limits.maxResourceBytes);

    const database = openReadOnlyDatabase(target.databasePath);
    try {
      return readSqlite(database, target);
    } finally {
      database.close();
    }
  },
};
