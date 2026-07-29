import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Pool, PoolClient } from 'pg'
import { TransactionManager, TransactionBudgetError, LockTimeoutError, LockTimeoutPolicy, PG_LOCK_TIMEOUT_CODE } from './transaction.js'

// ---------------------------------------------------------------------------
// Core contract: commit/rollback/return-value regression tests
//
// These tests lock in the fundamental guarantee of withTransaction:
//   • happy path  — operation succeeds → BEGIN then COMMIT, return value propagated
//   • sad path    — operation throws   → BEGIN then ROLLBACK, original error rethrows
//
// The mock setup deliberately avoids Date.now() / Math.random() so that the
// tests are fully deterministic. Budget limits are raised high (maxDurationMs
// and maxSavepoints) so the budget logic never interferes with these contract
// assertions; the budget behaviour is tested separately in the suite below.
// ---------------------------------------------------------------------------
describe('TransactionManager — core commit/rollback contract', () => {
  let mockPool: Pool
  let mockClient: PoolClient
  let txManager: TransactionManager

  // Generous budget: ensures budget logic never fires in these contract tests.
  const GENEROUS_OPTS = { maxDurationMs: 60_000, maxSavepoints: 100 }

  beforeEach(() => {
    mockClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    } as unknown as PoolClient

    mockPool = {
      connect: vi.fn().mockResolvedValue(mockClient),
    } as unknown as Pool

    txManager = new TransactionManager(mockPool)
  })

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it('commits_and_returns_value_on_success', async () => {
    const EXPECTED = { id: 42, name: 'alice' }

    const result = await txManager.withTransaction(
      async (_client) => EXPECTED,
      GENEROUS_OPTS,
    )

    // Return value must be propagated exactly — no copy, no mutation.
    expect(result).toBe(EXPECTED)

    // COMMIT must have been issued.
    const calls = (mockClient.query as ReturnType<typeof vi.fn>).mock.calls as string[][]
    expect(calls.some(([sql]) => sql === 'COMMIT')).toBe(true)
  })

  it('begin_is_issued_before_callback_on_success', async () => {
    const order: string[] = []

    ;(mockClient.query as ReturnType<typeof vi.fn>).mockImplementation(
      async (sql: string) => {
        if (typeof sql === 'string') order.push(sql)
        return { rows: [] }
      },
    )

    await txManager.withTransaction(async (_client) => {
      order.push('__CALLBACK__')
    }, GENEROUS_OPTS)

    const beginIdx = order.indexOf('BEGIN')
    const cbIdx = order.indexOf('__CALLBACK__')
    const commitIdx = order.indexOf('COMMIT')

    expect(beginIdx).toBeGreaterThanOrEqual(0)
    expect(cbIdx).toBeGreaterThan(beginIdx)
    expect(commitIdx).toBeGreaterThan(cbIdx)
  })

  it('does_not_call_rollback_on_success', async () => {
    await txManager.withTransaction(async (_client) => 'ok', GENEROUS_OPTS)

    const calls = (mockClient.query as ReturnType<typeof vi.fn>).mock.calls as string[][]
    expect(calls.some(([sql]) => sql === 'ROLLBACK')).toBe(false)
  })

  it('releases_connection_after_successful_commit', async () => {
    await txManager.withTransaction(async (_client) => 'ok', GENEROUS_OPTS)

    expect(mockClient.release).toHaveBeenCalledTimes(1)
  })

  it('propagates_primitive_return_value_on_success', async () => {
    const result = await txManager.withTransaction(
      async (_client) => 99,
      GENEROUS_OPTS,
    )
    expect(result).toBe(99)
  })

  // -------------------------------------------------------------------------
  // Sad path
  // -------------------------------------------------------------------------

  it('rolls_back_and_rethrows_on_failure', async () => {
    const ORIGINAL_ERROR = new Error('something went wrong inside the callback')

    await expect(
      txManager.withTransaction(async (_client) => {
        throw ORIGINAL_ERROR
      }, GENEROUS_OPTS),
    ).rejects.toThrow(ORIGINAL_ERROR)

    const calls = (mockClient.query as ReturnType<typeof vi.fn>).mock.calls as string[][]
    expect(calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true)
  })

  it('rollback_is_issued_before_error_propagates', async () => {
    const order: string[] = []

    ;(mockClient.query as ReturnType<typeof vi.fn>).mockImplementation(
      async (sql: string) => {
        if (typeof sql === 'string') order.push(sql)
        return { rows: [] }
      },
    )

    const boom = new Error('boom')
    await expect(
      txManager.withTransaction(async (_client) => {
        order.push('__CALLBACK__')
        throw boom
      }, GENEROUS_OPTS),
    ).rejects.toThrow(boom)

    const rollbackIdx = order.indexOf('ROLLBACK')
    const cbIdx = order.indexOf('__CALLBACK__')

    expect(rollbackIdx).toBeGreaterThan(cbIdx)
    // COMMIT must never appear when the callback throws.
    expect(order.includes('COMMIT')).toBe(false)
  })

  it('does_not_call_commit_on_failure', async () => {
    await expect(
      txManager.withTransaction(async (_client) => {
        throw new Error('fail')
      }, GENEROUS_OPTS),
    ).rejects.toThrow()

    const calls = (mockClient.query as ReturnType<typeof vi.fn>).mock.calls as string[][]
    expect(calls.some(([sql]) => sql === 'COMMIT')).toBe(false)
  })

  it('releases_connection_after_rollback', async () => {
    await expect(
      txManager.withTransaction(async (_client) => {
        throw new Error('fail')
      }, GENEROUS_OPTS),
    ).rejects.toThrow()

    // release() must always be called — connection must never leak.
    expect(mockClient.release).toHaveBeenCalledTimes(1)
  })

  it('error_identity_is_preserved_not_wrapped', async () => {
    class DomainError extends Error {
      constructor(public readonly code: string) {
        super(`domain error: ${code}`)
        this.name = 'DomainError'
      }
    }
    const original = new DomainError('INSUFFICIENT_FUNDS')

    let caught: unknown
    try {
      await txManager.withTransaction(async (_client) => {
        throw original
      }, GENEROUS_OPTS)
    } catch (err) {
      caught = err
    }

    // Must be the exact same object — withTransaction must not wrap it.
    expect(caught).toBe(original)
    expect((caught as DomainError).code).toBe('INSUFFICIENT_FUNDS')
  })

  // -------------------------------------------------------------------------
  // Lock-timeout sad path
  // -------------------------------------------------------------------------

  it('rolls_back_and_throws_LockTimeoutError_when_pg_returns_55P03', async () => {
    const lockErr = Object.assign(new Error('lock timeout'), {
      code: PG_LOCK_TIMEOUT_CODE,
    })

    ;(mockClient.query as ReturnType<typeof vi.fn>).mockImplementation(
      async (sql: string) => {
        if (sql === 'ROLLBACK') return { rows: [] }
        // Simulate the lock error on every query so it fires before the callback.
        throw lockErr
      },
    )

    await expect(
      txManager.withTransaction(async (_client) => 'never reached', {
        ...GENEROUS_OPTS,
        retryOnLockTimeout: false,
      }),
    ).rejects.toBeInstanceOf(LockTimeoutError)

    // Connection must still be released.
    expect(mockClient.release).toHaveBeenCalledTimes(1)
  })
})

