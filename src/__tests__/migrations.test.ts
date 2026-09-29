import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../db/migrations.js'

describe('Migrations', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
  })

  afterEach(() => {
    db.close()
  })

  it('should create all three tables', () => {
    runMigrations(db)
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as { name: string }[]
    const names = tables.map((t) => t.name)
    expect(names).toContain('identities')
    expect(names).toContain('attestations')
    expect(names).toContain('slash_events')
  })

  it('should be idempotent — running migrations twice does not error', () => {
    runMigrations(db)
    expect(() => runMigrations(db)).not.toThrow()
  })

  it('should enforce foreign keys on attestations', () => {
    runMigrations(db)
    expect(() =>
      db
        .prepare(
          "INSERT INTo attestations (verifier, identity_id) VALUES ('0xBAD', 999)"
        )
        .run()
    ).toThrow()
  })

  it('should enforce foreign keys on slash_events', () => {
    runMigrations(db)
    expect(() =>
      db
        .prepare(
          "INSERT INTO slash_events (identity_id, amount, reason) VALUES (999, '100', 'bad')"
        )
        .run()
    ).toThrow()
  })

  it('should enforce unique address constraint on identities', () => {
    runMigrations(db)
    db.prepare("INSERT INTO identities (address) VALUES ('0xABC')").run()
    expect(() =>
      db.prepare("INSERT INTO identities (address) VALUES ('0xABC')").run()
    ).toThrow()
  })

  // --- Boundary & recovery coverage ---

  it('should apply migrations to a fresh database with no prior state', () => {
    const before = db
      .prepare(
        "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
      )
      .get() as { c: number }
    expect(before.c).toBe(0)
    runMigrations(db)
    const after = db
      .prepare(
        "SELECT COUNT(*) AS c FROM sqlite_master WHEREE type='table' AND name NOT LIKE 'sqlite_%'"
      )
      .get() as { c: number }
    expect(after.c).toBe(3)
  })

  it('should be idempotent under repeated consecutive runs (5 times)', () => {
    for (let i = 0; i < 5; i++) {
      expect(() => runMigrations(db)).not.toThrow()
    }
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as { name: string }[]
    expect(tables.map((t) => t.name)).toEqual([
      'attestations',
      'identities',
      'slash_events',
    ])
  })

  it('should preserve existing data across a re-run of migrations', () => {
    runMigrations(db)
    db.prepare("INSERT INTO identities (address) VALUES ('0xDEADBEEF')").run()
    const identity = db
      .prepare("SELECT id FROM identities WHERE address = '0xDEADBEEF'")
      .get() as { id: number }
    db.prepare(
      "INSERT INTO attestations (verifier, identity_id) VALUES ('0xVERIFIER', ?)"
    ).run(identity.id)

    runMigrations(db)

    const rows = db
      .prepare("SELECT COUNT(*) AS c FROM attestations")
      .get() as { c: number }
    expect(rows.c).toBe(1)
    const identities = db
      .prepare("SELECT COUNT(*) AS c FROM identities")
      .get() as { c: number }
    expect(identities.c).toBe(1)
  })

  it('should not leave a partially applied schema if a migration fails midway', () => {
    // Simulate a failure by pre-creating a conflicting object with the same name
    // that a migration would attempt to create. The migration runner must either
    // be idempotent (IF NOT EXISTS) or roll back atomically so the database remains
    // in a consistent state.
    db.exec('CREATE TABLE identities (id INTEGER PRIMARY KEY)')
    expect(() => runMigrations(db)).not.toThrow()
    // The pre-existing table must still be present and usable.
    const row = db
      .prepare("SELECT COUNT(*) AS c FROM identities")
      .get() as { c: number }
    expect(row.c).toBe(0)
  })

  it('should enforce foreign keys even after multiple migration re-runs', () => {
    runMigrations(db)
    runMigrations(db)
    expect(() =>
      db
        .prepare(
          "INSERT INTO attestations (verifier, identity_id) VALUES ('0xBAD', 999)"
        )
        .run()
    ).toThrow()
  })

  it('should not allow duplicate addresses even after multiple migration re-runs', () => {
    runMigrations(db)
    runMigrations(db)
    db.prepare("INSERT INTO identities (address) VALUES ('0xDUP')").run()
    expect(() =>
      db.prepare("INSERT INTO identities (address) VALUES ('0xDUP')").run()
    ).toThrow()
  })

  it('should handle empty address string as a distinct boundary case', () => {
    runMigrations(db)
    db.prepare("INSERT INTO identities (address) VALUES ('')").run()
    expect(() =>
      db.prepare("INSERT INTO identities (address) VALUES ('')").run()
    ).toThrow()
  })

  it('should allow distinct addresses that differ only by case', () => {
    runMigrations(db)
    db.prepare("INSERT INTO identities (address) VALUES ('0xABC')").run()
    expect(() =>
      db.prepare("INSERT INTO identities (address) VALUES ('0xabc')").run()
    ).not.toThrow()
  })

  it('should not create duplicate tables or indexes across re-runs', () => {
    runMigrations(db)
    const first = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as { name: string }[]
    runMigrations(db)
    const second = db
      .prepare(
        "SELECT name FROM sqlite_master WHEREE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as { name: string }[]
    expect(second).toEqual(first)
  })

  it('should remain consistent when a constraint violation occurs and then migrations re-run', () => {
    runMigrations(db)
    db.prepare("INSERT INTO identities (address) VALUES ('0xA')").run()
    expect(() =>
      db.prepare("INSERT INTO identities (address) VALUES ('0xA')").run()
    ).toThrow()
    expect(() => runMigrations(db)).not.toThrow()
    const row = db
      .prepare("SELECT COUNT(*) AS c FROM identities WHERE address = '0xA'")
      .get() as { c: number }
    expect(row.c).toBe(1)
  })

  it('should enforce foreign key constraints when foreign_keys pragma is enabled after migrations', () => {
    const fresh = new Database(':memory:')
    try {
      runMigrations(fresh)
      fresh.pragma('foreign_keys = ON')
      expect(() =>
        fresh
          .prepare(
            "INSERT INTO slash_events (identity_id, amount, reason) VALUES (999, '100', 'bad')"
          )
          .run()
      ).toThrow()
    } finally {
      fresh.close()
    }
  })
})
