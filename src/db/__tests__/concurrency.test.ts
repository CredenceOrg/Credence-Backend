/**
 * Concurrency regression tests for the db/ persistence layer.
 *
 * These unit tests prove the invariants described in docs/DB_CONCURRENCY.md
 * without requiring a live PostgreSQL instance. Each test group maps to a
 * specific gap identified during the concurrency audit:
 *
 *   1. settlementsRepository._upsert — atomic xmax-based duplicate detection
 *   2. settlementsRepository.upsertBatch — TransactionManager atomicity
 *   3. retry.ts — ConflictError with retry-after contract
 *   4. transaction.ts — no partial state across failed + retried transactions
 *   5. Post-commit / rollback hook isolation under concurrent failures
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PoolClient } from 'pg'
import {
  withRetryableTransaction,
  withRetryableTransactionManager,
  ConflictError,
  MaxRetriesExhaustedError,
  RETRYABLE_ERROR_CODES,
  NON_RETRYABLE_ERROR_CODES,
  classifyConflict,
} from '../retry.js'
import {
  TransactionManager,
  runPostCommit,
  runRollback,
  LockTimeoutError,
  LockTimeoutPolicy,
  PG_LOCK_TIMEOUT_CODE,
} from '../transaction.js'
import { SettlementsRepository } from '../repositories/settlementsRepository.js'

// ---------------------------------------------------------------------------
// Shared mock logger
// ---------------------------------------------------------------------------
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeClient(queryImpl?: (sql: string, ...args: any[]) => any): PoolClient {
  return {
    query: vi.fn().mockImplementation(async (sql: string, ...args: any[]) => {
      if (queryImpl) return queryImpl(sql, ...args)
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(),
  } as unknown as PoolClient
}

function makePool(client?: PoolClient) {
  const c = client ?? makeClient()
  return {
    connect: vi.fn().mockResolvedValue(c),
    _client: c,
  }
}

// ---------------------------------------------------------------------------
// 1. settlementsRepository._upsert — atomic xmax duplicate detection
// ---------------------------------------------------------------------------
describe('SettlementsRepository._upsert — atomic duplicate detection', () => {
  it('isDuplicate = false when xmax = 0 (fresh insert)', async () => {
    const client = makeClient((sql: string) => {
      if (sql.includes('INSERT INTO settlements')) {
        return { rows: [{ id: '1', bond_id: '42', amount: '100', transaction_hash: 'tx-abc',
          settled_at: new Date(), status: 'pending', created_at: new Date(), updated_at: new Date(),
          xmax: '0' }] }
      }
      return { rows: [], rowCount: 0 }
    })

    const repo = new SettlementsRepository(client)
    const result = await repo.upsert({
      bondId: '42',
      amount: '100',
      transactionHash: 'tx-abc',
    })

    expect(result.isDuplicate).toBe(false)
    expect(result.settlement.transactionHash).toBe('tx-abc')
  })

  it('isDuplicate = true when xmax > 0 (conflict hit on existing row)', async () => {
    const client = makeClient((sql: string) => {
      if (sql.includes('INSERT INTO settlements')) {
        return { rows: [{ id: '1', bond_id: '42', amount: '100', transaction_hash: 'tx-dup',
          settled_at: new Date(), status: 'pending', created_at: new Date(), updated_at: new Date(),
          xmax: '12345' }] }
      }
      return { rows: [], rowCount: 0 }
    })

    const repo = new SettlementsRepository(client)
    const result = await repo.upsert({
      bondId: '42',
      amount: '100',
      transactionHash: 'tx-dup',
    })

    expect(result.isDuplicate).toBe(true)
  })

  it('does NOT issue a separate SELECT before the INSERT (no TOCTOU select)', async () => {
    const queries: string[] = []
    const client = makeClient((sql: string) => {
      queries.push(sql.trim().split(/\s+/)[0].toUpperCase())
      if (sql.trim().toUpperCase().startsWith('INSERT')) {
        return { rows: [{ id: '1', bond_id: '1', amount: '10', transaction_hash: 'txh',
          settled_at: new Date(), status: 'pending', created_at: new Date(), updated_at: new Date(),
          xmax: '0' }] }
      }
      return { rows: [], rowCount: 0 }
    })

    const repo = new SettlementsRepository(client)
    await repo.upsert({ bondId: '1', amount: '10', transactionHash: 'txh' })

    // Only INSERT should have been issued — no leading SELECT
    const selectQueries = queries.filter(q => q === 'SELECT')
    expect(selectQueries).toHaveLength(0)
    expect(queries.filter(q => q === 'INSERT')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 2. settlementsRepository.upsertBatch — TransactionManager atomicity
// ---------------------------------------------------------------------------
describe('SettlementsRepository.upsertBatch — transactional atomicity', () => {
  it('uses TransactionManager.withTransaction when pool is provided', async () => {
    const insertRows = (hash: string) => ({
      rows: [{ id: '1', bond_id: '1', amount: '10', transaction_hash: hash,
        settled_at: new Date(), status: 'pending', created_at: new Date(), updated_at: new Date(),
        xmax: '0' }],
    })
    const client = makeClient((sql: string, ...args: any[]) => {
      if (sql.trim().toUpperCase().startsWith('INSERT')) {
        // Return result keyed on the 3rd param (transactionHash)
        return insertRows(args[0]?.[2] ?? 'tx')
      }
      return { rows: [], rowCount: 0 }
    })
    const pool = { ...makePool(client), query: vi.fn() } as any

    // Wrap so we can spy on withTransaction
    const txManager = new TransactionManager(pool)
    const withTxSpy = vi.spyOn(txManager, 'withTransaction')

    // Inject our spy txManager by constructing repo with pool
    const repo = new SettlementsRepository(pool, pool)
    // Replace the internal txManager via the spy approach
    ;(repo as any).txManager = txManager

    await repo.upsertBatch([
      { bondId: '1', amount: '10', transactionHash: 'tx-1' },
      { bondId: '1', amount: '20', transactionHash: 'tx-2' },
    ])

    expect(withTxSpy).toHaveBeenCalledTimes(1)
  })

  it('rolls back all inserts if one fails mid-batch', async () => {
    let insertCount = 0
    const client = makeClient((sql: string) => {
      if (sql.trim().toUpperCase().startsWith('BEGIN')) return { rows: [], rowCount: 0 }
      if (sql.trim().toUpperCase().startsWith('ROLLBACK')) return { rows: [], rowCount: 0 }
      if (sql.trim().toUpperCase().startsWith('SET')) return { rows: [], rowCount: 0 }
      if (sql.trim().toUpperCase().startsWith('SELECT')) return { rows: [], rowCount: 0 }
      if (sql.trim().toUpperCase().startsWith('INSERT')) {
        insertCount++
        if (insertCount === 2) {
          const err = Object.assign(new Error('fk violation'), { code: NON_RETRYABLE_ERROR_CODES.FOREIGN_KEY_VIOLATION })
          throw err
        }
        return { rows: [{ id: '1', bond_id: '1', amount: '10', transaction_hash: `tx-${insertCount}`,
          settled_at: new Date(), status: 'pending', created_at: new Date(), updated_at: new Date(),
          xmax: '0' }] }
      }
      return { rows: [], rowCount: 0 }
    })
    const pool = makePool(client) as any

    const repo = new SettlementsRepository(pool, pool)

    await expect(
      repo.upsertBatch([
        { bondId: '1', amount: '10', transactionHash: 'tx-ok' },
        { bondId: '1', amount: '20', transactionHash: 'tx-bad' },
      ])
    ).rejects.toThrow('fk violation')

    // ROLLBACK must have been issued (not COMMIT)
    const calls: string[] = (client.query as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: any[]) => (typeof c[0] === 'string' ? c[0].trim().toUpperCase() : ''),
    )
    expect(calls.some(c => c === 'ROLLBACK')).toBe(true)
    expect(calls.every(c => c !== 'COMMIT')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. ConflictError — retry contract surface
// ---------------------------------------------------------------------------
describe('ConflictError — explicit retry contract', () => {
  it('is thrown (not MaxRetriesExhaustedError) when retries are exhausted on serialization failure', async () => {
    const serErr = Object.assign(new Error('could not serialize access due to concurrent update'), {
      code: RETRYABLE_ERROR_CODES.SERIALIZATION_FAILURE,
    })
    const pool = makePool()
    const fn = vi.fn().mockRejectedValue(serErr)

    await expect(
      withRetryableTransaction(pool, fn, { maxRetries: 2, initialBackoffMs: 0, operationName: 'ser-test' })
    ).rejects.toBeInstanceOf(ConflictError)
  })

  it('ConflictError carries conflictCode = serialization_failure', async () => {
    const serErr = Object.assign(new Error('serialization'), { code: RETRYABLE_ERROR_CODES.SERIALIZATION_FAILURE })
    const pool = makePool()
    const fn = vi.fn().mockRejectedValue(serErr)

    let caught: ConflictError | undefined
    try {
      await withRetryableTransaction(pool, fn, { maxRetries: 1, initialBackoffMs: 0 })
    } catch (e) {
      caught = e as ConflictError
    }

    expect(caught).toBeInstanceOf(ConflictError)
    expect(caught?.conflictCode).toBe('serialization_failure')
    expect(caught?.attempts).toBe(1)
    expect(typeof caught?.retryAfterSeconds).toBe('number')
  })

  it('ConflictError carries conflictCode = deadlock on DEADLOCK_DETECTED', async () => {
    const deadlockErr = Object.assign(new Error('deadlock detected'), { code: RETRYABLE_ERROR_CODES.DEADLOCK_DETECTED })
    const pool = makePool()
    const fn = vi.fn().mockRejectedValue(deadlockErr)

    let caught: ConflictError | undefined
    try {
      await withRetryableTransaction(pool, fn, { maxRetries: 1, initialBackoffMs: 0 })
    } catch (e) {
      caught = e as ConflictError
    }

    expect(caught).toBeInstanceOf(ConflictError)
    expect(caught?.conflictCode).toBe('deadlock')
  })

  it('ConflictError carries conflictCode = lock_timeout on PG 55P03', async () => {
    const lockErr = Object.assign(new Error('lock timeout'), { code: PG_LOCK_TIMEOUT_CODE })
    const pool = makePool()
    const fn = vi.fn().mockRejectedValue(lockErr)

    let caught: ConflictError | undefined
    try {
      await withRetryableTransaction(pool, fn, { maxRetries: 1, initialBackoffMs: 0 })
    } catch (e) {
      caught = e as ConflictError
    }

    expect(caught).toBeInstanceOf(ConflictError)
    expect(caught?.conflictCode).toBe('lock_timeout')
  })

  it('non-retryable errors are NOT wrapped in ConflictError', async () => {
    const uniqueErr = Object.assign(new Error('unique violation'), { code: NON_RETRYABLE_ERROR_CODES.UNIQUE_VIOLATION })
    const pool = makePool()
    const fn = vi.fn().mockRejectedValue(uniqueErr)

    await expect(
      withRetryableTransaction(pool, fn, { maxRetries: 3, initialBackoffMs: 0 })
    ).rejects.not.toBeInstanceOf(ConflictError)

    // Should throw the original error directly, attempt count = 1
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('withRetryableTransactionManager also emits ConflictError on conflict exhaustion', async () => {
    const serErr = Object.assign(new Error('serialization'), { code: RETRYABLE_ERROR_CODES.SERIALIZATION_FAILURE })
    const mockTxManager = {
      withTransaction: vi.fn().mockRejectedValue(serErr),
    }

    let caught: unknown
    try {
      await withRetryableTransactionManager(mockTxManager, vi.fn(), {
        maxRetries: 2,
        initialBackoffMs: 0,
        operationName: 'tm-conflict-test',
      })
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(ConflictError)
    expect((caught as ConflictError).conflictCode).toBe('serialization_failure')
  })
})

// ---------------------------------------------------------------------------
// 4. classifyConflict helper
// ---------------------------------------------------------------------------
describe('classifyConflict', () => {
  it('classifies SERIALIZATION_FAILURE', () => {
    expect(classifyConflict({ code: '40001' })).toBe('serialization_failure')
  })
  it('classifies DEADLOCK_DETECTED', () => {
    expect(classifyConflict({ code: '40P01' })).toBe('deadlock')
  })
  it('classifies lock_timeout (55P03)', () => {
    expect(classifyConflict({ code: '55P03' })).toBe('lock_timeout')
  })
  it('returns undefined for non-conflict errors', () => {
    expect(classifyConflict({ code: '23505' })).toBeUndefined()
    expect(classifyConflict({ code: 'XX000' })).toBeUndefined()
    expect(classifyConflict(null)).toBeUndefined()
    expect(classifyConflict(undefined)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 5. Partial state — no partial commits on multi-step failures
// ---------------------------------------------------------------------------
describe('Partial state guarantees under failure', () => {
  let mockPool: { connect: ReturnType<typeof vi.fn> }
  let mockClient: PoolClient
  let txManager: TransactionManager

  beforeEach(() => {
    mockClient = makeClient()
    mockPool = { connect: vi.fn().mockResolvedValue(mockClient) }
    txManager = new TransactionManager(mockPool as any)
  })

  it('post-commit hooks NEVER fire when transaction fails', async () => {
    const postHook = vi.fn()

    await expect(
      txManager.withTransaction(async () => {
        await runPostCommit(postHook)
        throw new Error('simulated db error')
      })
    ).rejects.toThrow('simulated db error')

    expect(postHook).not.toHaveBeenCalled()
  })

  it('rollback hooks fire exactly once per failed attempt', async () => {
    const rollbackHook = vi.fn()

    await expect(
      txManager.withTransaction(async () => {
        await runRollback(rollbackHook)
        throw new Error('fail')
      })
    ).rejects.toThrow()

    expect(rollbackHook).toHaveBeenCalledTimes(1)
  })

  it('repeated failed transactions accumulate NO shared state', async () => {
    const sideEffects: string[] = []

    for (let i = 0; i < 5; i++) {
      await expect(
        txManager.withTransaction(async () => {
          await runPostCommit(async () => sideEffects.push(`post:${i}`))
          await runRollback(async () => sideEffects.push(`rollback:${i}`))
          throw new Error(`attempt ${i}`)
        })
      ).rejects.toThrow()
    }

    // Post-commit hooks NEVER fired
    expect(sideEffects.filter(s => s.startsWith('post:'))).toHaveLength(0)
    // Rollback hooks fired exactly once per attempt
    expect(sideEffects.filter(s => s.startsWith('rollback:'))).toHaveLength(5)
    // COMMIT was never called
    const queries: string[] = (mockClient.query as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: any[]) => (typeof c[0] === 'string' ? c[0].trim() : ''),
    )
    expect(queries.every(q => q !== 'COMMIT')).toBe(true)
  })

  it('lock timeout on retry leaves no partial state and emits LockTimeoutError', async () => {
    const lockErr = Object.assign(new Error('lock timeout'), { code: PG_LOCK_TIMEOUT_CODE })
    vi.mocked(mockClient.query).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && (sql.trim() === 'BEGIN' || sql.includes('ISOLATION LEVEL') || sql.includes('lock_timeout') || sql.includes('set_config'))) {
        return { rows: [], rowCount: 0 }
      }
      if (typeof sql === 'string' && sql.trim() === 'ROLLBACK') return { rows: [], rowCount: 0 }
      throw lockErr
    })

    const postHook = vi.fn()

    await expect(
      txManager.withTransaction(async (client) => {
        await runPostCommit(postHook)
        await client.query('SELECT 1')
      }, { retryOnLockTimeout: false })
    ).rejects.toBeInstanceOf(LockTimeoutError)

    expect(postHook).not.toHaveBeenCalled()
  })

  it('stale/repeated operations: identical payloads succeed idempotently on second call', async () => {
    const sideEffects: string[] = []
    let callCount = 0

    vi.mocked(mockClient.query).mockImplementation(async (sql: string) => {
      return { rows: [], rowCount: 0 }
    })

    const doOp = () =>
      txManager.withTransaction(async () => {
        callCount++
        await runPostCommit(async () => sideEffects.push(`committed:${callCount}`))
      })

    await doOp()
    await doOp()

    // Both calls committed successfully and both post-hooks fired
    expect(sideEffects).toEqual(['committed:1', 'committed:2'])

    const queries: string[] = (mockClient.query as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: any[]) => (typeof c[0] === 'string' ? c[0].trim() : ''),
    )
    const commits = queries.filter(q => q === 'COMMIT')
    expect(commits).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// 6. Cache invalidation deferred to post-commit
// ---------------------------------------------------------------------------
describe('Cache invalidation deferred via post-commit hook', () => {
  it('cache invalidation is NOT called when transaction rolls back', async () => {
    const client = makeClient()
    const pool = { connect: vi.fn().mockResolvedValue(client) }
    const txManager = new TransactionManager(pool as any)
    const cacheOps: string[] = []

    await expect(
      txManager.withTransaction(async () => {
        await runPostCommit(async () => cacheOps.push('invalidate:wallet:w1'))
        throw new Error('simulated failure')
      })
    ).rejects.toThrow()

    expect(cacheOps).toHaveLength(0)
  })

  it('cache invalidation runs exactly once after commit', async () => {
    const client = makeClient()
    const pool = { connect: vi.fn().mockResolvedValue(client) }
    const txManager = new TransactionManager(pool as any)
    const cacheOps: string[] = []

    await txManager.withTransaction(async () => {
      await runPostCommit(async () => cacheOps.push('invalidate:wallet:w1'))
    })

    expect(cacheOps).toEqual(['invalidate:wallet:w1'])
  })

  it('multiple post-commit hooks all run in registration order', async () => {
    const client = makeClient()
    const pool = { connect: vi.fn().mockResolvedValue(client) }
    const txManager = new TransactionManager(pool as any)
    const order: number[] = []

    await txManager.withTransaction(async () => {
      await runPostCommit(async () => order.push(1))
      await runPostCommit(async () => order.push(2))
      await runPostCommit(async () => order.push(3))
    })

    expect(order).toEqual([1, 2, 3])
  })

  it('a failed hook does not prevent remaining hooks from running', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const client = makeClient()
    const pool = { connect: vi.fn().mockResolvedValue(client) }
    const txManager = new TransactionManager(pool as any)
    const ran: number[] = []

    await txManager.withTransaction(async () => {
      await runPostCommit(async () => ran.push(1))
      await runPostCommit(async () => { throw new Error('hook 2 blew up') })
      await runPostCommit(async () => ran.push(3))
    })

    expect(ran).toEqual([1, 3])
    consoleSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 7. Parallel write simulation — deterministic final-state assertions
// ---------------------------------------------------------------------------
describe('Parallel write simulation — deterministic final state', () => {
  it('all concurrent TransactionManager calls see independent contexts', async () => {
    // Simulate two "concurrent" transactions. Each gets its own client mock.
    const makeSharedStatePool = () => {
      const clients: PoolClient[] = []
      return {
        connect: vi.fn().mockImplementation(async () => {
          const c = makeClient()
          clients.push(c)
          return c
        }),
        clients,
      }
    }

    const pool = makeSharedStatePool()
    const txManager = new TransactionManager(pool as any)
    const postHooks: string[] = []
    const rollbackHooks: string[] = []

    // Run two transactions concurrently — one succeeds, one fails
    const results = await Promise.allSettled([
      txManager.withTransaction(async () => {
        await runPostCommit(async () => postHooks.push('tx1:post'))
        await runRollback(async () => rollbackHooks.push('tx1:rollback'))
        return 'tx1'
      }),
      txManager.withTransaction(async () => {
        await runPostCommit(async () => postHooks.push('tx2:post'))
        await runRollback(async () => rollbackHooks.push('tx2:rollback'))
        throw new Error('tx2 failed')
      }),
    ])

    expect(results[0].status).toBe('fulfilled')
    expect(results[1].status).toBe('rejected')

    // tx1 post-hook fired, tx2 rollback hook fired — no cross-contamination
    expect(postHooks).toEqual(['tx1:post'])
    expect(rollbackHooks).toEqual(['tx2:rollback'])
  })

  it('withRetryableTransaction retries and eventual success leaves no duplicate state', async () => {
    const serErr = Object.assign(new Error('serialization'), { code: RETRYABLE_ERROR_CODES.SERIALIZATION_FAILURE })
    let callCount = 0
    const pool = makePool()

    const result = await withRetryableTransaction(
      pool,
      async () => {
        callCount++
        if (callCount < 3) throw serErr
        return 'final-value'
      },
      { maxRetries: 3, initialBackoffMs: 0, operationName: 'eventual-success' },
    )

    expect(result).toBe('final-value')
    // Attempted 3 times (2 failures + 1 success) — no permanent side-effects from failed attempts
    expect(callCount).toBe(3)
  })
})
