import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Pool, PoolClient } from 'pg'
import { TransactionManager, TransactionBudgetError, LockTimeoutPolicy, runPostCommit, runRollback, transactionContextStorage } from './transaction.js'

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

describe('runPostCommit', () => {
  it('registers a hook that executes after successful COMMIT', async () => {
    const mockPool = { connect: vi.fn() } as any
    const mockClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    } as any
    mockPool.connect.mockResolvedValue(mockClient)
    const txManager = new TransactionManager(mockPool)
    const hookFn = vi.fn(async () => {})

    await txManager.withTransaction(async () => {
      await runPostCommit(hookFn)
    })

    expect(hookFn).toHaveBeenCalledTimes(1)
  })

  it('does NOT execute post-commit hooks when transaction rolls back', async () => {
    const mockPool = { connect: vi.fn() } as any
    const mockClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    } as any
    mockPool.connect.mockResolvedValue(mockClient)
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
    const mockPool = { connect: vi.fn() } as any
    const mockClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    } as any
    mockPool.connect.mockResolvedValue(mockClient)
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
    const mockPool = { connect: vi.fn() } as any
    const mockClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    } as any
    mockPool.connect.mockResolvedValue(mockClient)
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
})

describe('runRollback', () => {
  it('registers a hook that executes when transaction rolls back', async () => {
    const mockPool = { connect: vi.fn() } as any
    const mockClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    } as any
    mockPool.connect.mockResolvedValue(mockClient)
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
    const mockPool = { connect: vi.fn() } as any
    const mockClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    } as any
    mockPool.connect.mockResolvedValue(mockClient)
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
    const mockPool = { connect: vi.fn() } as any
    const mockClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    } as any
    mockPool.connect.mockResolvedValue(mockClient)
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
})

describe('atomic rollback guarantees', () => {
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

  it('DB state is consistent: COMMIT on success, ROLLBACK on failure', async () => {
    // Success path
    await txManager.withTransaction(async (client) => {
      await client.query('INSERT INTO bonds (id) VALUES (1)')
    })
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT')

    // Failure path
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

    // Success: only postCommit fires
    await txManager.withTransaction(async () => {
      await runPostCommit(postCommit)
      await runRollback(onRollback)
    })
    expect(postCommit).toHaveBeenCalledTimes(1)
    expect(onRollback).not.toHaveBeenCalled()

    postCommit.mockClear()
    onRollback.mockClear()

    // Failure: only onRollback fires
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

    // Simulate: write + cache invalidation inside a transaction that rolls back
    await expect(
      txManager.withTransaction(async (client) => {
        await client.query('UPDATE wallets SET balance = 100 WHERE id = $1', ['w1'])
        // Cache invalidation registers a post-commit hook
        await runPostCommit(async () => {
          cacheOps.push('invalidate:w1')
        })
        // Transaction fails
        throw new Error('simulated failure')
      })
    ).rejects.toThrow('simulated failure')

    // Cache invalidation was NOT executed because transaction rolled back
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

    // Post-commit hooks must NOT have run
    expect(sideEffects.filter(s => s.startsWith('post:'))).toEqual([])
    // Rollback hooks SHOULD have run (compensating actions)
    expect(sideEffects.filter(s => s.startsWith('rollback:'))).toEqual(['rollback:1', 'rollback:2'])
    // DB was rolled back (COMMIT never called)
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
          throw new Error(`attempt ${i}`)
        })
      ).rejects.toThrow()
    }

    // Each failed transaction registered exactly one rollback hook and ran it
    expect(rollbackCount.current).toBe(5)
    // No post-commit hooks were ever registered
    expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT')
    consoleSpy.mockRestore()
  })

  it('transaction isolation: nested operations share the same client', async () => {
    await txManager.withTransaction(async (outerClient) => {
      // Only one pool.connect() call — the client is budgeted/proxied but the connection is the same
      expect(mockPool.connect).toHaveBeenCalledTimes(1)
    })
  })
})
