import type Database from "better-sqlite3";

/**
 * Idempotent SQLite schema migrations for the `identities`, `attestations` and
 * `slash_events` tables.
 *
 * Invariants (#1351):
 *  1. Idempotent — every statement is `CREATE TABLE IF NOT EXISTS`, so
 *     re-running (retries, restarts, several callers) never drops, rewrites or
 *     loses existing rows.
 *  2. Atomic — all tables are created in one SQLite transaction. A failure at
 *     any step (lock contention, read-only file, schema drift, crash inside
 *     `exec`) rolls back every table created in that run, so the database is
 *     either fully migrated or left exactly as it was. A plain retry recovers.
 *  3. Drift is detected, not ignored — `IF NOT EXISTS` would silently keep a
 *     stale table from an older or different schema. After each step the
 *     table must have every column this module defines (extra columns are
 *     allowed); otherwise the run fails with `SCHEMA_DRIFT` and rolls back.
 *  4. Diagnosable, without leaking data — failures surface as
 *     `MigrationError` carrying a `reason`, the `table` involved and the
 *     SQLite `code` (e.g. `SQLITE_BUSY`, `SQLITE_READONLY`); the original error
 *     is kept as `cause`. Messages only name tables and columns, never row
 *     contents.
 */

/** Why a migration run failed. */
export type MigrationFailureReason =
  /** `db` is not a usable better-sqlite3 Database instance. */
  | "INVALID_DATABASE"
  /** The connection has already been closed. */
  | "DATABASE_CLOSED"
  /** An existing table is missing columns this module requires. */
  | "SCHEMA_DRIFT"
  /** SQLite rejected a statement (busy, read-only, I/O, ...). */
  | "EXECUTION_FAILED";

/** Thrown by {@link runMigrations}; the database is left unchanged. */
export class MigrationError extends Error {
  constructor(
    public readonly reason: MigrationFailureReason,
    message: string,
    /** Table being migrated when the failure happened, if any. */
    public readonly table?: string,
    /** SQLite error code of the underlying failure, e.g. `SQLITE_BUSY`. */
    public readonly code?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "MigrationError";
  }
}

interface TableMigration {
  readonly table: string;
  readonly ddl: string;
  /** Columns the rest of the code relies on; checked for drift. */
  readonly columns: readonly string[];
}

// Order matters: `identities` must exist before the tables referencing it.
const TABLE_MIGRATIONS: readonly TableMigration[] = [
  {
    table: "identities",
    ddl: `
    CREATE TABLE IF NOT EXISTS identities (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      address    TEXT    NOT NULL UNIQUE,
      tenant_id  TEXT,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `,
    columns: ["id", "address", "tenant_id", "created_at"],
  },
  {
    table: "attestations",
    ddl: `
    CREATE TABLE IF NOT EXISTS attestations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      verifier    TEXT    NOT NULL,
      identity_id INTEGER NOT NULL,
      timestamp   TEXT    NOT NULL DEFAULT (datetime('now')),
      weight      REAL    NOT NULL DEFAULT 1.0,
      revoked     INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      tenant_id   TEXT,
      FOREIGN KEY (identity_id) REFERENCES identities(id) ON DELETE CASCADE
    );
  `,
    columns: [
      "id",
      "verifier",
      "identity_id",
      "timestamp",
      "weight",
      "revoked",
      "created_at",
      "tenant_id",
    ],
  },
  {
    table: "slash_events",
    ddl: `
    CREATE TABLE IF NOT EXISTS slash_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      identity_id  INTEGER NOT NULL,
      amount       TEXT    NOT NULL,
      reason       TEXT    NOT NULL,
      evidence_ref TEXT,
      timestamp    TEXT    NOT NULL DEFAULT (datetime('now')),
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      tenant_id    TEXT,
      FOREIGN KEY (identity_id) REFERENCES identities(id) ON DELETE CASCADE
    );
  `,
    columns: [
      "id",
      "identity_id",
      "amount",
      "reason",
      "evidence_ref",
      "timestamp",
      "created_at",
      "tenant_id",
    ],
  },
];

function sqliteCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function executionError(err: unknown, table?: string): MigrationError {
  const code = sqliteCode(err);
  const where = table ? ` while creating table "${table}"` : "";
  return new MigrationError(
    "EXECUTION_FAILED",
    `runMigrations failed${where} (${code ?? "unknown error"}); ` +
      "no tables were changed. Retry once the cause is resolved.",
    table,
    code,
    { cause: err },
  );
}

function assertUsableDatabase(db: unknown): asserts db is Database.Database {
  const candidate = db as Partial<Database.Database> | null | undefined;
  if (
    !candidate ||
    typeof candidate !== "object" ||
    typeof candidate.exec !== "function" ||
    typeof candidate.prepare !== "function" ||
    typeof candidate.transaction !== "function"
  ) {
    throw new MigrationError(
      "INVALID_DATABASE",
      "runMigrations requires a better-sqlite3 Database instance",
    );
  }
  if (candidate.open === false) {
    throw new MigrationError(
      "DATABASE_CLOSED",
      "runMigrations was called on a closed database connection",
    );
  }
}

function assertNoDrift(db: Database.Database, migration: TableMigration): void {
  // Table names come from the constant list above, never from callers.
  const present = new Set(
    (db.prepare(`PRAGMA table_info(${migration.table})`).all() as { name: string }[]).map(
      (column) => column.name,
    ),
  );
  const missing = migration.columns.filter((column) => !present.has(column));
  if (missing.length > 0) {
    throw new MigrationError(
      "SCHEMA_DRIFT",
      `Table "${migration.table}" already exists but is missing required column(s): ` +
        `${missing.join(", ")}. It was created by an older or different schema; ` +
        "migrate it explicitly — runMigrations only creates missing tables. No tables were changed.",
      migration.table,
    );
  }
}

/**
 * Run all idempotent schema migrations.
 * Creates the `identities`, `attestations`, and `slash_events`
 * tables if they do not already exist. Safe to call multiple times.
 *
 * All-or-nothing: on any failure a {@link MigrationError} is thrown and the
 * database is left exactly as it was. When called inside the caller's own
 * transaction it runs as a savepoint of that transaction.
 *
 * @param db - A better-sqlite3 Database instance.
 * @throws MigrationError on invalid/closed input, schema drift or SQLite failure.
 */
export function runMigrations(db: Database.Database): void {
  assertUsableDatabase(db);

  const migrate = db.transaction(() => {
    for (const migration of TABLE_MIGRATIONS) {
      try {
        db.exec(migration.ddl);
      } catch (err) {
        throw executionError(err, migration.table);
      }
      assertNoDrift(db, migration);
    }
  });

  try {
    migrate();
  } catch (err) {
    if (err instanceof MigrationError) throw err;
    // BEGIN/COMMIT failures (e.g. SQLITE_BUSY at commit) land here.
    throw executionError(err);
  }
}
