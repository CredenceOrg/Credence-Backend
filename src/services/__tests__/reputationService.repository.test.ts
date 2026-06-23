/**
 * Tests for getTrustScore with a mocked TrustIdentityRepository.
 * Covers: cache hit, cache miss with identity, null identity (not found),
 * null bondStart, very large bondedAmount, and address casing normalisation.
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
      scoringModelVersion: '1.0.0',
      bondScoreMax: 50,
      durationScoreMax: 20,
      attestationScoreMax: 30,
      oneEthWei: BigInt('1000000000000000000'),
      maxDurationDays: 365,
      maxAttestationCount: 5,
    },
    trustScoreCache: { ttl: 300 },
  }),
}))

import { cache } from '../../cache/redis.js'
import {
  getTrustScore,
  type TrustIdentityRepository,
  type Identity,
} from '../reputationService.js'

const makeRepo = (identity: Identity | null): TrustIdentityRepository => ({
  getIdentityForScoring: vi.fn().mockResolvedValue(identity),
})

const noCache = () => vi.mocked(cache.get).mockResolvedValue(null)

describe('getTrustScore with repository', () => {
  beforeEach(() => vi.clearAllMocks())

  describe('cache hit', () => {
    it('returns cached value without calling the repository', async () => {
      const cached = {
        address: '0xabc',
        score: 75,
        bondedAmount: '1000000000000000000',
        bondStart: null,
        attestationCount: 3,
        scoringModelVersion: '1.0.0',
      }
      vi.mocked(cache.get).mockResolvedValue(cached)
      const repo = makeRepo(null)

      const result = await getTrustScore('0xABC', repo)

      expect(result).toEqual(cached)
      expect(repo.getIdentityForScoring).not.toHaveBeenCalled()
      expect(cache.set).not.toHaveBeenCalled()
    })
  })

  describe('cache miss — identity found', () => {
    it('computes and caches the trust score', async () => {
      noCache()
      const bondStart = new Date(Date.now() - 365 * 86_400_000).toISOString()
      const repo = makeRepo({
        address: '0xabc',
        bondedAmount: '1000000000000000000', // 1 ETH → 50 pts
        bondStart,                            // 1 year → 20 pts
        attestationCount: 5,                  // max → 30 pts
      })

      const result = await getTrustScore('0xabc', repo)

      expect(result).not.toBeNull()
      expect(result!.score).toBe(100)
      expect(result!.bondedAmount).toBe('1000000000000000000')
      expect(result!.attestationCount).toBe(5)
      expect(cache.set).toHaveBeenCalledWith('trust', '0xabc', result, 300)
    })

    it('normalises address to lowercase for cache key', async () => {
      noCache()
      const repo = makeRepo({
        address: '0xABC',
        bondedAmount: '0',
        bondStart: null,
        attestationCount: 0,
      })

      await getTrustScore('0xABC', repo)

      expect(cache.get).toHaveBeenCalledWith('trust', '0xabc')
      expect(cache.set).toHaveBeenCalledWith('trust', '0xabc', expect.anything(), 300)
    })
  })

  describe('cache miss — identity not found', () => {
    it('returns null and does not write to cache', async () => {
      noCache()
      const repo = makeRepo(null)

      const result = await getTrustScore('0xunknown', repo)

      expect(result).toBeNull()
      expect(cache.set).not.toHaveBeenCalled()
    })
  })

  describe('edge cases', () => {
    it('scores zero for null bondStart', async () => {
      noCache()
      const repo = makeRepo({
        address: '0xabc',
        bondedAmount: '1000000000000000000',
        bondStart: null,
        attestationCount: 0,
      })

      const result = await getTrustScore('0xabc', repo)

      expect(result!.score).toBe(50) // bond only, no duration or attestation
      expect(result!.bondStart).toBeNull()
    })

    it('handles very large bondedAmount without overflow', async () => {
      noCache()
      const repo = makeRepo({
        address: '0xabc',
        bondedAmount: '999999999999999999999999',
        bondStart: null,
        attestationCount: 0,
      })

      const result = await getTrustScore('0xabc', repo)

      expect(result!.score).toBe(50) // capped at bondScoreMax
    })

    it('scores zero for unbonded identity with no attestations', async () => {
      noCache()
      const repo = makeRepo({
        address: '0xzero',
        bondedAmount: '0',
        bondStart: null,
        attestationCount: 0,
      })

      const result = await getTrustScore('0xzero', repo)

      expect(result!.score).toBe(0)
    })
  })
})
