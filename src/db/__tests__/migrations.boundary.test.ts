import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MigrationError, runMigrations } from '../migrations.js'

/**
 * #1351 — boundary and recovery coverage for src/db/migrations.ts:
 * success, rejection, boundary, retry/recovery, concurrency and regression.
 */

const TABLES = ['attestations', 'identities', 'slash_events']

const EXPECTED_COLUMNS: Record<string, string[]> = {
  identities: ['id', 'address', 'tenant_id', 'created_at'],
  attestations: ['id', 'verifier', 'identity_id', 'timestamp', 'weight', 'revoked', 'created_at', 'tenant_id'],
  slash_events: ['id', 'identity_id', 'amount', 'reason', 'evidence_ref', 'timestamp', 'created_at', 'tenant_id'],
}

function tableNames(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[]
  ).map((row) => row.name)
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
}

function captureError(fn: () => void): MigrationError {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(MigrationError)
    return err as MigrationError
  }
  throw new Error('expected runMigrations to throw')
}

describe('runMigrations — in-memory database', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
  })

  afterEach(() => {
    if (db.open) db.close()
  })

  // ── Success ────────────────────────────────────────────────────────────────

  it('creates every table with exactly the documented columns', () => {
    runMigrations(db)
    expect(tableNames(db)).toEqual(TABLES)
    for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
      expect(columnNames(db, table)).toEqual(columns)
    }
  })

  it('is idempotent and never loses existing rows across repeated runs', () => {
    runMigrations(db)
    const { lastInsertRowid } = db.prepare("INSERT INTO identities (address, tenant_id) VALUES ('0xA', 't1')").run()
    db.prepare('INSERT INTO attestations (verifier, identity_id) VALUES (?, ?)').run('0xV', lastInsertRowid)
    db.prepare("INSERT INTO slash_events (identity_id, amount, reason) VALUES (?, '5', 'r')").run(lastInsertRowid)

    for (let i = 0; i < 3; i++) runMigrations(db)

    expect(db.prepare('SELECT address, tenant_id FROM identities').all()).toEqual([{ address: '0xA', tenant_id: 't1' }])
    expect(db.prepare('SELECT COUNT(*) AS n FROM attestations').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM slash_events').get()).toEqual({ n: 1 })
  })

  it('composes with a caller transaction (runs as a savepoint)', () => {
    const outer = db.transaction(() => {
      runMigrations(db)
      expect(tableNames(db)).toEqual(TABLES)
      throw new Error('caller aborts')
    })
    expect(() => outer()).toThrow('caller aborts')
    // The caller's rollback undoes the migration too — no half-migrated state.
    expect(tableNames(db)).toEqual([])
    runMigrations(db)
    expect(tableNames(db)).toEqual(TABLES)
  })

  // ── Rejection ──────────────────────────────────────────────────────────────

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a plain object', {}],
    ['a string', 'db.sqlite'],
    ['an object with only exec', { exec: () => undefined }],
  ])('rejects %s with INVALID_DATABASE', (_label, input) => {
    const err = captureError(() => runMigrations(input as unknown as Database.Database))
    expect(err.reason).toBe('INVALID_DATABASE')
  })

  it('rejects a closed connection with DATABASE_CLOSED instead of a TypeError', () => {
    db.close()
    const err = captureError(() => runMigrations(db))
    expect(err.reason).toBe('DATABASE_CLOSED')
  })

  it('rejects a stale identities table (schema drift) and creates nothing else', () => {
    db.exec('CREATE TABLE identities (address TEXT PRIMARY KEY)')
    db.prepare("INSERT INTO identities (address) VALUES ('0xSECRET-ADDRESS')").run()

    const err = captureError(() => runMigrations(db))
    expect(err.reason).toBe('SCHEMA_DRIFT')
    expect(err.table).toBe('identities')
    expect(err.message).toContain('id, tenant_id, created_at')
    // Diagnosable without leaking row contents.
    expect(err.message).not.toContain('0xSECRET-ADDRESS')

    // Atomic: dependent tables were not created on top of the stale one,
    // and the stale table's data is untouched.
    expect(tableNames(db)).toEqual(['identities'])
    expect(db.prepare('SELECT address FROM identities').all()).toEqual([{ address: '0xSECRET-ADDRESS' }])
  })

  it('rolls back tables created earlier in the same run when a later table has drifted', () => {
    db.exec('CREATE TABLE slash_events (id INTEGER PRIMARY KEY, identity_id INTEGER, amount TEXT, reason TEXT)')

    const err = captureError(() => runMigrations(db))
    expect(err.reason).toBe('SCHEMA_DRIFT')
    expect(err.table).toBe('slash_events')
    expect(err.message).toContain('evidence_ref, timestamp, created_at, tenant_id')
    // identities/attestations were created in this run, then rolled back.
    expect(tableNames(db)).toEqual(['slash_events'])
  })

  // ── Boundary ───────────────────────────────────────────────────────────────

  it('accepts an existing table that has extra columns (superset schema)', () => {
    runMigrations(db)
    db.exec('ALTER TABLE identities ADD COLUMN display_name TEXT')
    expect(() => runMigrations(db)).not.toThrow()
    expect(columnNames(db, 'identities')).toContain('display_name')
  })

  it('completes a partially migrated database (only identities present)', () => {
    db.exec(`CREATE TABLE identities (
      id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL UNIQUE,
      tenant_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`)
    db.prepare("INSERT INTO identities (address) VALUES ('0xKEEP')").run()

    runMigrations(db)
    expect(tableNames(db)).toEqual(TABLES)
    expect(db.prepare('SELECT address FROM identities').all()).toEqual([{ address: '0xKEEP' }])
  })

  // ── Retry / recovery ───────────────────────────────────────────────────────

  it('leaves no partial schema when a statement fails mid-run, and a retry recovers', () => {
    const realExec = db.exec.bind(db)
    const execSpy = vi.spyOn(db, 'exec').mockImplementation((sql: string) => {
      if (sql.includes('CREATE TABLE IF NOT EXISTS attestations')) {
        throw Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' })
      }
      return realExec(sql)
    })

    const err = captureError(() => runMigrations(db))
    expect(err.reason).toBe('EXECUTION_FAILED')
    expect(err.table).toBe('attestations')
    expect(err.code).toBe('SQLITE_IOERR')
    expect((err.cause as Error).message).toBe('disk I/O error')
    // identities was created before the failure and rolled back with it.
    expect(tableNames(db)).toEqual([])

    execSpy.mockRestore()
    runMigrations(db)
    expect(tableNames(db)).toEqual(TABLES)
  })

  // ── Regression: constraints still enforced ─────────────────────────────────

  it('keeps foreign keys, cascades and the unique address constraint', () => {
    runMigrations(db)
    const { lastInsertRowid } = db.prepare("INSERT INTO identities (address) VALUES ('0xC')").run()
    db.prepare("INSERT INTO attestations (verifier, identity_id) VALUES ('0xV', ?)").run(lastInsertRowid)
    db.prepare("INSERT INTO slash_events (identity_id, amount, reason) VALUES (?, '1', 'r')").run(lastInsertRowid)

    expect(() => db.prepare("INSERT INTO identities (address) VALUES ('0xC')").run()).toThrow()
    expect(() => db.prepare("INSERT INTO attestations (verifier, identity_id) VALUES ('0xV', 999)").run()).toThrow()

    db.prepare('DELETE FROM identities WHERE id = ?').run(lastInsertRowid)
    expect(db.prepare('SELECT COUNT(*) AS n FROM attestations').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM slash_events').get()).toEqual({ n: 0 })
  })

  it('applies column defaults for boundary inserts', () => {
    runMigrations(db)
    const { lastInsertRowid } = db.prepare("INSERT INTO identities (address) VALUES ('0xD')").run()
    db.prepare("INSERT INTO attestations (verifier, identity_id) VALUES ('0xV', ?)").run(lastInsertRowid)
    const row = db.prepare('SELECT weight, revoked, tenant_id FROM attestations').get()
    expect(row).toEqual({ weight: 1, revoked: 0, tenant_id: null })
  })
})

