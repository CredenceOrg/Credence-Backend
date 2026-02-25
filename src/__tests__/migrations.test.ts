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
          "INSERT INTO attestations (verifier, identity_id) VALUES ('0xBAD', 999)"
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
})
