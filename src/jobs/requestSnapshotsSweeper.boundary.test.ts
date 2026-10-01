import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { RequestSnapshotsSweeper } from './requestSnapshotsSweeper.js'
import type { Queryable } from '../db/repositories/queryable.js'

function createMockQueryable(queryMock: any): Queryable {
  return {
    query: queryMock,
  } as unknown as Queryable
}

describe('RequestSnapshotsSweeper Boundary and Recovery', () => {
  let logger: ReturnType<typeof vi.fn>
  let onMetric: ReturnType<typeof vi.fn>

  beforeEach(() => {
    logger = vi.fn()
    onMetric = vi.fn()
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  describe('Boundary Conditions', () => {
    it('handles extreme config values (0 retention, 1 batch size)', async () => {
      const mockQuery = vi.fn()
        .mockResolvedValueOnce({ rows: [{ count: '2' }] }) // count
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // batch 1
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // batch 2
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // batch 3 (empty)

      const db = createMockQueryable(mockQuery)
      const sweeper = new RequestSnapshotsSweeper(db, {
        retentionDays: 0,
        batchSize: 1,
        logger,
        onMetric
      })

      const result = await sweeper.run()

      expect(result.expiredCount).toBe(2)
      expect(result.deletedCount).toBe(2)
      
      // Verify the retention days 0 is passed
      expect(mockQuery.mock.calls[0][1]).toEqual([0])
      expect(mockQuery.mock.calls[1][1]).toEqual([0, 1]) // batch 1 params
    })

    it('handles very large counts exceeding MAX_SAFE_INTEGER bounds in text gracefully', async () => {
      // Postgres returns count as string. If it's larger than Number.MAX_SAFE_INTEGER,
      // parseInt might lose precision. But parseInt('9007199254740992') works, just lossy.
      // We will mock a large string
      const mockQuery = vi.fn()
        .mockResolvedValueOnce({ rows: [{ count: '9007199254740995' }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 5000 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })

      const db = createMockQueryable(mockQuery)
      const sweeper = new RequestSnapshotsSweeper(db, {
        logger,
        onMetric
      })

      const result = await sweeper.run()
      expect(result.expiredCount).toBe(9007199254740995) // parsed as number, will be exact up to MAX_SAFE_INTEGER, then loses precision but remains large
      expect(result.deletedCount).toBe(5000)
    })
  })

  describe('Error Recovery', () => {
    it('recovers and unlocks state if count query fails', async () => {
      const mockQuery = vi.fn()
        .mockRejectedValueOnce(new Error('DB connection failed'))
        .mockResolvedValueOnce({ rows: [{ count: '10' }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 10 })

      const db = createMockQueryable(mockQuery)
      const sweeper = new RequestSnapshotsSweeper(db, { logger, onMetric })

      // First run throws
      await expect(sweeper.run()).rejects.toThrow('DB connection failed')
      expect(sweeper.isRunning()).toBe(false) // Must unlock

      // Second run succeeds
      const result = await sweeper.run()
      expect(result.expiredCount).toBe(10)
      expect(result.deletedCount).toBe(10)
    })

    it('recovers and unlocks state if batch delete fails, and logs partial success', async () => {
      const mockQuery = vi.fn()
        .mockResolvedValueOnce({ rows: [{ count: '10000' }] }) // run 1 count
        .mockResolvedValueOnce({ rows: [], rowCount: 5000 }) // run 1 batch 1 success
        .mockRejectedValueOnce(new Error('Deadlock detected')) // run 1 batch 2 fails
        .mockResolvedValueOnce({ rows: [{ count: '5000' }] }) // run 2 count
        .mockResolvedValueOnce({ rows: [], rowCount: 5000 }) // run 2 batch 1 success

      const db = createMockQueryable(mockQuery)
      const sweeper = new RequestSnapshotsSweeper(db, { batchSize: 5000, logger, onMetric })

      // First run throws after partial success
      await expect(sweeper.run()).rejects.toThrow('Deadlock detected')
      expect(sweeper.isRunning()).toBe(false)
      
      // Wait, the metrics for the first batch of 5000 should ideally be recorded. 
      // Let's check if the current implementation records partial metrics.
      // Currently it does NOT. The issue says "Retries, partial failure, and concurrent execution cannot produce an unsafe or inconsistent result."
      // If we don't record metrics, we don't have unsafe results, just incomplete metrics.
      // But we will add a check to make sure it runs again.

      // Second run succeeds
      const result = await sweeper.run()
      expect(result.expiredCount).toBe(5000)
      expect(result.deletedCount).toBe(5000)
    })

    it('prevents concurrent executions and gracefully ignores overlaps', async () => {
      let resolveQuery: (val: any) => void
      const queryPromise = new Promise((resolve) => {
        resolveQuery = resolve
      })

      const mockQuery = vi.fn().mockImplementation(() => queryPromise)
      const db = createMockQueryable(mockQuery)
      const sweeper = new RequestSnapshotsSweeper(db, { logger, onMetric })

      const run1 = sweeper.run()
      expect(sweeper.isRunning()).toBe(true)

      const run2 = sweeper.run()
      const run2Result = await run2

      expect(run2Result.expiredCount).toBe(0)
      expect(run2Result.deletedCount).toBe(0)
      expect(logger).toHaveBeenCalledWith(expect.stringContaining('Already running, skipping'))

      // Complete run1
      resolveQuery!({ rows: [{ count: '0' }] })
      await run1
      expect(sweeper.isRunning()).toBe(false)
    })
    
    it('handles metric emission on partial failures gracefully', async () => {
      const mockQuery = vi.fn()
        .mockResolvedValueOnce({ rows: [{ count: '10000' }] }) // run 1 count
        .mockResolvedValueOnce({ rows: [], rowCount: 5000 }) // run 1 batch 1 success
        .mockRejectedValueOnce(new Error('Deadlock detected')) // run 1 batch 2 fails

      const db = createMockQueryable(mockQuery)
      const sweeper = new RequestSnapshotsSweeper(db, { batchSize: 5000, logger, onMetric })

      // First run throws after partial success
      await expect(sweeper.run()).rejects.toThrow('Deadlock detected')
      expect(sweeper.isRunning()).toBe(false)
      
      // The metrics for the first batch of 5000 should be recorded in finally block
      expect(onMetric).toHaveBeenCalledWith({
        name: 'request_snapshots_deleted_total',
        value: 5000,
      })
    })
  })
})
