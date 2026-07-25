import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Pool, PoolClient } from 'pg'
import { TransactionManager, TransactionBudgetError, LockTimeoutPolicy } from './transaction.js'

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
