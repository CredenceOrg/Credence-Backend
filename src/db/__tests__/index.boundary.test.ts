import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type { Pool } from 'pg'
import { createDatabase, MigrationError, runMigrations, TransactionManager } from '../index.js'

/** Exercise the public database entry point, rather than importing its private modules. */
describe('src/db/index boundary and recovery', () => {
  const open: Database.Database[] = []
  const dirs: string[] = []

  function connect(path: string): Database.Database {
    const db = createDatabase(path)
    open.push(db)
    return db
  }

  function file(): string {
    const dir = mkdtempSync(join(tmpdir(), 'credence-db-entrypoint-'))
    dirs.push(dir)
    return join(dir, 'identity.db')
  }

  afterEach(() => {
    for (const db of open.splice(0)) if (db.open) db.close()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('opens isolated in-memory databases with constraints and applies schema only to the selected connection', () => {
    const first = connect(':memory:')
    const second = connect(':memory:')
    expect(first).not.toBe(second)
    expect(first.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(second.pragma('foreign_keys', { simple: true })).toBe(1)

    runMigrations(first)
    first.prepare('INSERT INTO identities (address) VALUES (?)').run('seller-1')
    expect(() => first.prepare('INSERT INTO identities (address) VALUES (?)').run('seller-1')).toThrow()
    expect(() => first.prepare('INSERT INTO attestations (verifier, identity_id) VALUES (?, ?)').run('verifier', 999)).toThrow()
    expect(second.prepare("SELECT name FROM sqlite_master WHERE name='identities'").get()).toBeUndefined()
  })

  it('preserves committed data across a closed connection and a repeated migration', () => {
    const path = file()
    const first = connect(path)
    runMigrations(first)
    first.prepare('INSERT INTO identities (address) VALUES (?)').run('seller-1')
    first.close()

    const closedError = (() => {
      try { runMigrations(first) } catch (error) { return error }
    })()
    expect(closedError).toBeInstanceOf(MigrationError)
    expect(closedError).toMatchObject({ reason: 'DATABASE_CLOSED' })

    const reopened = connect(path)
    runMigrations(reopened)
    runMigrations(reopened)
    expect(reopened.prepare('SELECT address FROM identities').all()).toEqual([{ address: 'seller-1' }])
  })

  it('surfaces a typed, value-free SQLITE_BUSY error and recovers after the writer releases its lock', () => {
    const path = file()
    const writer = connect(path)
    writer.exec('CREATE TABLE existing (value TEXT)')
    writer.prepare('INSERT INTO existing (value) VALUES (?)').run('private-row-value')
    const contender = connect(path)
    contender.pragma('busy_timeout = 0')

    writer.exec('BEGIN IMMEDIATE')
    let error: unknown
    try { runMigrations(contender) } catch (caught) { error = caught }
    expect(error).toBeInstanceOf(MigrationError)
    expect(error).toMatchObject({ reason: 'EXECUTION_FAILED', code: 'SQLITE_BUSY' })
    expect((error as Error).message).not.toContain('private-row-value')
    expect(writer.prepare("SELECT name FROM sqlite_master WHERE name='identities'").get()).toBeUndefined()
    writer.exec('COMMIT')

    runMigrations(contender)
    expect(contender.prepare('SELECT value FROM existing').all()).toEqual([{ value: 'private-row-value' }])
    expect(contender.prepare("SELECT name FROM sqlite_master WHERE name='identities'").get()).toEqual({ name: 'identities' })
  })

  it('rejects an invalid path without poisoning a later valid connection', () => {
    const path = file()
    expect(() => createDatabase(join(path, 'not-a-directory.db'))).toThrow()
    const recovered = connect(path)
    expect(() => runMigrations(recovered)).not.toThrow()
  })

  it('honors the explicit zero lock-timeout boundary through the public transaction export', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    const release = vi.fn()
    const client = { query, release }
    const pool = { connect: vi.fn(async () => client), query: vi.fn(async () => ({ rows: [] })) } as unknown as Pool
    const manager = new TransactionManager(pool)

    await expect(manager.withTransaction(async () => 'committed', { timeoutMs: 0 })).resolves.toBe('committed')
    expect(query).toHaveBeenCalledWith("SET LOCAL lock_timeout = '0ms'")
    expect(query).toHaveBeenCalledWith('COMMIT')
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('rolls back a failed transaction and preserves the original error for the caller', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    const release = vi.fn()
    const pool = {
      connect: vi.fn(async () => ({ query, release })),
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as Pool
    const failure = new Error('write failed')

    await expect(new TransactionManager(pool).withTransaction(async () => { throw failure })).rejects.toBe(failure)
    expect(query).toHaveBeenCalledWith('ROLLBACK')
    expect(query).not.toHaveBeenCalledWith('COMMIT')
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('keeps concurrent transaction clients isolated through the exported manager', async () => {
    const firstQuery = vi.fn(async () => ({ rows: [] }))
    const secondQuery = vi.fn(async () => ({ rows: [] }))
    const firstRelease = vi.fn()
    const secondRelease = vi.fn()
    const clients = [
      { query: firstQuery, release: firstRelease },
      { query: secondQuery, release: secondRelease },
    ]
    const pool = {
      connect: vi.fn(async () => clients.shift()),
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as Pool
    const manager = new TransactionManager(pool)
    let entered!: () => void
    let resume!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const barrier = new Promise<void>((resolve) => { resume = resolve })

    const first = manager.withTransaction(async (client) => {
      entered()
      await barrier
      await client.query('SELECT first')
      return 'first'
    })
    await started
    const second = await manager.withTransaction(async (client) => {
      await client.query('SELECT second')
      return 'second'
    })
    resume()
    expect(await first).toBe('first')
    expect(second).toBe('second')
    expect(firstQuery).toHaveBeenCalledWith('SELECT first')
    expect(firstQuery).not.toHaveBeenCalledWith('SELECT second')
    expect(secondQuery).toHaveBeenCalledWith('SELECT second')
    expect(secondQuery).not.toHaveBeenCalledWith('SELECT first')
    expect(firstRelease).toHaveBeenCalledTimes(1)
    expect(secondRelease).toHaveBeenCalledTimes(1)
  })
})
