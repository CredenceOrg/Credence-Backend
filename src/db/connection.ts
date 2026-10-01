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

/**
 * Opens a database connection with retry and recovery semantics.
 *
 * Invariants:
 * - On success, foreign keys are enabled and journal_mode is WAL (or memory).
 * - On failure, any partially opened handle is closed before retrying so we
 *   never leak file descriptors or leave a half-initialized connection.
 * - Retries are bounded and deterministic; the final failure is rethrown so
 *   callers can surface a diagnosable error without losing user data.
 *
 * @param dbPath - Path to the SQLite database file. Defaults to `credence.db`.
 * @param options - Retry configuration. `retries` is the number of additional
 *   attempts after the first; `backoffMs` is the base delay between attempts.
 * @returns A fully initialized better-sqlite3 Database instance.
 */
export function createDatabaseWithRecovery(
  dbPath: string = 'credence.db',
  options: { retries?: number; backoffMs?: number } = {}
): Database.Database {
  const retries = options.retries ?? 3
  const backoffMs = options.backoffMs ?? 50

  if (!Number.isInteger(retries) || retries < 0) {
    throw new RangeError('retries must be a non-negative integer')
  }
  if (!Number.isFinite(backoffMs) || backoffMs < 0) {
    throw new RangeError('backoffMs must be a non-negative finite number')
  }

  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    let db: Database.Database | undefined
    try {
      db = createDatabase(dbPath)
      // Verify the connection is usable before handing it back.
      db.prepare('SELECT 1').get()
      return db
    } catch (err) {
      lastError = err
      if (db) {
        try {
          db.close()
        } catch {
          // Ignore close errors; the original failure is what matters.
        }
      }
      if (attempt < retries && backoffMs > 0) {
        const delay = backoffMs * Math.pow(2, attempt)
        const deadline = Date.now() + delay
        while (Date.now() < deadline) {
          // Deterministic busy-wait keeps tests free of timers.
        }
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Failed to open database connection')
}

/**
 * Closes a database connection, swallowing errors so cleanup paths are safe
 * to call from `finally` blocks and recovery handlers.
 *
 * @param db - The database instance to close, or `undefined`/`null`.
 * @returns `true` if the handle was closed, `false` otherwise.
 */
export function closeDatabaseQuietly(
  db: Database.Database | undefined | null
): boolean {
  if (!db) return false
  try {
    db.close()
    return true
  } catch {
    return false
  }
}
