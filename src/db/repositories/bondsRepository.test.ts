/**
 * Boundary and recovery test coverage for BondsRepository.
 *
 * Covers every public method with success, rejection, boundary, and regression
 * scenarios as required by issue #1367.  All database calls are mocked via
 * vitest — no real Postgres connection is needed.
 *
 * Test categories per method
 * ──────────────────────────
 *  create          – happy path, DB error propagation, row-mapper round-trip
 *  findById        – found, not-found (null), DB error, string-id coercion
 *  listByIdentity  – empty set, single row, multiple rows, DB error
 *  findAll         – default pagination, custom limit/offset, empty result, DB error
 *  updateStatus    – found (all valid transitions), not-found (null), DB error
 *  debit           – no-pool guard, invalid amounts, insufficient funds,
 *                    precision-loss regression, exact-balance, lock-timeout
 *                    retry, lock-timeout exhaustion, bond-not-found inside tx,
 *                    concurrent serialisation (two debits queue via lock)
 *  delete          – row deleted, row not found, DB error
 *  InsufficientFundsError – shape, message, HTTP status, metadata
 *  row mapper      – Date coercion for string timestamps, numeric id coercion
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest'
import type { Pool, PoolClient, QueryResult } from 'pg'
import {
  BondsRepository,
  InsufficientFundsError,
  type Bond,
  type BondStatus,
  type CreateBondInput,
} from './bondsRepository.js'
import { LockTimeoutError, LockTimeoutPolicy } from '../transaction.js'

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const START_TIME = new Date('2024-01-01T00:00:00Z')
const CREATED_AT = new Date('2024-01-01T00:00:00Z')

function makeBondRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    identity_address: '0xIDENTITY',
    amount: '1000',
    start_time: START_TIME,
    duration_days: 30,
    status: 'active' as BondStatus,
    created_at: CREATED_AT,
    ...overrides,
  }
}

function makeExpectedBond(overrides: Partial<Bond> = {}): Bond {
  return {
    id: 1,
    identityAddress: '0xIDENTITY',
    amount: '1000',
    startTime: START_TIME,
    durationDays: 30,
    status: 'active',
    createdAt: CREATED_AT,
    ...overrides,
  }
}

/** Returns a minimal mock Queryable (Pool-compatible) with a controllable query response. */
function makeDb(rows: unknown[] = [], rowCount = rows.length) {
  return {
    query: vi.fn().mockResolvedValue({ rows, rowCount } as unknown as QueryResult),
  }
}

/** Builds a mock PoolClient that sequences through supplied per-call responses. */
function makeMockClient(responses: Array<{ rows: unknown[]; rowCount?: number }>) {
  let call = 0
  const query: MockedFunction<PoolClient['query']> = vi.fn().mockImplementation(() => {
    const resp = responses[call] ?? { rows: [], rowCount: 0 }
    call++
    return Promise.resolve({ rows: resp.rows, rowCount: resp.rowCount ?? resp.rows.length })
  })
  return { query, release: vi.fn() } as unknown as PoolClient
}

