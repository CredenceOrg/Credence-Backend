import { describe, it, expect } from 'vitest'
import {
  calculateReputationScore,
  calculateReputationScoreWithCustomDuration,
} from './score.js'
import type { ReputationInput } from './types.js'
import {
  BOND_WEIGHT,
  MAX_BASE_SCORE,
  ATTESTATION_BOOST_PER_ITEM,
  MAX_ATTESTATION_MULTIPLIER,
  SLASHING_PENALTY_BASE,
  MAX_DURATION_MS
} from './constants.js'

describe('score', () => {
  const ONE_DAY = 24 * 60 * 60 * 1000
  const ONE_YEAR = 365 * ONE_DAY

  describe('calculateReputationScore', () => {
    describe('positive cases - formula verification', () => {
      it('should calculate score with all components', () => {
        const input: ReputationInput = {
          bond: {
            bondedAmount: 10000,
            bondStart: 1000000,
            bondDuration: ONE_YEAR,
            slashingHistory: 0,
          },
          attestations: Array(10).fill({ weight: 1, timestamp: 1000000, isValid: true }),
          currentTime: 1000000 + ONE_YEAR,
        }

        const result = calculateReputationScore(input)

        // Base Score: min(10000 * 0.01, 100) = 100
        expect(result.bondScore).toBe(100)
        // Time Weight: 1 year = 1.0
        expect(result.timeWeight).toBe(1)
        // Attestation Multiplier: 1 + (10 * 0.05) = 1.5
        expect(result.attestationScore).toBe(1.5)
        // Total: (100 * 1 * 1.5) - 0 = 150 -> clamped to 100
        expect(result.totalScore).toBe(100)
      })

      it('should calculate score with partial values', () => {
        const input: ReputationInput = {
          bond: {
            bondedAmount: 5000,
            bondStart: 1000000,
            bondDuration: ONE_DAY * 182.5, // 0.5 year
            slashingHistory: 0,
          },
          attestations: Array(5).fill({ weight: 1, timestamp: 1000000, isValid: true }),
          currentTime: 1000000 + ONE_DAY * 182.5,
        }

        const result = calculateReputationScore(input)

        // Base: 5000 * 0.01 = 50
        expect(result.bondScore).toBe(50)
        // Time: 0.5 year = 0.5
        expect(result.timeWeight).toBe(0.5)
        // Multiplier: 1 + (5 * 0.05) = 1.25
        expect(result.attestationScore).toBe(1.25)
        // Total: (50 * 0.5 * 1.25) = 31.25
        expect(result.totalScore).toBe(31.25)
      })

      it('should apply slashing penalty', () => {
        const input: ReputationInput = {
          bond: {
            bondedAmount: 10000,
            bondStart: 1000000,
            bondDuration: ONE_YEAR,
            slashingHistory: 1, // -50
          },
          attestations: [],
          currentTime: 1000000 + ONE_YEAR,
        }

        const result = calculateReputationScore(input)

        // (100 * 1 * 1) - 50 = 50
        expect(result.totalScore).toBe(50)
      })

      it('should clamp score at minimum 0', () => {
        const input: ReputationInput = {
          bond: {
            bondedAmount: 1000,
            bondStart: 1000000,
            bondDuration: ONE_DAY, // small time weight
            slashingHistory: 2, // -100
          },
          attestations: [],
          currentTime: 1000000 + ONE_DAY,
        }

        const result = calculateReputationScore(input)

        // ((10 * 0.0027) * 1) - 100 -> negative -> clamped to 0
        expect(result.totalScore).toBe(0)
      })
    })

    describe('edge cases', () => {
      it('should handle zero bond amount', () => {
        const input: ReputationInput = {
          bond: { bondedAmount: 0, bondStart: 1000000, bondDuration: ONE_YEAR, slashingHistory: 0 },
          attestations: [],
          currentTime: 1000000 + ONE_YEAR,
        }
        expect(calculateReputationScore(input).totalScore).toBe(0)
      })

      it('should handle max duration', () => {
        const input: ReputationInput = {
          bond: { bondedAmount: 10000, bondStart: 1000000, bondDuration: ONE_YEAR * 2, slashingHistory: 0 },
          attestations: [],
          currentTime: 1000000 + ONE_YEAR * 2,
        }
        expect(calculateReputationScore(input).timeWeight).toBe(1)
      })

      it('should handle max attestations', () => {
        const input: ReputationInput = {
          bond: { bondedAmount: 10000, bondStart: 1000000, bondDuration: ONE_YEAR, slashingHistory: 0 },
          attestations: Array(30).fill({ weight: 1, timestamp: 1000000, isValid: true }),
          currentTime: 1000000 + ONE_YEAR,
        }
        // max multiplier is 2.0
        expect(calculateReputationScore(input).attestationScore).toBe(2.0)
      })
    })
  })

  describe('calculateReputationScoreWithCustomDuration', () => {
    it('should use custom max duration', () => {
      const customMax = ONE_DAY * 30
      const input: ReputationInput = {
        bond: {
          bondedAmount: 10000,
          bondStart: 1000000,
          bondDuration: ONE_DAY * 15,
          slashingHistory: 0,
        },
        attestations: [],
        currentTime: 1000000 + ONE_DAY * 15,
      }

      const result = calculateReputationScoreWithCustomDuration(input, customMax)
      expect(result.timeWeight).toBe(0.5)
    })
  })
})
