/**
 * Tests for trust score cache and invalidation
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../cache/redis.js', () => ({
  cache: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('../../config/index.js', () => ({
  loadConfig: () => ({
    reputation: {
      scoringModelVersion: 'test-model',
      bondScoreMax: 50,
      durationScoreMax: 20,
      attestationScoreMax: 30,
      oneEthWei: BigInt('1000000000000000000'),
      maxDurationDays: 365,
      maxAttestationCount: 5,
    },
    trustScoreCache: {
      ttl: 600,
    },
  }),
}))

import { cache } from '../../cache/redis.js'
import { getTrustScore, invalidateTrustScoreCache, type TrustIdentityRepository } from '../reputationService.js'

const makeRepo = (identity: Awaited<ReturnType<TrustIdentityRepository['getIdentityForScoring']>>): TrustIdentityRepository => ({
  getIdentityForScoring: vi.fn().mockResolvedValue(identity),
})

describe('TrustScore cache', () => {
  const address = '0xabc123'
  const cacheKey = address.toLowerCase()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should set cache on miss after reading identity', async () => {
    vi.mocked(cache.get).mockResolvedValue(null)
    const repo = makeRepo({
      address: cacheKey,
      bondedAmount: '1000000000000000000',
      bondStart: new Date(Date.now() - 86_400_000).toISOString(),
      attestationCount: 3,
    })

    const score = await getTrustScore(address, repo)

    expect(score).toBeTruthy()
    expect(cache.get).toHaveBeenCalledWith('trust', cacheKey)
    expect(repo.getIdentityForScoring).toHaveBeenCalledWith(address)
    expect(cache.set).toHaveBeenCalledWith(
      'trust',
      cacheKey,
      expect.objectContaining({ address: cacheKey }),
      600,
    )
  })

  it('should return cached trust score on hit', async () => {
    vi.mocked(cache.get).mockResolvedValue({
      address: cacheKey,
      score: 80,
      bondedAmount: '1000000000000000000',
      bondStart: null,
      attestationCount: 4,
      scoringModelVersion: 'test-model',
    })
    const repo = makeRepo(null)

    const score = await getTrustScore(address, repo)

    expect(score?.score).toBe(80)
    expect(repo.getIdentityForScoring).not.toHaveBeenCalled()
    expect(cache.set).not.toHaveBeenCalled()
  })

  it('should invalidate trust score cache', async () => {
    vi.mocked(cache.delete).mockResolvedValue(true)

    await invalidateTrustScoreCache(address)

    expect(cache.delete).toHaveBeenCalledWith('trust', cacheKey)
  })
})
