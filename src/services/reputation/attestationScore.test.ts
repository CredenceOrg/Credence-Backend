import { describe, it, expect } from 'vitest'
import {
  calculateAttestationScore,
  getAttestationBoost,
  getMaxAttestationMultiplier,
} from './attestationScore.js'
import type { Attestation } from './types.js'
import { ATTESTATION_BOOST_PER_ITEM, MAX_ATTESTATION_MULTIPLIER } from './constants.js'

describe('attestationScore', () => {
  describe('calculateAttestationScore', () => {
    describe('positive cases', () => {
      it('should return 1.0 for no attestations', () => {
        expect(calculateAttestationScore([])).toBe(1.0)
      })

      it('should return 1.05 for single valid attestation', () => {
        const attestations: Attestation[] = [{ weight: 1, timestamp: 1, isValid: true }]
        expect(calculateAttestationScore(attestations)).toBe(1.05)
      })

      it('should return 1.5 for 10 valid attestations', () => {
        const attestations: Attestation[] = Array(10).fill({ weight: 1, timestamp: 1, isValid: true })
        expect(calculateAttestationScore(attestations)).toBe(1.5)
      })

      it('should cap multiplier at MAX_ATTESTATION_MULTIPLIER', () => {
        const attestations: Attestation[] = Array(30).fill({ weight: 1, timestamp: 1, isValid: true })
        expect(calculateAttestationScore(attestations)).toBe(MAX_ATTESTATION_MULTIPLIER)
      })
    })

    it('should return 1.0 for all invalid attestations', () => {
      const attestations: Attestation[] = [
        { weight: 1, timestamp: 1, isValid: false },
        { weight: 1, timestamp: 1, isValid: false },
      ]
      expect(calculateAttestationScore(attestations)).toBe(1.0)
    })

    it('should return 1.0 for null/undefined input', () => {
      expect(calculateAttestationScore(null as any)).toBe(1.0)
      expect(calculateAttestationScore(undefined as any)).toBe(1.0)
    })
  })

  describe('getAttestationBoost', () => {
    it('should return correct boost', () => {
      expect(getAttestationBoost()).toBe(ATTESTATION_BOOST_PER_ITEM)
    })
  })

  describe('getMaxAttestationMultiplier', () => {
    it('should return correct max multiplier', () => {
      expect(getMaxAttestationMultiplier()).toBe(MAX_ATTESTATION_MULTIPLIER)
    })
  })
})
