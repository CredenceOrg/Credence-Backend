/**
 * Unit tests for main reputation score calculation
 * Tests cover: formula correctness, component integration, edge cases
 */

import { describe, it, expect } from 'vitest'
import {
  calculateReputationScore,
  calculateReputationScoreWithCustomDuration,
} from './score.js'
import type { ReputationInput, BondData, Attestation } from './types.js'

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
            isSlashed: false,
          },
          attestations: [
            { weight: 100, timestamp: 1000000, isValid: true },
            { weight: 200, timestamp: 1000001, isValid: true },
          ],
          currentTime: 1000000 + ONE_YEAR,
        }

        const result = calculateReputationScore(input)

        // Bond score: 10000 * 0.01 = 100
        expect(result.bondScore).toBe(100)
        // Attestation score: (100 + 200) * 0.1 = 30
        expect(result.attestationScore).toBe(30)
        // Time weight: 1 year = 1.0
        expect(result.timeWeight).toBe(1)
        // Total: (100 + 30) * 1.0 = 130
        expect(result.totalScore).toBe(130)
      })

      it('should calculate score with partial time weight', () => {
        const input: ReputationInput = {
          bond: {
            bondedAmount: 5000,
            bondStart: 1000000,
            bondDuration: ONE_DAY * 30,
            isSlashed: false,
          },
          attestations: [
            { weight: 500, timestamp: 1000000, isValid: true },
          ],
          currentTime: 1000000 + ONE_DAY * 30,
        }

        const result = calculateReputationScore(input)

        // Bond score: 5000 * 0.01 = 50
        expect(result.bondScore).toBe(50)
        // Attestation score: 500 * 0.1 = 50
        expect(result.attestationScore).toBe(50)
        // Time weight: ~30 days (should be < 1)
        expect(result.timeWeight).toBeGreaterThan(0)
        expect(result.timeWeight).toBeLessThan(1)
        // Total: (50 + 50) * timeWeight
        expect(result.totalScore).toBeGreaterThan(0)
        expect(result.totalScore).toBeLessThan(100)
      })

      it('should calculate score with only bond', () => {
        const input: ReputationInput = {
          bond: {
            bondedAmount: 8000,
            bondStart: 1000000,
            bondDuration: ONE_YEAR,
            isSlashed: false,
          },
          attestations: [],
          currentTime: 1000000 + ONE_YEAR,
        }

        const result = calculateReputationScore(input)

        expect(result.bondScore).toBe(80)
        expect(result.attestationScore).toBe(0)
        expect(result.timeWeight).toBe(1)
        expect(result.totalScore).toBe(80)
      })

      it('should calculate score with only attestations', () => {
        const input: ReputationInput = {
          bond: {
            bondedAmount: 0,
            bondStart: 1000000,
            bondDuration: ONE_YEAR,
            isSlashed: false,
          },
          attestations: [
            { weight: 400, timestamp: 1000000, isValid: true },
          ],
          currentTime: 1000000 + ONE_YEAR,
        }

        const result = calculateReputationScore(input)

        expect(result.bondScore).toBe(0)
        expect(result.attestationScore).toBe(40)
        expect(result.timeWeight).toBe(1)
        expect(result.totalScore).toBe(40)
      })

      it('should calculate maximum possible score', () => {
        const input: ReputationInput = {
          bond: {
            bondedAmount: 100000, // Max bond score: 1000
            bondStart: 1000000,
            bondDuration: ONE_YEAR,
            isSlashed: false,
          },
          attestations: [
            { weight: 1000, timestamp: 1000000, isValid: true }, // Max attestation: 100
          ],
          currentTime: 1000000 + ONE_YEAR,
        }

        const result = calculateReputationScore(input)

        expect(result.bondScore).toBe(1000)
        expect(result.attestationScore).toBe(100)
        expect(result.timeWeight).toBe(1)
        expect(result.totalScore).toBe(1100) // (1000 + 100) * 1
      })
    })

    describe('edge cases - zero bond', () => {
      it('should return 0 total score for zero bond amount', () => {
        const input: ReputationInput = {
          bond: {
            bondedAmount: 0,
            bondStart: 1000000,
            bondDuration: ONE_YEAR,
            isSlashed: false,
          },
          attestations: [],
          currentTime: 1000000 + ONE_YEAR,
        }

        const result = calculateReputationScore(input)

        expect(result.bondScore).toBe(0)
        expect(result.attestationScore).toBe(0)
        expect(result.timeWeight).toBe(1)
        expect(result.totalScore).toBe(0)
      })

      it('should handle zero bond with attestations', () => {
        const input: ReputationInput = {
          bond: {
            bondedAmount: 0,
            bondStart: 1000000,
            bondDuration: ONE_YEAR,
            isSlashed: false,
          },
          attestations: [
            { weight: 300, timestamp: 1000000, isValid: true },
          ],
          currentTime: 1000000 + ONE_YEAR,
        }

        const result = calculateReputationScore(input)

        expect(result.bondScore).toBe(0)
        expect(result.attestationScore).toBe(30)
        expect(result.totalScore).toBe(30)
      })
    })

    describe('edge cases - slashed bonds', () => {
      it('should return 0 total score for slashed bond', () => {
        const input: ReputationInput = {
          bond: {
            bondedAmount: 50000,
            bondStart: 1000000,
            bondDuration: ONE_YEAR,
            isSlashed: true,
          },
          attestations: [
            { weight: 500, timestamp: 1000000, isValid: true },
          ],
          currentTime: 1000000 + ONE_YEAR,
        }

        const result = calculateReputationScore(input)

        expect(result.bondScore).toBe(0)
        expect(result.attestationScore).toBe(50)
        expect(result.timeWeight).toBe(1)
        expect(result.totalScore).toBe(50) // Only attestations count
      })

      it('should return 0 for slashed bond with no attestations', () => {
        const input: ReputationInput = {
          bond: {
            bondedAmount: 50000,
            bondStart: 1000000,
            bondDuration: ONE_YEAR,
            isSlashed: true,
          },
          attestations: [],
          currentTime: 1000000 + ONE_YEAR,
        }

        const result = calculateReputationScore(input)

        expect(result.bondScore).toBe(0)
        expect(result.attestationScore).toBe(0)
        expect(result.totalScore).toBe(0)
      })
    })

    describe('edge cases - zero time weight', () => {
      it('should return 0 total score for zero duration', () => {
        const input: ReputationInput = {
          bond: {
            bondedAmount: 10000,
            bondStart: 1000000,
            bondDuration: 0,
            isSlashed: false,
          },
          attestations: [
            { weight: 300, timestamp: 1000000, isValid: true },
          ],
          currentTime: 1000000, // Same as bondStart
        }

        const result = calculateReputationScore(input)

        expect(result.bondScore).toBe(100)
        expect(result.attestationScore).toBe(30)
        expect(result.timeWeight).toBe(0)
        expect(result.totalScore).toBe(0) // (100 + 30) * 0
      })

      it('should return 0 for future bond start', () => {
        const input: ReputationInput = {
          bond: {
            bondedAmount: 10000,
            bondStart: 2000000,
            bondDuration: ONE_YEAR,
            isSlashed: false,
          },
          attestations: [
            { weight: 300, timestamp: 1000000, isValid: true },
          ],
          currentTime: 1000000,
        }

        const result = calculateReputationScore(input)

        expect(result.timeWeight).toBe(0)
        expect(result.totalScore).toBe(0)
      })
    })

    describe('edge cases - max duration', () => {
      it('should handle duration exceeding max', () => {
        const input: ReputationInput = {
          bond: {
            bondedAmount: 5000,
            bondStart: 1000000,
            bondDuration: ONE_YEAR * 2,
            isSlashed: false,
          },
          attestations: [
            { weight: 200, timestamp: 1000000, isValid: true },
          ],
          currentTime: 1000000 + ONE_YEAR * 2,
        }

        const result = calculateReputationScore(input)

        expect(result.bondScore).toBe(50)
        expect(result.attestationScore).toBe(20)
        expect(result.timeWeight).toBe(1)
        expect(result.totalScore).toBe(70)
      })
    })

    describe('edge cases - invalid attestations', () => {
      it('should ignore invalid attestations in calculation', () => {
        const input: ReputationInput = {
          bond: {
            bondedAmount: 5000,
            bondStart: 1000000,
            bondDuration: ONE_YEAR,
            isSlashed: false,
          },
          attestations: [
            { weight: 200, timestamp: 1000000, isValid: true },
            { weight: 500, timestamp: 1000001, isValid: false },
          ],
          currentTime: 1000000 + ONE_YEAR,
        }

        const result = calculateReputationScore(input)

        expect(result.bondScore).toBe(50)
        expect(result.attestationScore).toBe(20) // Only valid attestation
        expect(result.totalScore).toBe(70)
      })
    })

    describe('comprehensive edge cases', () => {
      it('should handle all zero inputs', () => {
        const input: ReputationInput = {
          bond: {
            bondedAmount: 0,
            bondStart: 0,
            bondDuration: 0,
            isSlashed: false,
          },
          attestations: [],
          currentTime: 0,
        }

        const result = calculateReputationScore(input)

        expect(result.bondScore).toBe(0)
        expect(result.attestationScore).toBe(0)
        expect(result.timeWeight).toBe(0)
        expect(result.totalScore).toBe(0)
      })

      it('should handle negative bond amount', () => {
        const input: ReputationInput = {
          bond: {
            bondedAmount: -5000,
            bondStart: 1000000,
            bondDuration: ONE_YEAR,
            isSlashed: false,
          },
          attestations: [
            { weight: 100, timestamp: 1000000, isValid: true },
          ],
          currentTime: 1000000 + ONE_YEAR,
        }

        const result = calculateReputationScore(input)

        expect(result.bondScore).toBe(0)
        expect(result.attestationScore).toBe(10)
        expect(result.totalScore).toBe(10)
      })

      it('should handle very large values', () => {
        const input: ReputationInput = {
          bond: {
            bondedAmount: Number.MAX_SAFE_INTEGER,
            bondStart: 1000000,
            bondDuration: ONE_YEAR,
            isSlashed: false,
          },
          attestations: [
            { weight: Number.MAX_SAFE_INTEGER, timestamp: 1000000, isValid: true },
          ],
          currentTime: 1000000 + ONE_YEAR,
        }

        const result = calculateReputationScore(input)

        expect(result.bondScore).toBe(1000) // Capped
        expect(result.attestationScore).toBe(100) // Capped
        expect(result.totalScore).toBe(1100)
      })

      it('should handle fractional values', () => {
        const input: ReputationInput = {
          bond: {
            bondedAmount: 1234.56,
            bondStart: 1000000,
            bondDuration: ONE_YEAR,
            isSlashed: false,
          },
          attestations: [
            { weight: 78.9, timestamp: 1000000, isValid: true },
          ],
          currentTime: 1000000 + ONE_YEAR,
        }

        const result = calculateReputationScore(input)

        expect(result.bondScore).toBeCloseTo(12.3456, 4)
        expect(result.attestationScore).toBeCloseTo(7.89, 2)
        expect(result.totalScore).toBeCloseTo(20.2356, 4)
      })
    })
  })

  describe('calculateReputationScoreWithCustomDuration', () => {
    it('should use custom max duration', () => {
      const customMax = ONE_DAY * 30 // 30 days
      const input: ReputationInput = {
        bond: {
          bondedAmount: 5000,
          bondStart: 1000000,
          bondDuration: customMax,
          isSlashed: false,
        },
        attestations: [
          { weight: 200, timestamp: 1000000, isValid: true },
        ],
        currentTime: 1000000 + customMax,
      }

      const result = calculateReputationScoreWithCustomDuration(input, customMax)

      expect(result.bondScore).toBe(50)
      expect(result.attestationScore).toBe(20)
      expect(result.timeWeight).toBe(1) // Full weight at custom max
      expect(result.totalScore).toBe(70)
    })

    it('should calculate partial weight with custom duration', () => {
      const customMax = ONE_DAY * 60
      const input: ReputationInput = {
        bond: {
          bondedAmount: 5000,
          bondStart: 1000000,
          bondDuration: ONE_DAY * 30,
          isSlashed: false,
        },
        attestations: [
          { weight: 200, timestamp: 1000000, isValid: true },
        ],
        currentTime: 1000000 + ONE_DAY * 30,
      }

      const result = calculateReputationScoreWithCustomDuration(input, customMax)

      expect(result.timeWeight).toBeGreaterThan(0)
      expect(result.timeWeight).toBeLessThan(1)
      expect(result.totalScore).toBeGreaterThan(0)
      expect(result.totalScore).toBeLessThan(70)
    })

    it('should handle zero custom duration', () => {
      const input: ReputationInput = {
        bond: {
          bondedAmount: 5000,
          bondStart: 1000000,
          bondDuration: ONE_DAY,
          isSlashed: false,
        },
        attestations: [
          { weight: 200, timestamp: 1000000, isValid: true },
        ],
        currentTime: 1000000 + ONE_DAY,
      }

      const result = calculateReputationScoreWithCustomDuration(input, 0)

      expect(result.timeWeight).toBe(1)
      expect(result.totalScore).toBe(70)
    })
  })
})
