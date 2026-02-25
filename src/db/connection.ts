import Database from 'better-sqlite3'

/**
 * Database connection singleton.
 * Uses a file-based SQLite database by default, or `:memory:` for testing.
 *
 * @param dbPath - Path to the SQLite database file. Defaults to `credence.db`.
 * @returns A better-sqlite3 Database instance with foreign keys enabled.
 */
export function createDatabase(dbPath: string = 'credence.db'): Database.Database {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  return db
}
