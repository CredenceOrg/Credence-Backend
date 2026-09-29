import { describe, expect, it, vi } from 'vitest'
import type { QueryResult, QueryResultRow } from 'pg'
import type { Queryable } from '../repositories/queryable.js'
import { createSchema, dropSchema, resetDatabase } from '../schema.js'

function makeQueryable(
  implementation: (statement: string) => Promise<unknown> = async () => ({ rows: [], rowCount: 0 }),
): { db: Queryable; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async (statement: string) =>
    (await implementation(statement)) as QueryResult<QueryResultRow>,
  )
  return { db: { query } as Queryable, query }
}

describe('database schema lifecycle', () => {
  it('creates core and outbox schema in deterministic order', async () => {
    const { db, query } = makeQueryable()

    await createSchema(db)

    const statements = query.mock.calls.map(([statement]) => statement)
    expect(statements[0]).toContain('CREATE TABLE IF NOT EXISTS identities')
    expect(statements.some((statement) => statement.includes('CREATE TABLE IF NOT EXISTS event_outbox'))).toBe(true)
    expect(statements.some((statement) => statement.includes('event_outbox_status_created_idx'))).toBe(true)
    expect(statements.at(-1)).toContain('event_outbox_next_attempt_idx')
  })

  it('retains database boundary constraints in the emitted schema', async () => {
    const { db, query } = makeQueryable()

    await createSchema(db)

    const sql = query.mock.calls.map(([statement]) => statement).join('\n')
    expect(sql).toContain('length(trim(address)) > 0')
    expect(sql).toContain('version > 0')
    expect(sql).toContain('duration_days > 0')
    expect(sql).toContain('score BETWEEN 0 AND 100')
    expect(sql).toContain('UNIQUE (bond_id, attester_address, subject_address)')
  })

  it('can safely re-enter schema creation after a successful run', async () => {
    const { db, query } = makeQueryable()

    await createSchema(db)
    const statementCount = query.mock.calls.length
    await createSchema(db)

    expect(query).toHaveBeenCalledTimes(statementCount * 2)
    const statements = query.mock.calls.map(([statement]) => statement)
    expect(statements.slice(0, statementCount)).toEqual(statements.slice(statementCount))
    expect(statements.some((statement) => statement.includes('CREATE OR REPLACE TRIGGER trg_org_members_updated_at'))).toBe(true)
  })

  it('stops on the first DDL error and recovers when creation is retried', async () => {
    const failure = new Error('simulated DDL failure')
    let shouldFail = true
    const { db, query } = makeQueryable(async (statement) => {
      if (shouldFail && statement.includes('CREATE TABLE IF NOT EXISTS bonds')) {
        shouldFail = false
        throw failure
      }
      return { rows: [], rowCount: 0 }
    })

    await expect(createSchema(db)).rejects.toBe(failure)
    expect(query.mock.calls.map(([statement]) => statement)).toHaveLength(4)

    await expect(createSchema(db)).resolves.toBeUndefined()
    expect(query.mock.calls[4][0]).toContain('CREATE TABLE IF NOT EXISTS identities')
    expect(query.mock.calls.at(-1)?.[0]).toContain('event_outbox_next_attempt_idx')
  })

  it('propagates reset failures without masking the database error', async () => {
    const failure = new Error('permission denied')
    const { db, query } = makeQueryable(async () => {
      throw failure
    })

    await expect(resetDatabase(db)).rejects.toBe(failure)
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][0]).toContain('TRUNCATE TABLE')
  })

  it('includes outbox events in the reset boundary', async () => {
    const { db, query } = makeQueryable()

    await expect(resetDatabase(db)).resolves.toBeUndefined()

    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][0]).toMatch(/^TRUNCATE TABLE event_outbox, settlements/)
    expect(query.mock.calls[0][0]).toContain('RESTART IDENTITY CASCADE')
  })

  it('stops dropping schema after the first failed drop', async () => {
    const failure = new Error('drop rejected')
    const { db, query } = makeQueryable(async () => {
      throw failure
    })

    await expect(dropSchema(db)).rejects.toBe(failure)
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][0]).toBe('DROP TABLE IF EXISTS idempotent_job_attempts')
  })
})
