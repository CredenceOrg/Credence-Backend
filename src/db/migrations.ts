import type Database from "better-sqlite3";

/**
 * Run all idempotent schema migrations.
 * Creates the `identities`, `attestations`, and `slash_events`
 * tables if they do not already exist. Safe to call multiple times.
 *
 * @param db - A better-sqlite3 Database instance.
 */
export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS identities (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      address    TEXT    NOT NULL UNIQUE,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS attestations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      verifier    TEXT    NOT NULL,
      identity_id INTEGER NOT NULL,
      timestamp   TEXT    NOT NULL DEFAULT (datetime('now')),
      weight      REAL    NOT NULL DEFAULT 1.0,
      revoked     INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (identity_id) REFERENCES identities(id) ON DELETE CASCADE
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS slash_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      identity_id  INTEGER NOT NULL,
      amount       TEXT    NOT NULL,
      reason       TEXT    NOT NULL,
      evidence_ref TEXT,
      timestamp    TEXT    NOT NULL DEFAULT (datetime('now')),
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (identity_id) REFERENCES identities(id) ON DELETE CASCADE
    );
  `);
}
