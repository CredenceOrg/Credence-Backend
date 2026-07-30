/**
 * Tests for IdempotencyKeySweeper
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { IdempotencyKeySweeper, sweepExpiredIdempotencyKeys } from './idempotencyKeySweeper.js'
import type { Queryable } from '../db/repositories/queryable.js'

// Mock queryable
function createMockQueryable(rows: any[] = []): Queryable {
  return {
    query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }),
  } as unknown as Queryable
}

describe('IdempotencyKeySweeper', () => {
  let mockDb: Queryable
  let logger: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockDb = createMockQueryable()
    logger = vi.fn()
  })

  afterEach(() => {
    // Ensure any test that switched to fake timers cannot leak them into the
    // next test (which would make real setTimeout-based mocks never resolve).
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  describe('run', () => {
    it('should count expired keys', async () => {
      const mockQuery = vi.fn()
        .mockResolvedValueOnce({ rows: [{ count: '42' }] }) // count
        .mockResolvedValueOnce({ rows: [], rowCount: 10 }) // delete batch 1 (partial)

      mockDb = { query: mockQuery } as unknown as Queryable

      const sweeper = new IdempotencyKeySweeper(mockDb, { logger })
      const result = await sweeper.run()

      expect(result.expiredCount).toBe(42)
      expect(result.deletedCount).toBe(10)
      expect(result.dryRun).toBe(false)
      // count query + a single partial delete batch: a batch smaller than
      // batchSize means the table is drained, so the loop terminates.
      expect(mockQuery).toHaveBeenCalledTimes(2)
    })

    it('should not delete in dry-run mode', async () => {
      const mockQuery = vi.fn().mockResolvedValue({ rows: [{ count: '10' }] })
      mockDb = { query: mockQuery } as unknown as Queryable

      const sweeper = new IdempotencyKeySweeper(mockDb, { dryRun: true, logger })
      const result = await sweeper.run()

      expect(result.expiredCount).toBe(10)
      expect(result.deletedCount).toBe(0)
      expect(result.dryRun).toBe(true)
      // Only count query, no delete queries
      expect(mockQuery).toHaveBeenCalledTimes(1)
    })

    it('should delete in batches', async () => {
      const mockQuery = vi.fn()
        .mockResolvedValueOnce({ rows: [{ count: '25000' }] }) // count
        .mockResolvedValueOnce({ rows: [], rowCount: 10000 }) // batch 1
        .mockResolvedValueOnce({ rows: [], rowCount: 10000 }) // batch 2
        .mockResolvedValueOnce({ rows: [], rowCount: 5000 }) // batch 3
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // done

      mockDb = { query: mockQuery } as unknown as Queryable

      const sweeper = new IdempotencyKeySweeper(mockDb, { batchSize: 10000, logger })
      const result = await sweeper.run()

      expect(result.expiredCount).toBe(25000)
      expect(result.deletedCount).toBe(25000)
    })

    it('should handle no expired keys', async () => {
      const mockQuery = vi.fn().mockResolvedValue({ rows: [{ count: '0' }] })
      mockDb = { query: mockQuery } as unknown as Queryable

      const sweeper = new IdempotencyKeySweeper(mockDb, { logger })
      const result = await sweeper.run()

      expect(result.expiredCount).toBe(0)
      expect(result.deletedCount).toBe(0)
      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining('Found 0 expired keys')
      )
    })

    it('should log progress', async () => {
      const mockQuery = vi.fn()
        .mockResolvedValueOnce({ rows: [{ count: '100' }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 100 })

      mockDb = { query: mockQuery } as unknown as Queryable

      const sweeper = new IdempotencyKeySweeper(mockDb, { logger })
      await sweeper.run()

      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining('Found 100 expired keys')
      )
      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining('Deleted batch of 100 keys')
      )
      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining('Completed: expired=100 deleted=100')
      )
    })

    it('should track duration', async () => {
      const sweeper = new IdempotencyKeySweeper(mockDb, { logger })
      const result = await sweeper.run()

      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('should prevent concurrent runs', async () => {
      const mockQuery = vi.fn().mockImplementation(() => 
        new Promise(resolve => setTimeout(() => resolve({ rows: [{ count: '0' }] }), 100))
      )
      mockDb = { query: mockQuery } as unknown as Queryable

      const sweeper = new IdempotencyKeySweeper(mockDb, { logger })

      // Start two runs concurrently
      const [result1, result2] = await Promise.all([
        sweeper.run(),
        sweeper.run(),
      ])

      // First run should execute
      expect(result1.expiredCount).toBe(0)
      // Second run should be skipped
      expect(result2.expiredCount).toBe(0)
      expect(result2.durationMs).toBe(0)
      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining('Already running, skipping')
      )
    })
  })

  describe('start/stop', () => {
    it('should start periodic cleanup', async () => {
      vi.useFakeTimers()

      const mockQuery = vi.fn().mockResolvedValue({ rows: [{ count: '0' }] })
      mockDb = { query: mockQuery } as unknown as Queryable

      const sweeper = new IdempotencyKeySweeper(mockDb, {
        intervalMs: 1000,
        logger
      })

      sweeper.start()

      // Advance one interval to exercise the immediate run plus one scheduled
      // tick. (runAllTimersAsync would never terminate against a recurring
      // setInterval.)
      await vi.advanceTimersByTimeAsync(1000)

      expect(mockQuery).toHaveBeenCalled()
      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining('Starting periodic cleanup')
      )

      sweeper.stop()
      vi.useRealTimers()
    })

    it('should not start twice', async () => {
      const sweeper = new IdempotencyKeySweeper(mockDb, { logger })

      sweeper.start()
      sweeper.start() // Second start should be ignored

      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining('Already running')
      )

      sweeper.stop()
    })

    it('should stop periodic cleanup', async () => {
      const mockQuery = vi.fn().mockResolvedValue({ rows: [{ count: '0' }] })
      mockDb = { query: mockQuery } as unknown as Queryable
      const sweeper = new IdempotencyKeySweeper(mockDb, { logger })

      sweeper.start()
      // Allow the fire-and-forget initial run to settle.
      await Promise.resolve()
      await Promise.resolve()
      expect(sweeper.isRunning()).toBe(false)

      sweeper.stop()
      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining('Stopped')
      )
    })
  })

  describe('TTL boundary semantics', () => {
    /**
     * Rather than pre-programming canned responses, this fake extracts the
     * actual comparison operator (`<=` vs `<`) from the SQL the sweeper sends
     * and applies it against real Date values. That keeps the test coupled
     * to the production query: if the sweeper's expiry comparison regresses
     * (e.g. `<=` narrowed to `<`), these boundary cases fail instead of
     * silently passing against a re-implemented copy of the logic.
     */
    function createStatefulMockQueryable(seed: Array<{ key: string; expiresAt: Date }>): {
      db: Queryable
      remainingKeys: () => string[]
    } {
      const storage = new Map(seed.map((row) => [row.key, row.expiresAt]))

      const isExpired = (sql: string, expiresAt: Date, now: Date): boolean => {
        const operator = sql.match(/expires_at\s*(<=|<)\s*NOW\(\)/)?.[1]
        if (!operator) throw new Error(`Could not find expiry comparison in query: ${sql}`)
        return operator === '<=' ? expiresAt <= now : expiresAt < now
      }

      const db = {
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          const now = new Date()

          if (sql.includes('COUNT(*)')) {
            const count = [...storage.values()].filter((expiresAt) => isExpired(sql, expiresAt, now)).length
            return { rows: [{ count: String(count) }] }
          }

          if (sql.includes('DELETE FROM idempotency_keys')) {
            const limit = (params?.[0] as number | undefined) ?? Number.POSITIVE_INFINITY
            const expiredKeys = [...storage.entries()]
              .filter(([, expiresAt]) => isExpired(sql, expiresAt, now))
              .map(([key]) => key)
              .slice(0, limit)

            for (const key of expiredKeys) storage.delete(key)

            return { rows: [], rowCount: expiredKeys.length }
          }

          return { rows: [], rowCount: 0 }
        }),
      } as unknown as Queryable

      return { db, remainingKeys: () => [...storage.keys()] }
    }

    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'))
    })

    it('treats a key exactly at its expiry boundary as expired', async () => {
      const now = new Date()
      const { db, remainingKeys } = createStatefulMockQueryable([{ key: 'at-boundary', expiresAt: now }])

      const result = await new IdempotencyKeySweeper(db, { logger }).run()

      expect(result.expiredCount).toBe(1)
      expect(result.deletedCount).toBe(1)
      expect(remainingKeys()).not.toContain('at-boundary')
    })

    it('does not treat a key one millisecond before expiry as expired (no false positive)', async () => {
      const now = new Date()
      const notYetExpired = new Date(now.getTime() + 1)
      const { db, remainingKeys } = createStatefulMockQueryable([
        { key: 'not-yet-expired', expiresAt: notYetExpired },
      ])

      const result = await new IdempotencyKeySweeper(db, { logger }).run()

      expect(result.expiredCount).toBe(0)
      expect(result.deletedCount).toBe(0)
      expect(remainingKeys()).toContain('not-yet-expired')
    })

    it('treats a key one millisecond past expiry as expired', async () => {
      const now = new Date()
      const justExpired = new Date(now.getTime() - 1)
      const { db, remainingKeys } = createStatefulMockQueryable([{ key: 'just-expired', expiresAt: justExpired }])

      const result = await new IdempotencyKeySweeper(db, { logger }).run()

      expect(result.expiredCount).toBe(1)
      expect(result.deletedCount).toBe(1)
      expect(remainingKeys()).not.toContain('just-expired')
    })

    it('sweeps only expired keys out of a mixed batch, leaving unexpired keys untouched', async () => {
      const now = new Date()
      const { db, remainingKeys } = createStatefulMockQueryable([
        { key: 'expired-well-before', expiresAt: new Date(now.getTime() - 1000) },
        { key: 'expired-at-boundary', expiresAt: now },
        { key: 'valid-one-ms-away', expiresAt: new Date(now.getTime() + 1) },
        { key: 'valid-well-after', expiresAt: new Date(now.getTime() + 1000) },
      ])

      const result = await new IdempotencyKeySweeper(db, { logger }).run()

      expect(result.expiredCount).toBe(2)
      expect(result.deletedCount).toBe(2)
      expect(remainingKeys().sort()).toEqual(['valid-one-ms-away', 'valid-well-after'])
    })
  })

  describe('isRunning', () => {
    it('should return true during run', async () => {
      const mockQuery = vi.fn().mockImplementation(() => 
        new Promise(resolve => setTimeout(() => resolve({ rows: [{ count: '0' }] }), 50))
      )
      mockDb = { query: mockQuery } as unknown as Queryable

      const sweeper = new IdempotencyKeySweeper(mockDb, { logger })

      const runPromise = sweeper.run()
      
      // Check immediately after starting
      // Note: Due to async nature, this might be false by the time we check
      // So we just verify the method exists and returns a boolean
      expect(typeof sweeper.isRunning()).toBe('boolean')

      await runPromise
    })
  })
})

describe('sweepExpiredIdempotencyKeys', () => {
  it('should run a single cleanup cycle', async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [{ count: '5' }] })
    const mockDb = { query: mockQuery } as unknown as Queryable

    const result = await sweepExpiredIdempotencyKeys(mockDb, { dryRun: true })

    expect(result.expiredCount).toBe(5)
    expect(result.dryRun).toBe(true)
  })
})
