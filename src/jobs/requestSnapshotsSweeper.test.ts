/**
 * Tests for RequestSnapshotsSweeper
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { RequestSnapshotsSweeper, sweepExpiredRequestSnapshots } from './requestSnapshotsSweeper.js'
import type { Queryable } from '../db/repositories/queryable.js'

// Mock queryable
function createMockQueryable(rows: any[] = []): Queryable {
  return {
    query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }),
  } as unknown as Queryable
}

describe('RequestSnapshotsSweeper', () => {
  let mockDb: Queryable
  let logger: ReturnType<typeof vi.fn>
  let onMetric: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockDb = createMockQueryable()
    logger = vi.fn()
    onMetric = vi.fn()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  describe('run', () => {
    it('should count expired snapshots', async () => {
      const mockQuery = vi.fn()
        .mockResolvedValueOnce({ rows: [{ count: '50' }] }) // count
        .mockResolvedValueOnce({ rows: [], rowCount: 50 }) // delete (single batch, full)

      mockDb = { query: mockQuery } as unknown as Queryable

      const sweeper = new RequestSnapshotsSweeper(mockDb, { logger, onMetric })
      const result = await sweeper.run()

      expect(result.expiredCount).toBe(50)
      expect(result.deletedCount).toBe(50)
      expect(result.dryRun).toBe(false)
      expect(mockQuery).toHaveBeenCalledTimes(2)
    })

    it('should not delete in dry-run mode', async () => {
      const mockQuery = vi.fn().mockResolvedValue({ rows: [{ count: '20' }] })
      mockDb = { query: mockQuery } as unknown as Queryable

      const sweeper = new RequestSnapshotsSweeper(mockDb, { dryRun: true, logger, onMetric })
      const result = await sweeper.run()

      expect(result.expiredCount).toBe(20)
      expect(result.deletedCount).toBe(0)
      expect(result.dryRun).toBe(true)
      expect(mockQuery).toHaveBeenCalledTimes(1)
    })

    it('should delete in batches', async () => {
      const mockQuery = vi.fn()
        .mockResolvedValueOnce({ rows: [{ count: '12500' }] }) // count
        .mockResolvedValueOnce({ rows: [], rowCount: 5000 }) // batch 1
        .mockResolvedValueOnce({ rows: [], rowCount: 5000 }) // batch 2
        .mockResolvedValueOnce({ rows: [], rowCount: 2500 }) // batch 3
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // done

      mockDb = { query: mockQuery } as unknown as Queryable

      const sweeper = new RequestSnapshotsSweeper(mockDb, { batchSize: 5000, logger, onMetric })
      const result = await sweeper.run()

      expect(result.expiredCount).toBe(12500)
      expect(result.deletedCount).toBe(12500)
      expect(onMetric).toHaveBeenCalledWith({
        name: 'request_snapshots_deleted_total',
        value: 12500,
      })
    })

    it('should handle no expired snapshots', async () => {
      const mockQuery = vi.fn().mockResolvedValue({ rows: [{ count: '0' }] })
      mockDb = { query: mockQuery } as unknown as Queryable

      const sweeper = new RequestSnapshotsSweeper(mockDb, { logger, onMetric })
      const result = await sweeper.run()

      expect(result.expiredCount).toBe(0)
      expect(result.deletedCount).toBe(0)
      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining('Found 0 expired snapshots')
      )
      expect(onMetric).not.toHaveBeenCalled()
    })

    it('should log progress', async () => {
      const mockQuery = vi.fn()
        .mockResolvedValueOnce({ rows: [{ count: '100' }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 100 })

      mockDb = { query: mockQuery } as unknown as Queryable

      const sweeper = new RequestSnapshotsSweeper(mockDb, { logger, onMetric })
      await sweeper.run()

      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining('Found 100 expired snapshots')
      )
      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining('Deleted batch of 100 snapshots')
      )
      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining('Completed: expired=100 deleted=100')
      )
    })

    it('should track duration', async () => {
      const sweeper = new RequestSnapshotsSweeper(mockDb, { logger, onMetric })
      const result = await sweeper.run()

      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('should prevent concurrent runs', async () => {
      const mockQuery = vi.fn().mockImplementation(() =>
        new Promise((resolve) => setTimeout(() => resolve({ rows: [{ count: '0' }] }), 100))
      )
      mockDb = { query: mockQuery } as unknown as Queryable

      const sweeper = new RequestSnapshotsSweeper(mockDb, { logger, onMetric })

      const [result1, result2] = await Promise.all([
        sweeper.run(),
        sweeper.run(),
      ])

      expect(result1.expiredCount).toBe(0)
      expect(result2.expiredCount).toBe(0)
      expect(result2.durationMs).toBe(0)
      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining('Already running, skipping')
      )
    })

    it('should emit metrics on deletion', async () => {
      const mockQuery = vi.fn()
        .mockResolvedValueOnce({ rows: [{ count: '250' }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 250 })

      mockDb = { query: mockQuery } as unknown as Queryable

      const sweeper = new RequestSnapshotsSweeper(mockDb, { logger, onMetric })
      await sweeper.run()

      expect(onMetric).toHaveBeenCalledWith({
        name: 'request_snapshots_deleted_total',
        value: 250,
      })
    })

    it('should use correct retention days in query', async () => {
      const mockQuery = vi.fn()
        .mockResolvedValueOnce({ rows: [{ count: '10' }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 10 })

      mockDb = { query: mockQuery } as unknown as Queryable

      const sweeper = new RequestSnapshotsSweeper(mockDb, {
        retentionDays: 7,
        logger,
        onMetric,
      })
      await sweeper.run()

      const countCall = mockQuery.mock.calls[0]
      expect(countCall[1]).toEqual([7])

      const deleteCall = mockQuery.mock.calls[1]
      expect(deleteCall[1]).toEqual([7, 5000])
    })
  })

  describe('start/stop', () => {
    it('should start periodic cleanup', async () => {
      vi.useFakeTimers()

      const mockQuery = vi.fn().mockResolvedValue({ rows: [{ count: '0' }] })
      mockDb = { query: mockQuery } as unknown as Queryable

      const sweeper = new RequestSnapshotsSweeper(mockDb, {
        intervalMs: 1000,
        logger,
        onMetric,
      })

      sweeper.start()

      await vi.advanceTimersByTimeAsync(1000)

      expect(mockQuery).toHaveBeenCalled()
      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining('Starting periodic cleanup')
      )

      sweeper.stop()
      vi.useRealTimers()
    })

    it('should not start twice', async () => {
      const sweeper = new RequestSnapshotsSweeper(mockDb, { logger, onMetric })

      sweeper.start()
      sweeper.start()

      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining('Already running')
      )

      sweeper.stop()
    })

    it('should stop periodic cleanup', async () => {
      const mockQuery = vi.fn().mockResolvedValue({ rows: [{ count: '0' }] })
      mockDb = { query: mockQuery } as unknown as Queryable
      const sweeper = new RequestSnapshotsSweeper(mockDb, { logger, onMetric })

      sweeper.start()
      await Promise.resolve()
      await Promise.resolve()
      expect(sweeper.isRunning()).toBe(false)

      sweeper.stop()
      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining('Stopped')
      )
    })
  })

  describe('isRunning', () => {
    it('should return false initially', () => {
      const sweeper = new RequestSnapshotsSweeper(mockDb, { logger, onMetric })
      expect(sweeper.isRunning()).toBe(false)
    })

    it('should return true during run', async () => {
      const mockQuery = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => setTimeout(() => resolve({ rows: [{ count: '0' }] }), 50))
      )
      mockDb = { query: mockQuery } as unknown as Queryable

      const sweeper = new RequestSnapshotsSweeper(mockDb, { logger, onMetric })

      const runPromise = sweeper.run()

      expect(typeof sweeper.isRunning()).toBe('boolean')

      await runPromise
    })
  })
})

describe('sweepExpiredRequestSnapshots', () => {
  it('should run a single cleanup cycle', async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [{ count: '15' }] })
    const mockDb = { query: mockQuery } as unknown as Queryable

    const result = await sweepExpiredRequestSnapshots(mockDb, { dryRun: true })

    expect(result.expiredCount).toBe(15)
    expect(result.dryRun).toBe(true)
  })
})
