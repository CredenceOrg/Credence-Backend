/**
 * Unit tests for attestation score calculation
 * Tests cover: normal cases, edge cases, invalid attestations, weight combinations
 */

import { describe, it, expect } from 'vitest'
import {
  calculateAttestationScore,
  getMaxAttestationWeight,
  getAttestationMultiplier,
} from './attestationScore.js'
import type { Attestation } from './types.js'

describe('attestationScore', () => {
  describe('calculateAttestationScore', () => {
    describe('positive cases', () => {
      it('should calculate score for single attestation', () => {
        const attestations: Attestation[] = [
          { weight: 100, timestamp: 1000000, isValid: true },
        ]
        const result = calculateAttestationScore(attestations)
        expect(result).toBe(10) // 100 * 0.1
      })

      it('should calculate score for multiple attestations', () => {
        const attestations: Attestation[] = [
          { weight: 100, timestamp: 1000000, isValid: true },
          { weight: 200, timestamp: 1000001, isValid: true },
          { weight: 150, timestamp: 1000002, isValid: true },
        ]
        const result = calculateAttestationScore(attestations)
        expect(result).toBe(45) // (100 + 200 + 150) * 0.1
      })

      it('should cap score at maximum (100)', () => {
        const attestations: Attestation[] = [
          { weight: 5000, timestamp: 1000000, isValid: true },
        ]
        const result = calculateAttestationScore(attestations)
        expect(result).toBe(100) // Capped at MAX_ATTESTATION_WEIGHT
      })

      it('should calculate score for attestations at max threshold', () => {
        const attestations: Attestation[] = [
          { weight: 1000, timestamp: 1000000, isValid: true },
        ]
        const result = calculateAttestationScore(attestations)
        expect(result).toBe(100) // 1000 * 0.1 = 100
      })

      it('should calculate score for many small attestations', () => {
        const attestations: Attestation[] = Array.from({ length: 10 }, (_, i) => ({
          weight: 10,
          timestamp: 1000000 + i,
          isValid: true,
        }))
        const result = calculateAttestationScore(attestations)
        expect(result).toBe(10) // (10 * 10) * 0.1
      })

      it('should calculate score for fractional weights', () => {
        const attestations: Attestation[] = [
          { weight: 12.5, timestamp: 1000000, isValid: true },
          { weight: 37.5, timestamp: 1000001, isValid: true },
        ]
        const result = calculateAttestationScore(attestations)
        expect(result).toBe(5) // (12.5 + 37.5) * 0.1
      })
    })

    describe('invalid attestations', () => {
      it('should ignore invalid attestations', () => {
        const attestations: Attestation[] = [
          { weight: 100, timestamp: 1000000, isValid: true },
          { weight: 200, timestamp: 1000001, isValid: false },
        ]
        const result = calculateAttestationScore(attestations)
        expect(result).toBe(10) // Only 100 * 0.1
      })

      it('should return 0 for all invalid attestations', () => {
        const attestations: Attestation[] = [
          { weight: 100, timestamp: 1000000, isValid: false },
          { weight: 200, timestamp: 1000001, isValid: false },
        ]
        const result = calculateAttestationScore(attestations)
        expect(result).toBe(0)
      })

      it('should handle mix of valid and invalid attestations', () => {
        const attestations: Attestation[] = [
          { weight: 50, timestamp: 1000000, isValid: true },
          { weight: 100, timestamp: 1000001, isValid: false },
          { weight: 75, timestamp: 1000002, isValid: true },
          { weight: 200, timestamp: 1000003, isValid: false },
        ]
        const result = calculateAttestationScore(attestations)
        expect(result).toBe(12.5) // (50 + 75) * 0.1
      })
    })

    describe('zero and negative weights', () => {
      it('should handle zero weight attestations', () => {
        const attestations: Attestation[] = [
          { weight: 0, timestamp: 1000000, isValid: true },
        ]
        const result = calculateAttestationScore(attestations)
        expect(result).toBe(0)
      })

      it('should ignore negative weight attestations', () => {
        const attestations: Attestation[] = [
          { weight: -100, timestamp: 1000000, isValid: true },
        ]
        const result = calculateAttestationScore(attestations)
        expect(result).toBe(0)
      })

      it('should handle mix of positive and negative weights', () => {
        const attestations: Attestation[] = [
          { weight: 100, timestamp: 1000000, isValid: true },
          { weight: -50, timestamp: 1000001, isValid: true },
          { weight: 200, timestamp: 1000002, isValid: true },
        ]
        const result = calculateAttestationScore(attestations)
        expect(result).toBe(30) // (100 + 0 + 200) * 0.1
      })

      it('should handle all zero weights', () => {
        const attestations: Attestation[] = [
          { weight: 0, timestamp: 1000000, isValid: true },
          { weight: 0, timestamp: 1000001, isValid: true },
        ]
        const result = calculateAttestationScore(attestations)
        expect(result).toBe(0)
      })
    })

    describe('empty and null cases', () => {
      it('should return 0 for empty array', () => {
        const attestations: Attestation[] = []
        const result = calculateAttestationScore(attestations)
        expect(result).toBe(0)
      })

      it('should return 0 for null attestations', () => {
        const result = calculateAttestationScore(null as any)
        expect(result).toBe(0)
      })

      it('should return 0 for undefined attestations', () => {
        const result = calculateAttestationScore(undefined as any)
        expect(result).toBe(0)
      })
    })

    describe('edge cases', () => {
      it('should handle very large weight', () => {
        const attestations: Attestation[] = [
          { weight: Number.MAX_SAFE_INTEGER, timestamp: 1000000, isValid: true },
        ]
        const result = calculateAttestationScore(attestations)
        expect(result).toBe(100) // Capped at max
      })

      it('should handle very small positive weight', () => {
        const attestations: Attestation[] = [
          { weight: 0.01, timestamp: 1000000, isValid: true },
        ]
        const result = calculateAttestationScore(attestations)
        expect(result).toBeCloseTo(0.001, 4)
      })

      it('should handle single attestation at max', () => {
        const attestations: Attestation[] = [
          { weight: 1000, timestamp: 1000000, isValid: true },
        ]
        const result = calculateAttestationScore(attestations)
        expect(result).toBe(100)
      })

      it('should handle multiple attestations exceeding max', () => {
        const attestations: Attestation[] = [
          { weight: 600, timestamp: 1000000, isValid: true },
          { weight: 600, timestamp: 1000001, isValid: true },
        ]
        const result = calculateAttestationScore(attestations)
        expect(result).toBe(100) // (1200 * 0.1) capped at 100
      })

      it('should handle zero timestamp', () => {
        const attestations: Attestation[] = [
          { weight: 100, timestamp: 0, isValid: true },
        ]
        const result = calculateAttestationScore(attestations)
        expect(result).toBe(10) // timestamp doesn't affect score
      })

      it('should handle negative timestamp', () => {
        const attestations: Attestation[] = [
          { weight: 100, timestamp: -1000000, isValid: true },
        ]
        const result = calculateAttestationScore(attestations)
        expect(result).toBe(10)
      })
    })

    describe('boundary conditions', () => {
      it('should handle weight just below max threshold', () => {
        const attestations: Attestation[] = [
          { weight: 999, timestamp: 1000000, isValid: true },
        ]
        const result = calculateAttestationScore(attestations)
        expect(result).toBeCloseTo(99.9, 1)
      })

      it('should handle weight just above max threshold', () => {
        const attestations: Attestation[] = [
          { weight: 1001, timestamp: 1000000, isValid: true },
        ]
        const result = calculateAttestationScore(attestations)
        expect(result).toBe(100)
      })

      it('should handle minimum positive weight', () => {
        const attestations: Attestation[] = [
          { weight: 0.0001, timestamp: 1000000, isValid: true },
        ]
        const result = calculateAttestationScore(attestations)
        expect(result).toBeCloseTo(0.00001, 6)
      })

      it('should handle large number of attestations', () => {
        const attestations: Attestation[] = Array.from({ length: 1000 }, (_, i) => ({
          weight: 1,
          timestamp: 1000000 + i,
          isValid: true,
        }))
        const result = calculateAttestationScore(attestations)
        expect(result).toBe(100) // (1000 * 1) * 0.1 = 100
      })
    })
  })

  describe('getMaxAttestationWeight', () => {
    it('should return correct max weight', () => {
      const maxWeight = getMaxAttestationWeight()
      expect(maxWeight).toBe(100)
    })
  })

  describe('getAttestationMultiplier', () => {
    it('should return correct multiplier', () => {
      const multiplier = getAttestationMultiplier()
      expect(multiplier).toBe(0.1)
    })
  })
})
