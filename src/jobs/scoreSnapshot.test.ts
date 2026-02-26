import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ScoreSnapshotJob, createScoreSnapshotJob } from './scoreSnapshot.js'
import type { IdentityDataSource, ScoreSnapshotStore, IdentityData, ScoreSnapshot } from './types.js'

describe('ScoreSnapshotJob', () => {
  let mockDataSource: IdentityDataSource
  let mockStore: ScoreSnapshotStore
  let mockScoreComputer: (data: IdentityData) => number
  let savedSnapshots: ScoreSnapshot[]

  beforeEach(() => {
    savedSnapshots = []

    mockDataSource = {
      getActiveAddresses: vi.fn().mockResolvedValue(['0xabc', '0xdef', '0xghi']),
      getIdentityData: vi.fn().mockImplementation(async (address: string) => ({
        address,
        bondedAmount: '1000',
        active: true,
        attestationCount: 10,
      })),
    }

    mockStore = {
      save: vi.fn().mockResolvedValue(undefined),
      saveBatch: vi.fn().mockImplementation(async (snapshots: ScoreSnapshot[]) => {
        savedSnapshots.push(...snapshots)
      }),
    }

    mockScoreComputer = vi.fn().mockReturnValue(75)
  })

  it('processes all active identities', async () => {
    const job = new ScoreSnapshotJob(mockDataSource, mockStore, mockScoreComputer)
    const result = await job.run()

    expect(result.processed).toBe(3)
    expect(result.saved).toBe(3)
    expect(result.errors).toBe(0)
    expect(mockDataSource.getActiveAddresses).toHaveBeenCalledTimes(1)
    expect(mockDataSource.getIdentityData).toHaveBeenCalledTimes(3)
  })

  it('computes scores for each identity', async () => {
    const job = new ScoreSnapshotJob(mockDataSource, mockStore, mockScoreComputer)
    await job.run()

    expect(mockScoreComputer).toHaveBeenCalledTimes(3)
    expect(mockScoreComputer).toHaveBeenCalledWith({
      address: '0xabc',
      bondedAmount: '1000',
      active: true,
      attestationCount: 10,
    })
  })

  it('saves snapshots in batch', async () => {
    const job = new ScoreSnapshotJob(mockDataSource, mockStore, mockScoreComputer)
    await job.run()

    expect(mockStore.saveBatch).toHaveBeenCalledTimes(1)
    expect(savedSnapshots).toHaveLength(3)
    expect(savedSnapshots[0]).toMatchObject({
      address: '0xabc',
      score: 75,
      bondedAmount: '1000',
      attestationCount: 10,
    })
    expect(savedSnapshots[0].timestamp).toBeDefined()
  })

  it('processes identities in batches', async () => {
    mockDataSource.getActiveAddresses = vi.fn().mockResolvedValue([
      '0xa1', '0xa2', '0xa3', '0xa4', '0xa5',
    ])

    const job = new ScoreSnapshotJob(mockDataSource, mockStore, mockScoreComputer, {
      batchSize: 2,
    })
    const result = await job.run()

    expect(result.processed).toBe(5)
    expect(mockStore.saveBatch).toHaveBeenCalledTimes(3) // 2 + 2 + 1
  })

  it('handles missing identity data', async () => {
    mockDataSource.getIdentityData = vi.fn()
      .mockResolvedValueOnce({ address: '0xabc', bondedAmount: '1000', active: true, attestationCount: 10 })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ address: '0xghi', bondedAmount: '500', active: true, attestationCount: 5 })

    const job = new ScoreSnapshotJob(mockDataSource, mockStore, mockScoreComputer)
    const result = await job.run()

    expect(result.processed).toBe(3)
    expect(result.saved).toBe(2) // Only 2 saved (middle one was null)
    expect(savedSnapshots).toHaveLength(2)
  })

  it('continues on error when continueOnError is true', async () => {
    mockDataSource.getIdentityData = vi.fn()
      .mockResolvedValueOnce({ address: '0xabc', bondedAmount: '1000', active: true, attestationCount: 10 })
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({ address: '0xghi', bondedAmount: '500', active: true, attestationCount: 5 })

    const job = new ScoreSnapshotJob(mockDataSource, mockStore, mockScoreComputer, {
      continueOnError: true,
    })
    const result = await job.run()

    expect(result.processed).toBe(2) // Only 2 processed (one threw error before processing)
    expect(result.saved).toBe(2)
    expect(result.errors).toBe(1)
  })

  it('stops on error when continueOnError is false', async () => {
    mockDataSource.getIdentityData = vi.fn()
      .mockResolvedValueOnce({ address: '0xabc', bondedAmount: '1000', active: true, attestationCount: 10 })
      .mockRejectedValueOnce(new Error('Network error'))

    const job = new ScoreSnapshotJob(mockDataSource, mockStore, mockScoreComputer, {
      continueOnError: false,
    })

    await expect(job.run()).rejects.toThrow('Network error')
  })

  it('handles batch save errors', async () => {
    mockStore.saveBatch = vi.fn().mockRejectedValue(new Error('Database error'))

    const job = new ScoreSnapshotJob(mockDataSource, mockStore, mockScoreComputer, {
      continueOnError: true,
    })
    const result = await job.run()

    expect(result.processed).toBe(3)
    expect(result.saved).toBe(0)
    expect(result.errors).toBe(3) // All 3 failed to save
  })

  it('logs progress when logger provided', async () => {
    const logs: string[] = []
    const logger = (msg: string) => logs.push(msg)

    const job = new ScoreSnapshotJob(mockDataSource, mockStore, mockScoreComputer, {
      logger,
    })
    await job.run()

    expect(logs).toContain('Starting score snapshot job')
    expect(logs.some(log => log.includes('Found 3 active identities'))).toBe(true)
    expect(logs.some(log => log.includes('Job completed'))).toBe(true)
  })

  it('returns job metrics', async () => {
    const job = new ScoreSnapshotJob(mockDataSource, mockStore, mockScoreComputer)
    const result = await job.run()

    expect(result).toMatchObject({
      processed: 3,
      saved: 3,
      errors: 0,
    })
    expect(result.duration).toBeGreaterThanOrEqual(0)
    expect(result.startTime).toBeDefined()
    expect(new Date(result.startTime).getTime()).toBeGreaterThan(0)
  })

  it('handles empty identity list', async () => {
    mockDataSource.getActiveAddresses = vi.fn().mockResolvedValue([])

    const job = new ScoreSnapshotJob(mockDataSource, mockStore, mockScoreComputer)
    const result = await job.run()

    expect(result.processed).toBe(0)
    expect(result.saved).toBe(0)
    expect(result.errors).toBe(0)
    expect(mockStore.saveBatch).not.toHaveBeenCalled()
  })

  it('creates job with factory function', () => {
    const job = createScoreSnapshotJob(mockDataSource, mockStore, mockScoreComputer)
    expect(job).toBeInstanceOf(ScoreSnapshotJob)
  })

  it('uses default options when not provided', async () => {
    const job = new ScoreSnapshotJob(mockDataSource, mockStore, mockScoreComputer)
    const result = await job.run()

    // Should use default batch size (100) and continueOnError (true)
    expect(result.processed).toBe(3)
    expect(result.saved).toBe(3)
  })

  it('processes large dataset efficiently', async () => {
    const addresses = Array.from({ length: 250 }, (_, i) => `0x${i}`)
    mockDataSource.getActiveAddresses = vi.fn().mockResolvedValue(addresses)

    const job = new ScoreSnapshotJob(mockDataSource, mockStore, mockScoreComputer, {
      batchSize: 100,
    })
    const result = await job.run()

    expect(result.processed).toBe(250)
    expect(result.saved).toBe(250)
    expect(mockStore.saveBatch).toHaveBeenCalledTimes(3) // 100 + 100 + 50
  })
})