describe('runMigrations — file database (permissions and concurrency)', () => {
  let dir: string
  let file: string
  const open: Database.Database[] = []

  function connect(options?: Database.Options): Database.Database {
    const conn = new Database(file, options)
    open.push(conn)
    return conn
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'credence-migrations-'))
    file = join(dir, 'test.db')
  })

  afterEach(() => {
    for (const conn of open.splice(0)) if (conn.open) conn.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('is a no-op on a read-only connection whose schema is already complete', () => {
    runMigrations(connect())
    const readonly = connect({ readonly: true })
    expect(() => runMigrations(readonly)).not.toThrow()
  })

  it('fails with SQLITE_READONLY on a read-only connection that needs changes', () => {
    connect().exec('CREATE TABLE placeholder (x INTEGER)') // create the file
    const readonly = connect({ readonly: true })

    const err = captureError(() => runMigrations(readonly))
    expect(err.reason).toBe('EXECUTION_FAILED')
    expect(err.code).toBe('SQLITE_READONLY')
    expect(tableNames(connect())).toEqual(['placeholder'])
  })

  it('fails fast with SQLITE_BUSY while another connection holds the write lock, then a retry succeeds', () => {
    const holder = connect()
    holder.exec('CREATE TABLE placeholder (x INTEGER)')
    const contender = connect({ timeout: 0 })

    holder.exec('BEGIN IMMEDIATE') // another migrator mid-flight
    const err = captureError(() => runMigrations(contender))
    expect(err.reason).toBe('EXECUTION_FAILED')
    expect(err.code).toBe('SQLITE_BUSY')
    holder.exec('COMMIT')

    // Nothing was half-created by the failed attempt; the retry completes it.
    expect(tableNames(holder)).toEqual(['placeholder'])
    runMigrations(contender)
    expect(tableNames(holder)).toEqual([...TABLES, 'placeholder'].sort())
  })

  it('converges when several connections migrate the same database', () => {
    const connections = [connect(), connect(), connect()]
    connections.forEach((conn) => runMigrations(conn))
    connections.forEach((conn) => runMigrations(conn))

    for (const conn of connections) expect(tableNames(conn)).toEqual(TABLES)
  })
})