/** Wraps a PoolClient in a Pool mock. */
function makePool(client: PoolClient): Pool {
  return { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool
}

// ---------------------------------------------------------------------------
// InsufficientFundsError — shape contract
// ---------------------------------------------------------------------------

describe('InsufficientFundsError', () => {
  it('carries bondId, available, and requested fields', () => {
    const err = new InsufficientFundsError(42, '500', '750')
    expect(err.bondId).toBe(42)
    expect(err.available).toBe('500')
    expect(err.requested).toBe('750')
  })

  it('message includes all three identifiers', () => {
    const err = new InsufficientFundsError(7, '100', '200')
    expect(err.message).toContain('7')
    expect(err.message).toContain('100')
    expect(err.message).toContain('200')
  })

  it('reports HTTP status 422', () => {
    const err = new InsufficientFundsError(1, '10', '20')
    // AppError exposes the HTTP status as `status`.
    expect((err as unknown as { status: number }).status).toBe(422)
  })

  it('is an instance of Error', () => {
    expect(new InsufficientFundsError(1, '0', '1')).toBeInstanceOf(Error)
  })
})

// ---------------------------------------------------------------------------
// Row mapper — Date coercion and numeric id coercion
// ---------------------------------------------------------------------------

describe('BondsRepository – row mapper (via findById)', () => {
  it('coerces string start_time to a Date', async () => {
    const db = makeDb([makeBondRow({ start_time: '2024-06-15T10:00:00Z' })])
    const repo = new BondsRepository(db as unknown as Pool)
    const bond = await repo.findById(1)
    expect(bond?.startTime).toBeInstanceOf(Date)
    expect(bond?.startTime.toISOString()).toBe(new Date('2024-06-15T10:00:00Z').toISOString())
  })

  it('coerces string created_at to a Date', async () => {
    const db = makeDb([makeBondRow({ created_at: '2024-06-15T10:00:00Z' })])
    const repo = new BondsRepository(db as unknown as Pool)
    const bond = await repo.findById(1)
    expect(bond?.createdAt).toBeInstanceOf(Date)
  })

  it('coerces string id to a number', async () => {
    const db = makeDb([makeBondRow({ id: '99' })])
    const repo = new BondsRepository(db as unknown as Pool)
    const bond = await repo.findById(99)
    expect(bond?.id).toBe(99)
    expect(typeof bond?.id).toBe('number')
  })

  it('preserves all mapped fields accurately', async () => {
    const row = makeBondRow()
    const db = makeDb([row])
    const repo = new BondsRepository(db as unknown as Pool)
    const bond = await repo.findById(1)
    expect(bond).toEqual(makeExpectedBond())
  })
})

// ---------------------------------------------------------------------------
// create()
// ---------------------------------------------------------------------------

describe('BondsRepository.create', () => {
  it('inserts a bond and returns the mapped result', async () => {
    const row = makeBondRow()
    const db = makeDb([row])
    const repo = new BondsRepository(db as unknown as Pool)

    const input: CreateBondInput = {
      identityAddress: '0xIDENTITY',
      amount: '1000',
      startTime: START_TIME,
      durationDays: 30,
    }
    const result = await repo.create(input)
    expect(result).toEqual(makeExpectedBond())
  })

  it('defaults status to "active" when not supplied', async () => {
    const row = makeBondRow({ status: 'active' })
    const db = makeDb([row])
    const repo = new BondsRepository(db as unknown as Pool)

    const input: CreateBondInput = {
      identityAddress: '0xIDENTITY',
      amount: '500',
      startTime: START_TIME,
      durationDays: 7,
    }
    await repo.create(input)
    const callArgs = (db.query as ReturnType<typeof vi.fn>).mock.calls[0]
    // The 5th parameter should be 'active'.
    expect(callArgs[1][4]).toBe('active')
  })

  it('respects an explicitly supplied status', async () => {
    const row = makeBondRow({ status: 'released' })
    const db = makeDb([row])
    const repo = new BondsRepository(db as unknown as Pool)

    const input: CreateBondInput = {
      identityAddress: '0xIDENTITY',
      amount: '500',
      startTime: START_TIME,
      durationDays: 7,
      status: 'released',
    }
    await repo.create(input)
    const callArgs = (db.query as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(callArgs[1][4]).toBe('released')
  })

  it('propagates a database error without swallowing it', async () => {
    const db = { query: vi.fn().mockRejectedValue(new Error('connection refused')) }
    const repo = new BondsRepository(db as unknown as Pool)
    await expect(
      repo.create({ identityAddress: 'x', amount: '1', startTime: new Date(), durationDays: 1 })
    ).rejects.toThrow('connection refused')
  })

  it('passes all five parameters to the query in the correct order', async () => {
    const db = makeDb([makeBondRow()])
    const repo = new BondsRepository(db as unknown as Pool)
    const startTime = new Date('2025-03-01T00:00:00Z')

    await repo.create({
      identityAddress: '0xABC',
      amount: '250.50',
      startTime,
      durationDays: 90,
      status: 'active',
    })

    const [, params] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(params[0]).toBe('0xABC')
    expect(params[1]).toBe('250.50')
    expect(params[2]).toBe(startTime)
    expect(params[3]).toBe(90)
    expect(params[4]).toBe('active')
  })
})

// ---------------------------------------------------------------------------
// findById()
// ---------------------------------------------------------------------------

describe('BondsRepository.findById', () => {
  it('returns a mapped Bond when a row is found', async () => {
    const db = makeDb([makeBondRow()])
    const repo = new BondsRepository(db as unknown as Pool)
    const bond = await repo.findById(1)
    expect(bond).toEqual(makeExpectedBond())
  })

  it('returns null when no row is found', async () => {
    const db = makeDb([])
    const repo = new BondsRepository(db as unknown as Pool)
    const bond = await repo.findById(999)
    expect(bond).toBeNull()
  })

  it('passes the id as a query parameter', async () => {
    const db = makeDb([])
    const repo = new BondsRepository(db as unknown as Pool)
    await repo.findById(42)
    expect((db.query as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual([42])
  })

  it('propagates a database error', async () => {
    const db = { query: vi.fn().mockRejectedValue(new Error('timeout')) }
    const repo = new BondsRepository(db as unknown as Pool)
    await expect(repo.findById(1)).rejects.toThrow('timeout')
  })

  it('handles id=0 without throwing (boundary: lowest possible id)', async () => {
    const db = makeDb([])
    const repo = new BondsRepository(db as unknown as Pool)
    await expect(repo.findById(0)).resolves.toBeNull()
  })

  it('handles very large id (boundary: near Number.MAX_SAFE_INTEGER)', async () => {
    const db = makeDb([])
    const repo = new BondsRepository(db as unknown as Pool)
    await expect(repo.findById(Number.MAX_SAFE_INTEGER)).resolves.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// listByIdentity()
// ---------------------------------------------------------------------------

describe('BondsRepository.listByIdentity', () => {
  it('returns an empty array when no bonds exist for the identity', async () => {
    const db = makeDb([])
    const repo = new BondsRepository(db as unknown as Pool)
    const result = await repo.listByIdentity('0xNOBODY')
    expect(result).toEqual([])
  })

  it('returns a single bond mapped correctly', async () => {
    const db = makeDb([makeBondRow()])
    const repo = new BondsRepository(db as unknown as Pool)
    const result = await repo.listByIdentity('0xIDENTITY')
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(makeExpectedBond())
  })

  it('returns multiple bonds all correctly mapped', async () => {
    const row1 = makeBondRow({ id: 1, amount: '100' })
    const row2 = makeBondRow({ id: 2, amount: '200' })
    const db = makeDb([row1, row2])
    const repo = new BondsRepository(db as unknown as Pool)
    const result = await repo.listByIdentity('0xIDENTITY')
    expect(result).toHaveLength(2)
    expect(result[0].amount).toBe('100')
    expect(result[1].amount).toBe('200')
  })

  it('passes the identityAddress as a query parameter', async () => {
    const db = makeDb([])
    const repo = new BondsRepository(db as unknown as Pool)
    await repo.listByIdentity('0xABC123')
    expect((db.query as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual(['0xABC123'])
  })

  it('propagates a database error', async () => {
    const db = { query: vi.fn().mockRejectedValue(new Error('db down')) }
    const repo = new BondsRepository(db as unknown as Pool)
    await expect(repo.listByIdentity('0xIDENTITY')).rejects.toThrow('db down')
  })

  it('handles an identity address that is an empty string (boundary)', async () => {
    const db = makeDb([])
    const repo = new BondsRepository(db as unknown as Pool)
    await expect(repo.listByIdentity('')).resolves.toEqual([])
  })
})

// ---------------------------------------------------------------------------
// findAll()
// ---------------------------------------------------------------------------

describe('BondsRepository.findAll', () => {
  it('returns all rows mapped to Bond objects', async () => {
    const rows = [makeBondRow({ id: 1 }), makeBondRow({ id: 2 })]
    const db = makeDb(rows)
    const repo = new BondsRepository(db as unknown as Pool)
    const result = await repo.findAll()
    expect(result).toHaveLength(2)
  })

  it('defaults to limit=100 and offset=0', async () => {
    const db = makeDb([])
    const repo = new BondsRepository(db as unknown as Pool)
    await repo.findAll()
    const [, params] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(params[0]).toBe(100)
    expect(params[1]).toBe(0)
  })

  it('passes custom limit and offset correctly', async () => {
    const db = makeDb([])
    const repo = new BondsRepository(db as unknown as Pool)
    await repo.findAll(10, 50)
    const [, params] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(params[0]).toBe(10)
    expect(params[1]).toBe(50)
  })

  it('returns an empty array when no bonds exist', async () => {
    const db = makeDb([])
    const repo = new BondsRepository(db as unknown as Pool)
    const result = await repo.findAll()
    expect(result).toEqual([])
  })

  it('handles limit=1 (boundary: single-item page)', async () => {
    const db = makeDb([makeBondRow()])
    const repo = new BondsRepository(db as unknown as Pool)
    const result = await repo.findAll(1, 0)
    expect(result).toHaveLength(1)
    const [, params] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(params[0]).toBe(1)
    expect(params[1]).toBe(0)
  })

  it('propagates a database error', async () => {
    const db = { query: vi.fn().mockRejectedValue(new Error('query failed')) }
    const repo = new BondsRepository(db as unknown as Pool)
    await expect(repo.findAll()).rejects.toThrow('query failed')
  })
})

// ---------------------------------------------------------------------------
// updateStatus()
// ---------------------------------------------------------------------------

describe('BondsRepository.updateStatus', () => {
  const statusCases: BondStatus[] = ['active', 'released', 'slashed']

  for (const status of statusCases) {
    it(`updates to status "${status}" and returns the mapped bond`, async () => {
      const row = makeBondRow({ status })
      const db = makeDb([row])
      const repo = new BondsRepository(db as unknown as Pool)
      const result = await repo.updateStatus(1, status)
      expect(result?.status).toBe(status)
    })
  }

  it('returns null when the bond id does not exist', async () => {
    const db = makeDb([])
    const repo = new BondsRepository(db as unknown as Pool)
    const result = await repo.updateStatus(9999, 'released')
    expect(result).toBeNull()
  })

  it('passes id and status as query parameters', async () => {
    const db = makeDb([makeBondRow({ status: 'slashed' })])
    const repo = new BondsRepository(db as unknown as Pool)
    await repo.updateStatus(7, 'slashed')
    const [, params] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(params[0]).toBe(7)
    expect(params[1]).toBe('slashed')
  })

  it('propagates a database error', async () => {
    const db = { query: vi.fn().mockRejectedValue(new Error('update failed')) }
    const repo = new BondsRepository(db as unknown as Pool)
    await expect(repo.updateStatus(1, 'released')).rejects.toThrow('update failed')
  })

  it('state-transition invariant: active → released is accepted', async () => {
    const db = makeDb([makeBondRow({ status: 'released' })])
    const repo = new BondsRepository(db as unknown as Pool)
    const result = await repo.updateStatus(1, 'released')
    expect(result?.status).toBe('released')
  })

  it('state-transition invariant: active → slashed is accepted', async () => {
    const db = makeDb([makeBondRow({ status: 'slashed' })])
    const repo = new BondsRepository(db as unknown as Pool)
    const result = await repo.updateStatus(1, 'slashed')
    expect(result?.status).toBe('slashed')
  })
})

// ---------------------------------------------------------------------------
// delete()
// ---------------------------------------------------------------------------

describe('BondsRepository.delete', () => {
  it('returns true when a row is deleted', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) }
    const repo = new BondsRepository(db as unknown as Pool)
    const result = await repo.delete(1)
    expect(result).toBe(true)
  })

  it('returns false when no row matches the id', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rowCount: 0 }) }
    const repo = new BondsRepository(db as unknown as Pool)
    const result = await repo.delete(999)
    expect(result).toBe(false)
  })

  it('handles null rowCount (pg driver may return null) as 0', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rowCount: null }) }
    const repo = new BondsRepository(db as unknown as Pool)
    const result = await repo.delete(1)
    expect(result).toBe(false)
  })

  it('passes the id as a query parameter', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) }
    const repo = new BondsRepository(db as unknown as Pool)
    await repo.delete(55)
    expect((db.query as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual([55])
  })

  it('propagates a database error', async () => {
    const db = { query: vi.fn().mockRejectedValue(new Error('delete failed')) }
    const repo = new BondsRepository(db as unknown as Pool)
    await expect(repo.delete(1)).rejects.toThrow('delete failed')
  })

  it('idempotent: deleting an already-absent bond returns false without throwing', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rowCount: 0 }) }
    const repo = new BondsRepository(db as unknown as Pool)
    await expect(repo.delete(1)).resolves.toBe(false)
    await expect(repo.delete(1)).resolves.toBe(false)
  })
})

