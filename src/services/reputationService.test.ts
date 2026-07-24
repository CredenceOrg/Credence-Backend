/**
 * Tests for config-driven reputation service
 */

import { describe, it, expect, beforeAll } from 'vitest'
import {
  computeBondScore,
  computeDurationScore,
  computeAttestationScore,
  getScoringConfig,
  type ScoringConfig,
} from './reputationService.js'

// Set up minimal environment for tests
beforeAll(() => {
  process.env.DB_URL = 'postgresql://test:test@localhost:5432/test'
  process.env.REDIS_URL = 'redis://localhost:6379'
  process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long'
})

describe('reputationService with config', () => {
  describe('getScoringConfig', () => {
    it('should return current scoring configuration', () => {
      const config = getScoringConfig()

      expect(config).toHaveProperty('bondScoreMax')
      expect(config).toHaveProperty('durationScoreMax')
      expect(config).toHaveProperty('attestationScoreMax')
      expect(config).toHaveProperty('oneEthWei')
      expect(config).toHaveProperty('maxDurationDays')
      expect(config).toHaveProperty('maxAttestationCount')
      expect(config).toHaveProperty('scoringModelVersion')
    })

    it('should return a copy of the config', () => {
      const config1 = getScoringConfig()
      const config2 = getScoringConfig()

      expect(config1).not.toBe(config2)
      expect(config1).toEqual(config2)
    })
  })

  describe('computeBondScore with default config', () => {
    it('should compute score proportional to bonded amount', () => {
      const halfEth = '500000000000000000' // 0.5 ETH
      const score = computeBondScore(halfEth)

      expect(score).toBe(25) // 50% of max (50)
    })

    it('should cap at bondScoreMax', () => {
      const twoEth = '2000000000000000000' // 2 ETH
      const score = computeBondScore(twoEth)

      expect(score).toBe(50) // Capped at max
    })

    it('should return 0 for zero amount', () => {
      expect(computeBondScore('0')).toBe(0)
    })

    it('should return 0 for invalid amount', () => {
      expect(computeBondScore('invalid')).toBe(0)
    })
  })

  describe('computeBondScore with custom config', () => {
    const customConfig: ScoringConfig = {
      bondScoreMax: 60,
      durationScoreMax: 20,
      attestationScoreMax: 20,
      oneEthWei: BigInt('2000000000000000000'), // 2 ETH
      maxDurationDays: 365,
      maxAttestationCount: 5,
      scoringModelVersion: '2.0.0',
    }

    it('should use custom bondScoreMax', () => {
      const twoEth = '2000000000000000000'
      const score = computeBondScore(twoEth, customConfig)

      expect(score).toBe(60) // Custom max
    })

    it('should use custom oneEthWei threshold', () => {
      const oneEth = '1000000000000000000' // 1 ETH
      const score = computeBondScore(oneEth, customConfig)

      expect(score).toBe(30) // 50% of 60 (since threshold is 2 ETH)
    })
  })

  describe('computeDurationScore with default config', () => {
    const now = Date.now()
    const oneDay = 86_400_000

    it('should compute score proportional to duration', () => {
      const halfYear = new Date(now - 182.5 * oneDay).toISOString()
      const score = computeDurationScore(halfYear, now)

      expect(score).toBe(10) // ~50% of max (20)
    })

    it('should cap at durationScoreMax', () => {
      const twoYears = new Date(now - 730 * oneDay).toISOString()
      const score = computeDurationScore(twoYears, now)

      expect(score).toBe(20) // Capped at max
    })

    it('should return 0 for null bondStart', () => {
      expect(computeDurationScore(null, now)).toBe(0)
    })

    it('should return 0 for future bondStart', () => {
      const future = new Date(now + oneDay).toISOString()
      expect(computeDurationScore(future, now)).toBe(0)
    })
  })

  describe('computeDurationScore with custom config', () => {
    const now = Date.now()
    const oneDay = 86_400_000

    const customConfig: ScoringConfig = {
      bondScoreMax: 50,
      durationScoreMax: 25,
      attestationScoreMax: 25,
      oneEthWei: BigInt('1000000000000000000'),
      maxDurationDays: 180, // 6 months
      maxAttestationCount: 5,
      scoringModelVersion: '2.0.0',
    }

    it('should use custom durationScoreMax', () => {
      const sixMonths = new Date(now - 180 * oneDay).toISOString()
      const score = computeDurationScore(sixMonths, now, customConfig)

      expect(score).toBe(25) // Custom max
    })

    it('should use custom maxDurationDays', () => {
      const threeMonths = new Date(now - 90 * oneDay).toISOString()
      const score = computeDurationScore(threeMonths, now, customConfig)

      expect(score).toBe(13) // ~50% of 25 (rounded)
    })
  })

  describe('computeAttestationScore with default config', () => {
    it('should compute score proportional to count', () => {
      const score = computeAttestationScore(3)

      expect(score).toBe(18) // 60% of max (30)
    })

    it('should cap at attestationScoreMax', () => {
      const score = computeAttestationScore(10)

      expect(score).toBe(30) // Capped at max
    })

    it('should return 0 for zero count', () => {
      expect(computeAttestationScore(0)).toBe(0)
    })

    it('should return 0 for negative count', () => {
      expect(computeAttestationScore(-5)).toBe(0)
    })
  })

  describe('computeAttestationScore with custom config', () => {
    const customConfig: ScoringConfig = {
      bondScoreMax: 50,
      durationScoreMax: 20,
      attestationScoreMax: 40,
      oneEthWei: BigInt('1000000000000000000'),
      maxDurationDays: 365,
      maxAttestationCount: 10, // 10 attestations for max
      scoringModelVersion: '2.0.0',
    }

    it('should use custom attestationScoreMax', () => {
      const score = computeAttestationScore(10, customConfig)

      expect(score).toBe(40) // Custom max
    })

    it('should use custom maxAttestationCount', () => {
      const score = computeAttestationScore(5, customConfig)

      expect(score).toBe(20) // 50% of 40
    })
  })

  describe('regression - default config matches original behavior', () => {
    const now = Date.now()
    const oneDay = 86_400_000

    it('should match original bond score calculation', () => {
      const oneEth = '1000000000000000000'
      const halfEth = '500000000000000000'

      expect(computeBondScore(oneEth)).toBe(50)
      expect(computeBondScore(halfEth)).toBe(25)
    })

    it('should match original duration score calculation', () => {
      const oneYear = new Date(now - 365 * oneDay).toISOString()
      const halfYear = new Date(now - 182.5 * oneDay).toISOString()

      expect(computeDurationScore(oneYear, now)).toBe(20)
      expect(computeDurationScore(halfYear, now)).toBe(10)
    })

    it('should match original attestation score calculation', () => {
      expect(computeAttestationScore(5)).toBe(30)
      expect(computeAttestationScore(3)).toBe(18)
    })
  })

  describe('edge cases', () => {
    it('should handle very large bonded amounts', () => {
      const huge = '999999999999999999999999'
      const score = computeBondScore(huge)

      expect(score).toBe(50) // Capped at max
    })

    it('should handle very long durations', () => {
      const now = Date.now()
      const tenYears = new Date(now - 3650 * 86_400_000).toISOString()
      const score = computeDurationScore(tenYears, now)

      expect(score).toBe(20) // Capped at max
    })

    it('should handle very large attestation counts', () => {
      const score = computeAttestationScore(1000)

      expect(score).toBe(30) // Capped at max
    })

    it('should handle zero-weight custom config', () => {
      const zeroConfig: ScoringConfig = {
        bondScoreMax: 0,
        durationScoreMax: 0,
        attestationScoreMax: 100,
        oneEthWei: BigInt('1000000000000000000'),
        maxDurationDays: 365,
        maxAttestationCount: 5,
        scoringModelVersion: '3.0.0',
      }

      expect(computeBondScore('1000000000000000000', zeroConfig)).toBe(0)
      expect(computeDurationScore(new Date().toISOString(), Date.now(), zeroConfig)).toBe(0)
      expect(computeAttestationScore(5, zeroConfig)).toBe(100)
    })
  })
})
