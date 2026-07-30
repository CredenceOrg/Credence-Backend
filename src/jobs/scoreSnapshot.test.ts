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
      getIdentityDataBatch: vi.fn().mockImplementation(async (addresses: string[]) =>
        addresses.map((address) => ({
          address,
          bondedAmount: '1000',
          active: true,
          attestationCount: 10,
        })),
      ),
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
    expect(mockDataSource.getIdentityDataBatch).toHaveBeenCalledTimes(1)
    expect(mockDataSource.getIdentityData).not.toHaveBeenCalled()
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

  it('falls back to per-identity reads when batch loading is unavailable', async () => {
    delete mockDataSource.getIdentityDataBatch

    const job = new ScoreSnapshotJob(mockDataSource, mockStore, mockScoreComputer)
    await job.run()

    expect(mockDataSource.getIdentityData).toHaveBeenCalledTimes(3)
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
    expect(mockDataSource.getIdentityDataBatch).toHaveBeenCalledTimes(3)
    expect(mockStore.saveBatch).toHaveBeenCalledTimes(3) // 2 + 2 + 1
  })

  it('handles missing identity data', async () => {
    delete mockDataSource.getIdentityDataBatch
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
    delete mockDataSource.getIdentityDataBatch
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
    delete mockDataSource.getIdentityDataBatch
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
    expect(result.aggregationDuration).toBeGreaterThanOrEqual(0)
    expect(result.startTime).toBeDefined()
    expect(new Date(result.startTime).getTime()).toBeGreaterThan(0)
  })

  it('preserves deterministic output ordering when batch results are unsorted', async () => {
    mockDataSource.getActiveAddresses = vi.fn().mockResolvedValue(['0xa', '0xb', '0xc'])
    mockDataSource.getIdentityDataBatch = vi.fn().mockResolvedValue([
      { address: '0xc', bondedAmount: '1000', active: true, attestationCount: 10 },
      { address: '0xa', bondedAmount: '1000', active: true, attestationCount: 10 },
      { address: '0xb', bondedAmount: '1000', active: true, attestationCount: 10 },
    ])

    const job = new ScoreSnapshotJob(mockDataSource, mockStore, mockScoreComputer)
    await job.run()

    expect(savedSnapshots.map((snapshot) => snapshot.address)).toEqual(['0xa', '0xb', '0xc'])
  })

  it('reduces batch read calls versus per-item loading', async () => {
    mockDataSource.getActiveAddresses = vi.fn().mockResolvedValue(['0xa1', '0xa2', '0xa3', '0xa4', '0xa5'])

    const job = new ScoreSnapshotJob(mockDataSource, mockStore, mockScoreComputer, {
      batchSize: 2,
    })
    await job.run()

    expect(mockDataSource.getIdentityDataBatch).toHaveBeenCalledTimes(3)
    expect(mockDataSource.getIdentityData).not.toHaveBeenCalled()
  })

  it('has a faster aggregation path with batch loading than legacy per-item loading', async () => {
    const addresses = ['0xa1', '0xa2', '0xa3', '0xa4']
    const batchData = addresses.map((address) => ({
      address,
      bondedAmount: '1000',
      active: true,
      attestationCount: 10,
    }))

    const sequentialSource: IdentityDataSource = {
      getActiveAddresses: vi.fn().mockResolvedValue(addresses),
      getIdentityData: vi.fn().mockImplementation(async (address: string) => {
        await new Promise((resolve) => setTimeout(resolve, 15))
        return batchData.find((row) => row.address === address) ?? null
      }),
    }

    const batchedSource: IdentityDataSource = {
      getActiveAddresses: vi.fn().mockResolvedValue(addresses),
      getIdentityData: vi.fn(),
      getIdentityDataBatch: vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 15))
        return batchData
      }),
    }

    const sequentialJob = new ScoreSnapshotJob(sequentialSource, mockStore, mockScoreComputer, {
      batchSize: 4,
    })
    const batchedJob = new ScoreSnapshotJob(batchedSource, mockStore, mockScoreComputer, {
      batchSize: 4,
    })

    const sequentialResult = await sequentialJob.run()
    const batchedResult = await batchedJob.run()

    expect(sequentialResult.aggregationDuration).toBeGreaterThan(batchedResult.aggregationDuration)
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