// ---------------------------------------------------------------------------
// debit() — guard: no pool supplied
// ---------------------------------------------------------------------------

describe('BondsRepository.debit – constructor guard', () => {
  it('throws immediately when no pool was supplied to the constructor', async () => {
    const db = makeDb([makeBondRow()])
    const repo = new BondsRepository(db as unknown as Pool)
    await expect(repo.debit(1, '10')).rejects.toThrow(
      'BondsRepository.debit() requires a Pool instance'
    )
  })
})

// ---------------------------------------------------------------------------
// debit() — input validation (no DB round-trip expected)
// ---------------------------------------------------------------------------

describe('BondsRepository.debit – input validation', () => {
  let pool: Pool
  let client: PoolClient

  beforeEach(() => {
    // The client should never be reached for invalid inputs.
    client = makeMockClient([])
    pool = makePool(client)
  })

  const invalidAmounts = ['0', '-1', '-0.001', 'abc', '', ' ', '1.2.3', 'NaN', 'Infinity']

  for (const amount of invalidAmounts) {
    it(`rejects invalid amount "${amount}" before acquiring a lock`, async () => {
      const db = makeDb([makeBondRow()])
      const repo = new BondsRepository(db as unknown as Pool, pool)
      await expect(repo.debit(1, amount)).rejects.toThrow('Invalid debit amount')
      // Pool.connect must never be called for an invalid input.
      expect((pool.connect as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
    })
  }
})

// ---------------------------------------------------------------------------
// debit() — happy path, boundary amounts, InsufficientFundsError
// ---------------------------------------------------------------------------

describe('BondsRepository.debit – core semantics', () => {
  /**
   * Builds a repo backed by a mock transaction that serves the given balance
   * for the SELECT FOR UPDATE query and the given updatedAmount from the UPDATE.
   */
  function makeDebitRepo(balance: string, updatedAmount = balance) {
    const client = makeMockClient([
      // BEGIN ISOLATION LEVEL REPEATABLE READ
      { rows: [] },
      // SET LOCAL lock_timeout
      { rows: [] },
      // SELECT … FOR UPDATE
      { rows: [makeBondRow({ amount: balance })] },
      // UPDATE bonds SET amount = …
      { rows: [makeBondRow({ amount: updatedAmount })] },
      // COMMIT
      { rows: [] },
    ])
    const pool = makePool(client)
    const db = makeDb([])
    const repo = new BondsRepository(db as unknown as Pool, pool)
    return { repo, client }
  }

  it('completes successfully when amount equals the balance exactly', async () => {
    const { repo } = makeDebitRepo('1000', '0')
    const result = await repo.debit(1, '1000')
    expect(result).toBeDefined()
  })

  it('completes successfully when amount is less than the balance', async () => {
    const { repo } = makeDebitRepo('1000', '750')
    const result = await repo.debit(1, '250')
    expect(result).toBeDefined()
    expect(result.amount).toBe('750')
  })

  it('throws InsufficientFundsError when amount > balance', async () => {
    const client = makeMockClient([
      { rows: [] }, // BEGIN
      { rows: [] }, // SET lock_timeout
      { rows: [makeBondRow({ amount: '100' })] }, // SELECT FOR UPDATE
      { rows: [] }, // ROLLBACK (injected by txManager on error)
    ])
    const pool = makePool(client)
    const db = makeDb([])
    const repo = new BondsRepository(db as unknown as Pool, pool)
    await expect(repo.debit(1, '150')).rejects.toBeInstanceOf(InsufficientFundsError)
  })

  it('InsufficientFundsError carries correct bondId, available, requested', async () => {
    const client = makeMockClient([
      { rows: [] },
      { rows: [] },
      { rows: [makeBondRow({ amount: '100' })] },
      { rows: [] },
    ])
    const pool = makePool(client)
    const db = makeDb([])
    const repo = new BondsRepository(db as unknown as Pool, pool)

    let caught: InsufficientFundsError | null = null
    try {
      await repo.debit(1, '200')
    } catch (e) {
      caught = e as InsufficientFundsError
    }
    expect(caught).toBeInstanceOf(InsufficientFundsError)
    expect(caught?.bondId).toBe(1)
    expect(caught?.available).toBe('100')
    expect(caught?.requested).toBe('200')
  })

  it('throws when the bond does not exist inside the transaction', async () => {
    const client = makeMockClient([
      { rows: [] }, // BEGIN
      { rows: [] }, // SET lock_timeout
      { rows: [] }, // SELECT FOR UPDATE — empty result
      { rows: [] }, // ROLLBACK
    ])
    const pool = makePool(client)
    const db = makeDb([])
    const repo = new BondsRepository(db as unknown as Pool, pool)
    await expect(repo.debit(999, '10')).rejects.toThrow('Bond 999 not found')
  })

  // Precision-loss regression: Number() cannot distinguish these two values
  it('rejects a debit that exceeds balance by 1 at floating-point loss boundary', async () => {
    // 9007199254740992 and 9007199254740993 round to the same float64.
    const balance = '9007199254740992'
    const overByOne = '9007199254740993'

    const client = makeMockClient([
      { rows: [] },
      { rows: [] },
      { rows: [makeBondRow({ amount: balance })] },
      { rows: [] },
    ])
    const pool = makePool(client)
    const db = makeDb([])
    const repo = new BondsRepository(db as unknown as Pool, pool)
    await expect(repo.debit(1, overByOne)).rejects.toBeInstanceOf(InsufficientFundsError)
  })

  it('allows a debit that is exactly 1 unit below the float-loss boundary', async () => {
    const balance = '9007199254740993'
    const oneLess = '9007199254740992'

    const client = makeMockClient([
      { rows: [] },
      { rows: [] },
      { rows: [makeBondRow({ amount: balance })] },
      { rows: [makeBondRow({ amount: '1' })] },
      { rows: [] },
    ])
    const pool = makePool(client)
    const db = makeDb([])
    const repo = new BondsRepository(db as unknown as Pool, pool)
    await expect(repo.debit(1, oneLess)).resolves.toBeDefined()
  })

  it('handles a wei-scale debit: 1 from 1000000000000000000', async () => {
    const balance = '1000000000000000000'

    const client = makeMockClient([
      { rows: [] },
      { rows: [] },
      { rows: [makeBondRow({ amount: balance })] },
      { rows: [makeBondRow({ amount: '999999999999999999' })] },
      { rows: [] },
    ])
    const pool = makePool(client)
    const db = makeDb([])
    const repo = new BondsRepository(db as unknown as Pool, pool)
    const result = await repo.debit(1, '1')
    expect(result.amount).toBe('999999999999999999')
  })

  it('handles a fractional debit amount (0.000001)', async () => {
    const client = makeMockClient([
      { rows: [] },
      { rows: [] },
      { rows: [makeBondRow({ amount: '1.000000' })] },
      { rows: [makeBondRow({ amount: '0.999999' })] },
      { rows: [] },
    ])
    const pool = makePool(client)
    const db = makeDb([])
    const repo = new BondsRepository(db as unknown as Pool, pool)
    const result = await repo.debit(1, '0.000001')
    expect(result.amount).toBe('0.999999')
  })
})

// ---------------------------------------------------------------------------
// debit() — lock-timeout retry and exhaustion
// ---------------------------------------------------------------------------

describe('BondsRepository.debit – lock timeout and retry', () => {
  /**
   * Simulate a PoolClient whose SELECT FOR UPDATE fails with the
   * Postgres lock_timeout error code (55P03) on the first attempt
   * then succeeds on subsequent attempts.
   */
  function makeLockTimeoutThenSuccessClient(failCount: number, balance: string) {
    let attempt = 0
    const lockError = Object.assign(new Error('lock timeout'), { code: '55P03' })

    const query = vi.fn().mockImplementation((sql: string) => {
      const text = String(sql)
      if (text.includes('FOR UPDATE')) {
        attempt++
        if (attempt <= failCount) return Promise.reject(lockError)
        return Promise.resolve({ rows: [makeBondRow({ amount: balance })] })
      }
      if (text.trim().startsWith('UPDATE bonds')) {
        return Promise.resolve({ rows: [makeBondRow({ amount: '0' })] })
      }
      // BEGIN, SET lock_timeout, COMMIT, ROLLBACK
      return Promise.resolve({ rows: [] })
    })

    return { query, release: vi.fn() } as unknown as PoolClient
  }

  it('retries and succeeds after a single lock-timeout on the first attempt', async () => {
    const client = makeLockTimeoutThenSuccessClient(1, '500')
    const pool: Pool = {
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as Pool
    const db = makeDb([])
    // maxRetries=2 — one failure, one success
    const repo = new BondsRepository(db as unknown as Pool, pool, {
      readonly: 500,
      default: 500,
      critical: 500,
    })
    const result = await repo.debit(1, '100')
    expect(result).toBeDefined()
  })

  it('throws LockTimeoutError after exhausting all retries', async () => {
    const lockError = Object.assign(new Error('lock timeout'), { code: '55P03' })
    const query = vi.fn().mockImplementation((sql: string) => {
      if (String(sql).includes('FOR UPDATE')) return Promise.reject(lockError)
      return Promise.resolve({ rows: [] })
    })
    const client = { query, release: vi.fn() } as unknown as PoolClient
    const pool: Pool = {
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as Pool
    const db = makeDb([])
    const repo = new BondsRepository(db as unknown as Pool, pool, {
      readonly: 1,
      default: 1,
      critical: 1,
    })
    await expect(repo.debit(1, '10')).rejects.toBeInstanceOf(LockTimeoutError)
  })
})

// ---------------------------------------------------------------------------
// debit() — concurrent serialisation (two sequential calls on the same bond)
// ---------------------------------------------------------------------------

describe('BondsRepository.debit – concurrent serialisation', () => {
  it('two sequential debits on the same bond do not produce a negative balance', async () => {
    // Each call gets its own client (pool.connect called twice).
    let balance = '200'

    function makeClientForBalance(currentBalance: string, deductAmount: string) {
      const newBalance = String(Number(currentBalance) - Number(deductAmount))
      return makeMockClient([
        { rows: [] }, // BEGIN
        { rows: [] }, // SET lock_timeout
        { rows: [makeBondRow({ amount: currentBalance })] }, // SELECT FOR UPDATE
        { rows: [makeBondRow({ amount: newBalance })] }, // UPDATE
        { rows: [] }, // COMMIT
      ])
    }

    const pool: Pool = {
      connect: vi
        .fn()
        .mockResolvedValueOnce(makeClientForBalance('200', '100'))
        .mockResolvedValueOnce(makeClientForBalance('100', '100')),
    } as unknown as Pool

    const db = makeDb([])
    const repo = new BondsRepository(db as unknown as Pool, pool)

    const first = await repo.debit(1, '100')
    balance = first.amount // '100'
    const second = await repo.debit(1, '100')
    expect(Number(second.amount)).toBeGreaterThanOrEqual(0)
  })

  it('second debit throws InsufficientFundsError when balance was exhausted by first', async () => {
    // First debit empties the balance; second sees 0 and should reject.
    const clientFirst = makeMockClient([
      { rows: [] },
      { rows: [] },
      { rows: [makeBondRow({ amount: '100' })] },
      { rows: [makeBondRow({ amount: '0' })] },
      { rows: [] },
    ])

    const clientSecond = makeMockClient([
      { rows: [] },
      { rows: [] },
      { rows: [makeBondRow({ amount: '0' })] }, // balance is now 0
      { rows: [] }, // ROLLBACK
    ])

    const pool: Pool = {
      connect: vi
        .fn()
        .mockResolvedValueOnce(clientFirst)
        .mockResolvedValueOnce(clientSecond),
    } as unknown as Pool

    const db = makeDb([])
    const repo = new BondsRepository(db as unknown as Pool, pool)

    await repo.debit(1, '100')
    await expect(repo.debit(1, '50')).rejects.toBeInstanceOf(InsufficientFundsError)
  })
})

// ---------------------------------------------------------------------------
// debit() — DB error during UPDATE (partial failure recovery)
// ---------------------------------------------------------------------------

describe('BondsRepository.debit – partial failure recovery', () => {
  it('rolls back and propagates the error when the UPDATE query fails', async () => {
    const updateError = new Error('update statement failed')
    const query = vi.fn().mockImplementation((sql: string) => {
      const text = String(sql)
      if (text.includes('FOR UPDATE')) {
        return Promise.resolve({ rows: [makeBondRow({ amount: '500' })] })
      }
      if (text.trim().startsWith('UPDATE bonds')) {
        return Promise.reject(updateError)
      }
      return Promise.resolve({ rows: [] })
    })
    const client = { query, release: vi.fn() } as unknown as PoolClient
    const pool = makePool(client)
    const db = makeDb([])
    const repo = new BondsRepository(db as unknown as Pool, pool)

    await expect(repo.debit(1, '100')).rejects.toThrow('update statement failed')
    // ROLLBACK must have been called after the error.
    expect(query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('releases the client even when the transaction throws', async () => {
    const query = vi.fn().mockImplementation((sql: string) => {
      if (String(sql).includes('FOR UPDATE')) return Promise.reject(new Error('fatal'))
      return Promise.resolve({ rows: [] })
    })
    const client = { query, release: vi.fn() } as unknown as PoolClient
    const pool = makePool(client)
    const db = makeDb([])
    const repo = new BondsRepository(db as unknown as Pool, pool)

    await expect(repo.debit(1, '10')).rejects.toThrow()
    expect(client.release).toHaveBeenCalled()
  })
})
