import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Pool, PoolClient } from 'pg'
import {
  TransactionManager,
  TransactionBudgetError,
  LockTimeoutError,
  LockTimeoutPolicy,
  PG2_LOCK_TIMEOUT_CODE,
  runPostCommit,
  runRollback,
  transactionContextStorage,
  transactionStorage,
} from './transaction.js'

function makeClient(overrides: Record<string, unknown> = {}): PoolClient {
  return {
    query: vi.fn().mockResolved({ rows: [] }),
    release: vi.fn(),
    ...overrides,
  } as any
}

function makePool(client?: PoolClient): Pool {
  const c = client ?? makeClient()
  return {
    connect: vi.fn().mockResolved(c),
    query: vi.fn().mockResolved({ rows: [] }),
  } as any
}

describe('TransactionManager with budget', () => {
  let mockPool: Pool
  let mockClient: PoolClient
  let txManager: TransactionManager

  beforeEach(() => {
    mockClient = makeClient()
    mockPool = makePool(mockClient)
    txManager = new TransactionManager(mockPool)
  })

  it('should throw TransactionBudgetError when savepoints exceed maxSavepoints', async () => {
    await expect(
      txManager.withTransaction(async (client) => {
        for (let i = 0; i < 9; i++) {
          await client.query(`SAVEPOINT sp_${i}`)
        }
      })
    ).rejects.toThrow(TransactionBudgetError)

    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('should throw TransactionBudgetError when duration exceeds maxDurationMs', async () => {
    const originalNow = Date.now
    let callCount = 0
    vi.spyOn(Date, 'now').mockImplementation(() => {
      callCount++
      return originalNow() + (callCount > 1 ? 3000 : 0)
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

  it('exactly at maxSavepoints boundary is allowed', async () => {
    const result = await txManager.withTransaction(async (client) => {
      for (let i = 0; i < 8; i++) {
        await client.query(`SAVEPOINT sp_${i}`)
      }
      return 'boundary-ok'
    })
    expect(result).toBe('boundary-ok')
  })

  it('one past maxSavepoints boundary fails with savepoints_exceeded', async () => {
    await expect(
      txManager.withTransaction(async (client) => {
        for (let i = 0; i < 9; i++) {
          await client.query(`SAVEPOINT sp_${i}`)
        }
      })
    ).rejects.toMatchObject({ reason: 'savepoints_exceeded' })
  })

  it('tracks table names from queries for observability', async () => {
    await txManager.withTransaction(async (client) => {
      await client.query('SELECT * FROM bonds')
      await client.query('UPDATE wallets SET balance = 1')
      await client.query('INSERT INTO audit_log (id) VALUES (1)')
    })
    // No throw - just ensures the budgeted client handles these statements.
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT')
  })

  it('releases the client on success and failure', async () => {
    await txManager.withTransaction(async () => 'val')
    expect(mockClient.release).toHaveBeenCalledTimes(1)

    await expect(
      txManager.withTransaction(async () => { throw new Error('boom') })
    ).rejects.toThrow('boom')
    expect(mockClient.release).toHaveBeenCalledTimes(2)
  })

  it('releases the client even when BEGIN fails', async () => {
    const failingClient = makeClient()
    ;(failingClient.query as any).mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN') throw new Error('begin failed')
      return { rows: [] }
    })
    const pool = makePool(failingClient)
    const mgr = new TransactionManager(pool)
    await expect(mgr.withTransaction(async () => 'x')).rejects.toThrow('begin failed')
    expect(failingClient.release).toHaveBeenCalledTimes(1)
  })

  it('propagates to existing transaction without connecting a new client', async () => {
    const outerClient = makeClient()
    const outerPool = makePool(outerClient)
    const outer = new TransactionManager(outerPool)
    const innerPool = makePool()
    const inner = new TransactionManager(innerPool)

    await outer.withTransaction(async () => {
      await inner.withTransaction(async (client) => {
        await client.query('SELECT 1')
      })
    })

    expect(innerPool.connect).not.toHaveBeenCalled()
  })

})

describe('runPostCommit', () => {
  it('registers a hook that executes after successful COMMIT', async () => {
    const mockPool = makePool()
    const txManager = new TransactionManager(mockPool)
    const hookFn = vi.fn(async () => {})

    await txManager.withTransaction(async () => {
      await runPostCommit(hookFn)
    })

    expect(hookFn).toHaveBeenCalledTimes(1)
  })

  it('does NOT execute post-commit hooks when transaction rolls back', async () => {
    const mockPool = makePool()
    const txManager = new TransactionManager(mockPool)
    const hookFn = vi.fn(async () => {})

    await expect(
      txManager.withTransaction(async () => {
        await runPostCommit(hookFn)
        throw new Error('force rollback')
      })
    ).rejects.toThrow('force rollback')

    expect(hookFn).not.toHaveBeenCalled()
  })

  it('executes immediately when no transaction is active', async () => {
    const hookFn = vi.fn(async () => {})
    await runPostCommit(hookFn)
    expect(hookFn).toHaveBeenCalledTimes(1)
  })

  it('runs multiple post-commit hooks in registration order', async () => {
    const mockPool = makePool()
    const txManager = new TransactionManager(mockPool)
    const order: number[] = []

    await txManager.withTransaction(async () => {
      await runPostCommit(async () => { order.push(1) })
      await runPostCommit(async () => { order.push(2) })
      await runPostCommit(async () => { order.push(3) })
    })

    expect(order).toEqual([1, 2, 3])
  })

  it('continues executing remaining hooks if one hook throws', async () => {
    const mockPool = makePool()
    const txManager = new TransactionManager(mockPool)
    const order: number[] = []
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await txManager.withTransaction(async () => {
      await runPostCommit(async () => { order.push(1) })
      await runPostCommit(async () => { throw new Error('hook 2 failed') })
      await runPostCommit(async () => { order.push(3) })
    })

    expect(order).toEqual([1, 3])
    expect(consoleSpy).toHaveBeenCalled()
    consoleSpy.mockRestore()
  })

  it('post-commit hook failure does not affect the committed transaction result', async () => {
    const mockPool = makePool()
    const txManager = new TransactionManager(mockPool)
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await txManager.withTransaction(async () => {
      await runPostCommit(async () => { throw new Error('hook failed') })
      return 'committed'
    })

    expect(result).toBe('committed')
    consoleSpy.mockRestore()
  })
})

describe('runRollback', () => {
  it('registers a hook that executes when transaction rolls back', async () => {
    const mockPool = makePool()
    const txManager = new TransactionManager(mockPool)
    const hookFn = vi.fn(async () => {})

    await expect(
      txManager.withTransaction(async () => {
        await runRollback(hookFn)
        throw new Error('force rollback')
      })
    ).rejects.toThrow('force rollback')

    expect(hookFn).toHaveBeenCalledTimes(1)
  })

  it('does NOT execute rollback hooks when transaction commits', async () => {
    const mockPool = makePool()
    const txManager = new TransactionManager(mockPool)
    const hookFn = vi.fn(async () => {})

    await txManager.withTransaction(async () => {
      await runRollback(hookFn)
    })

    expect(hookFn).not.toHaveBeenCalled()
  })

  it('is a no-op when no transaction is active', async () => {
    const hookFn = vi.fn(async () => {})
    await runRollback(hookFn)
    expect(hookFn).not.toHaveBeenCalled()
  })

  it('runs multiple rollback hooks in registration order', async () => {
    const mockPool = makePool()
    const txManager = new TransactionManager(mockPool)
    const order: number[] = []

    await expect(
      txManager.withTransaction(async () => {
        await runRollback(async () => { order.push(1) })
        await runRollback(async () => { order.push(2) })
        await runRollback(async () => { order.push(3) })
        throw new Error('force rollback')
      })
    ).rejects.toThrow()

    expect(order).toEqual([1, 2, 3])
  })

  it('continues executing remaining rollback hooks if one throws', async () => {
    const mockPool = makePool()
    const txManager = new TransactionManager(mockPool)
    const order: number[] = []
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      txManager.withTransaction(async () => {
        await runRollback(async () => { order.push(1) })
        await runRollback(async () => { throw new Error('rollback hook failed') })
        await runRollback(async () => { order.push(3) })
        throw new Error('force rollback')
      })
    ).rejects.toThrow('force rollback')

    expect(order).toEqual([1, 3])
    consoleSpy.mockRestore()
  })
})

describe('atomic rollback guarantees', () => {
  let mockPool: Pool
  let mockClient: PoolClient
  let txManager: TransactionManager

  beforeEach(() => {
    mockClient = makeClient()
    mockPool = makePool(mockClient)
    txManager = new TransactionManager(mockPool)
  })

  it('DB state is consistent: COMMIT on success, ROLLBACK on failure', async () => {
    await txManager.withTransaction(async (client) => {
      await client.query('INSERT INTO bonds (id) VALUES (1)')
    })
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT')

    await expect(
      txManager.withTransaction(async (client) => {
        await client.query('INSERT INTO bonds (id) VALUES (2)')
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('post-commit hooks never fire on rollback; rollback hooks never fire on commit', async () => {
    const postCommit = vi.fn(async () => {})
    const onRollback = vi.fn(async () => {})

    await txManager.withTransaction(async () => {
      await runPostCommit(postCommit)
      await runRollback(onRollback)
    })
    expect(postCommit).toHaveBeenCalledTimes(1)
    expect(onRollback).not.toHaveBeenCalled()

    postCommit.mockClear()
    onRollback.mockClear()

    await expect(
      txManager.withTransaction(async () => {
        await runPostCommit(postCommit)
        await runRollback(onRollback)
        throw new Error('rollback test')
      })
    ).rejects.toThrow()
    expect(postCommit).not.toHaveBeenCalled()
    expect(onRollback).toHaveBeenCalledTimes(1)
  })

  it('cache invalidation is deferred to post-commit and skipped on rollback', async () => {
    const cacheOps: string[] = []

    await expect(
      txManager.withTransaction(async (client) => {
        await client.query('UPDATE wallets SET balance = 100 WHERE id = $1', ['w1'])
        await runPostCommit(async () => {
          cacheOps.push('invalidate:w1')
        })
        throw new Error('simulated failure')
      })
    ).rejects.toThrow('simulated failure')

    expect(cacheOps).toEqual([])
  })

  it('cache invalidation executes after commit when transaction succeeds', async () => {
    const cacheOps: string[] = []

    await txManager.withTransaction(async (client) => {
      await client.query('UPDATE wallets SET balance = 200 WHERE id = $1', ['w1'])
      await runPostCommit(async () => {
        cacheOps.push('invalidate:w1')
      })
    })

    expect(cacheOps).toEqual(['invalidate:w1'])
  })

  it('failed mutation does not run post-commit hooks or leave partial state', async () => {
    const sideEffects: string[] = []
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      txManager.withTransaction(async (client) => {
        await client.query('INSERT INTO bonds (id) VALUES (1)')
        await runPostCommit(async () => { sideEffects.push('post:1') })
        await runRollback(async () => { sideEffects.push('rollback:1') })

        await client.query('INSERT INTO bonds (id) VALUES (2)')
        await runPostCommit(async () => { sideEffects.push('post:2') })
        await runRollback(async () => { sideEffects.push('rollback:2') })

        throw new Error('mid-operation failure')
      })
    ).rejects.toThrow('mid-operation failure')

    expect(sideEffects.filter(s => s.startsWith('post:'))).toEqual([])
    expect(sideEffects.filter(s => s.startsWith('rollback:'))).toEqual(['rollback:1', 'rollback:2'])
    expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT')
    consoleSpy.mockRestore()
  })

  it('repeated failed operations leave no accumulated state', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rollbackCount = { current: 0 }

    for (let i = 0; i < 5; i++) {
      await expect(
        txManager.withTransaction(async () => {
          await runRollback(async () => { rollbackCount.current++ })
          throw new Error('fail')
        })
      ).rejects.toThrow('fail')
    }

    expect(rollbackCount.current).toBe(5)
    expect(mockClient.release).toHaveBeenCalledTimes(5)
    expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT')
    consoleSpy.mockRestore()
  })

  it('transaction context is isolated between concurrent transactions', async () => {
    const clientA = makeClient()
    const clientB = makeClient()
    const poolA = makePool(clientA)
    const poolB = makePool(clientB)
    const mgrA = new TransactionManager(poolA)
    const mgrB = new TransactionManager(poolB)

    const observed: string[] = []

    const p = mgrA.withTransaction(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      const ctx = transactionContextStorage.getStore()
      observed.push(ctx!.correlationId)
    })

    const q = mgrB.withTransaction(async () => {
      const ctx = transactionContextStorage.getStore()
      observed.push(ctx!.correlationId)
    })

    await Promise.all([p, q])

    expect(observed).toHaveLength(2)
    expect(observed[0]).not.toBe(observed[1])
  })

  it('transaction storage is cleared after commit and rollback', async () => {
    await txManager.withTransaction(async () => {
      expect(transactionStorage.getStore()).defined
    })
    expect(transactionStorage.getStore()).toBeUndefined()

    await expect(
      txManager.withTransaction(async () => { throw new Error('boom') })
    ).rejects.toThrow()
    expect(transactionStorage.getStore()).toBeUndefined()
  })
})

describe('LockTimeoutError and policy handling', () => {
  it('exposes the Postgres lock timeout error code', () => {
    expect(PG2_LOCK_TIMEOUT_CODE).toBe('55P03')
  })

  it('constructs a LockTimeoutError with policy and timeout', () => {
    const err = new LockTimeoutError(LockTimeoutPolicy.CRITICAL, 10000)
    expect(err.name).toBe('LockTimeoutError')
    expect(err.policy).toBe(LskTimeoutPolicy.CRITICAL)
    expect(err.timeoutMs).toBe(10000)
    expect(err.message).toContain('10000ms')
  })

  it('uses custom label when no policy is provided', () => {
    const err = new LockTimeoutError(undefined, 500)
    expect(err.message).toContain('custom')
  })

  it('applies the policy-to-timeout mapping in SET LOCAL lock_timeout', async () => {
    const client = makeClient()
    const pool = makePool(client)
    const mgr = new TransactionManager(pool, { readonly: 111, default: 222, critical: 333 })

    await mgr.withTransaction(async () => {}, { policy: LockTimeoutPolicy.READONLY })
    expect(client.query).toHaveBeenCalledWith("SET LOCAL lock_timeout = '111ms'")

    await mgr.withTransaction(async () => {}, { policy: LockTimeoutPolicy.DEFAULT })
    expect(client.query).toHaveBeenCalledWith("SET LOCAL lock_timeout = '222ms'")

    await mgr.withTransaction(async () => {}, { policy: LockTimeoutPolicy.CRITICAL })
    expect(client.query).toHaveBeenCalledWith("SET LOCAL lock_timeout = '333ms'")
  })

  it('timeoutMs overrides the policy mapping', async () => {
    const client = makeClient()
    const pool = makePool(client)
    const mgr = new TransactionManager(pool)
    await mgr.withTransaction(async () => {}, { policy: LockTimeoutPolicy.CRITICAL, timeoutMs: 777 })
    expect(client.query).toHaveBeenCalledWith("SET LOCAL lock_timeout = '777ms'")
  })

  it('retries on lock timeout when retryOnLockTimeout is enabled', async () => {
    const client = makeClient()
    let attempts = 0
    ;(client.query as any).mockImplementation(async (sql: string): Promise<any> => {
      if (sql === 'BEGIN') {
        attempts++
        if (attempts < 3) {
          const e: any = new Error('lock timeout')
          e.code = PG2_LOCK_TIMEOUT_CODE
          throw e
        }
      }
      return { rows: [] }
    })
    const pool = makePool(client)
    const mgr = new TransactionManager(pool)

    const result = await mgr.withTransaction(async () => 'ok', {
      retryOnLockTimeout: true,
      maxRetries: 5,
      retryDelayMs: 1,
    })

    expect(result).toBe('ok')
    expect(attempts).toBe(3)
  })

  it('does not retry when retryOnLockTimeout is disabled', async () => {
    const client = makeClient()
    let attempts = 0
    ;(client.query as any).mockImplementation(async (sql: string): Promise<any> => {
      if (sql === 'BEGIN') {
        attempts++
        const e: any = new Error('lock timeout')
        e.code = PG2_LOCK_TIMEOUT_CODE
        throw e
      }
      return { rows: [] }
    })
    const pool = makePool(client)
    const mgr = new TransactionManager(pool)

    await expect(mgr.withTransaction(async () => 'ok')).rejects.toThrow()
    expect(attempts).toBe(1)
  })

  it('stops retrying after maxRetries and surfaces the last error', async () => {
    const client = makeClient()
    let attempts = 0
    ;(client.query as any).mockImplementation(async (sql: string): Promise<any> => {
      if (sql === 'BEGIN') {
        attempts++
        const e: any = new Error('lock timeout')
        e.code = PG2_LOCK_TIMEOUT_CODE
        throw e
      }
      return { rows: [] }
    })
    const pool = makePool(client)
    const mgr = new TransactionManager(pool)

    await expect(
      mgr.withTransaction(async () => 'ok', {
        retryOnLockTimeout: true,
        maxRetries: 2,
        retryDelayMs: 1,
      })
    ).rejects.toThrow('lock timeout')

    // 1 initial + 2 retries = 3 attempts
    expect(attempts).toBe(3)
  })

  it('registers a rollback hook for each failed retry attempt', async () => {
    const client = makeClient()
    let attempts = 0
    ;(client.query as any).mockImplementation(async (sql: string): Promise<any> => {
      if (sql === 'BEGIN') {
        attempts++
        if (attempts < 2) {
          const e: any = new Error('lock timeout')
          e.code = PG2_LOCK_TIMEOUT_CODE
          throw e
        }
      }
      return { rows: [] }
    })
    const pool = makePool(client)
    const mgr = new TransactionManager(pool)
    const rollbackHooks: number[] = []

    await mgr.withTransaction(async () => {
      await runRollback(async () => { rollbackHooks.push(1) })
    }, {
      retryOnLockTimeout: true,
      maxRetries: 5,
      retryDelayMs: 1,
    })

    // One failed attempt -> one rollback hook execution.
    expect(rollbackHooks).toEqual([1])
  })
})

describe('tenant context propagation', () => {
  it('sets app.tenant_id via set_config with a bind parameter', async () => {
    const client = makeClient()
    const pool = makePool(client)
    const mgr = new TransactionManager(pool)

    const { withTenantId } = await import('../utils/tenantContext.js')
    await withTenantId('tenant-123', async () => {
      await mgr.withTransaction(async () => 'val')
    })

    expect(client.query).toHaveBeenCalledWith(
      'SELECT set_config($1, $2, true)',
      ['app.tenant_id', 'tenant-123'],
    )
  })

  it('does not set tenant id when no tenant context is active', async () => {
    const client = makeClient()
    const pool = makePool(client)
    const mgr = new TransactionManager(pool)

    await mgr.withTransaction(async () => 'val')

    const calls = (client.query as any).mock.calls.map((c: any[]) => c[0])
    expect(calls.some((s: string) => typeof s === 'string' && s.includes('set_config'))).toBe(false)
  })
})

describe('isolation level handling', () => {
  it('emits BEGIN ISOLATION LEVEL SERIALIZABLE when requested', async () => {
    const client = makeClient()
    const pool = makePool(client)
    const mgr = new TransactionManager(pool)

    await mgr.withTransaction(async () => 'val', { isolationLevel: 'SERIALIZABLE' })
    expect(client.query).toHaveBeenCalledWith('BEGIN ISOLATION LEVEL SERIALIZABLE')
  })

  it('emits plain BEGIN when no isolation level is requested', async () => {
    const client = makeClient()
    const pool = makePool(client)
    const mgr = new TransactionManager(pool)

    await mgr.withTransaction(async () => 'val')
    expect(client.query).toHaveBeenCalledWith('BEGIN')
  })
})