describe('TransactionManager with budget', () => {
  let mockPool: Pool
  let mockClient: PoolClient
  let txManager: TransactionManager

  beforeEach(() => {
    mockClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    } as any

    mockPool = {
      connect: vi.fn().mockResolvedValue(mockClient),
    } as any

    txManager = new TransactionManager(mockPool)
  })

  it('should throw TransactionBudgetError when savepoints exceed maxSavepoints', async () => {
    await expect(
      txManager.withTransaction(async (client) => {
        // Create 9 savepoints (max is 8 by default)
        for (let i = 0; i < 9; i++) {
          await client.query(`SAVEPOINT sp_${i}`)
        }
      })
    ).rejects.toThrow(TransactionBudgetError)

    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('should throw TransactionBudgetError when duration exceeds maxDurationMs', async () => {
    // Mock Date.now to simulate elapsed time
    const originalNow = Date.now
    let callCount = 0
    vi.spyOn(Date, 'now').mockImplementation(() => {
      callCount++
      // First call is startTime, then next calls are during query
      return originalNow() + (callCount > 1 ? 3000 : 0) // 3000ms > default 2000ms
    })

    await expect(
      txManager.withTransaction(async (client) => {
        await client.query('SELECT 1')
      })
    ).rejects.toThrow(TransactionBudgetError)

    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK')
    vi.restoreAllMocks()
  })

  it('should succeed when within budget limits', async () => {
    const result = await txManager.withTransaction(async (client) => {
      await client.query('SAVEPOINT sp1')
      await client.query('SAVEPOINT sp2')
      return 'success'
    })

    expect(result).toBe('success')
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT')
  })

  it('should allow overriding maxDurationMs and maxSavepoints', async () => {
    const result = await txManager.withTransaction(async (client) => {
      for (let i = 0; i < 15; i++) {
        await client.query(`SAVEPOINT sp_${i}`)
      }
      return 'success'
    }, { maxSavepoints: 20, maxDurationMs: 10000 })

    expect(result).toBe('success')
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT')
  })
})
