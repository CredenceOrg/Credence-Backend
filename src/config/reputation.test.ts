/**
 * Tests for reputation scoring configuration
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { validateConfig, ConfigValidationError } from './index.js'

describe('Reputation Config', () => {
  let baseEnv: Record<string, string>

  beforeEach(() => {
    baseEnv = {
      PORT: '3000',
      NODE_ENV: 'test',
      DB_URL: 'postgresql://test:test@localhost:5432/test',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'test-secret-at-least-32-characters-long',
    }
  })

  describe('default values', () => {
    it('should use default reputation config when not provided', () => {
      const config = validateConfig(baseEnv)

      expect(config.reputation.scoringModelVersion).toBe('1.0.0')
      expect(config.reputation.bondScoreMax).toBe(50)
      expect(config.reputation.durationScoreMax).toBe(20)
      expect(config.reputation.attestationScoreMax).toBe(30)
      expect(config.reputation.oneEthWei).toBe(BigInt('1000000000000000000'))
      expect(config.reputation.maxDurationDays).toBe(365)
      expect(config.reputation.maxAttestationCount).toBe(5)
    })

    it('should ensure total max score equals 100 with defaults', () => {
      const config = validateConfig(baseEnv)
      const total =
        config.reputation.bondScoreMax +
        config.reputation.durationScoreMax +
        config.reputation.attestationScoreMax

      expect(total).toBe(100)
    })
  })

  describe('custom values', () => {
    it('should accept custom reputation config', () => {
      const config = validateConfig({
        ...baseEnv,
        REPUTATION_MODEL_VERSION: '2.0.0',
        REPUTATION_BOND_SCORE_MAX: '60',
        REPUTATION_DURATION_SCORE_MAX: '25',
        REPUTATION_ATTESTATION_SCORE_MAX: '15',
        REPUTATION_ONE_ETH_WEI: '2000000000000000000',
        REPUTATION_MAX_DURATION_DAYS: '180',
        REPUTATION_MAX_ATTESTATION_COUNT: '10',
      })

      expect(config.reputation.scoringModelVersion).toBe('2.0.0')
      expect(config.reputation.bondScoreMax).toBe(60)
      expect(config.reputation.durationScoreMax).toBe(25)
      expect(config.reputation.attestationScoreMax).toBe(15)
      expect(config.reputation.oneEthWei).toBe(BigInt('2000000000000000000'))
      expect(config.reputation.maxDurationDays).toBe(180)
      expect(config.reputation.maxAttestationCount).toBe(10)
    })

    it('should allow zero values for score components', () => {
      const config = validateConfig({
        ...baseEnv,
        REPUTATION_BOND_SCORE_MAX: '0',
        REPUTATION_DURATION_SCORE_MAX: '0',
        REPUTATION_ATTESTATION_SCORE_MAX: '100',
      })

      expect(config.reputation.bondScoreMax).toBe(0)
      expect(config.reputation.durationScoreMax).toBe(0)
      expect(config.reputation.attestationScoreMax).toBe(100)
    })

    it('should allow custom model versions', () => {
      const config = validateConfig({
        ...baseEnv,
        REPUTATION_MODEL_VERSION: 'v3.1.4-beta',
      })

      expect(config.reputation.scoringModelVersion).toBe('v3.1.4-beta')
    })
  })

  describe('validation', () => {
    it('should reject negative bond score max', () => {
      expect(() =>
        validateConfig({
          ...baseEnv,
          REPUTATION_BOND_SCORE_MAX: '-10',
        })
      ).toThrow(ConfigValidationError)
    })

    it('should reject bond score max > 100', () => {
      expect(() =>
        validateConfig({
          ...baseEnv,
          REPUTATION_BOND_SCORE_MAX: '101',
        })
      ).toThrow(ConfigValidationError)
    })

    it('should reject negative duration score max', () => {
      expect(() =>
        validateConfig({
          ...baseEnv,
          REPUTATION_DURATION_SCORE_MAX: '-5',
        })
      ).toThrow(ConfigValidationError)
    })

    it('should reject duration score max > 100', () => {
      expect(() =>
        validateConfig({
          ...baseEnv,
          REPUTATION_DURATION_SCORE_MAX: '150',
        })
      ).toThrow(ConfigValidationError)
    })

    it('should reject negative attestation score max', () => {
      expect(() =>
        validateConfig({
          ...baseEnv,
          REPUTATION_ATTESTATION_SCORE_MAX: '-20',
        })
      ).toThrow(ConfigValidationError)
    })

    it('should reject attestation score max > 100', () => {
      expect(() =>
        validateConfig({
          ...baseEnv,
          REPUTATION_ATTESTATION_SCORE_MAX: '200',
        })
      ).toThrow(ConfigValidationError)
    })

    it('should reject invalid BigInt for ONE_ETH_WEI', () => {
      expect(() =>
        validateConfig({
          ...baseEnv,
          REPUTATION_ONE_ETH_WEI: 'not-a-number',
        })
      ).toThrow(ConfigValidationError)
    })

    it('should reject zero max duration days', () => {
      expect(() =>
        validateConfig({
          ...baseEnv,
          REPUTATION_MAX_DURATION_DAYS: '0',
        })
      ).toThrow(ConfigValidationError)
    })

    it('should reject negative max duration days', () => {
      expect(() =>
        validateConfig({
          ...baseEnv,
          REPUTATION_MAX_DURATION_DAYS: '-365',
        })
      ).toThrow(ConfigValidationError)
    })

    it('should reject zero max attestation count', () => {
      expect(() =>
        validateConfig({
          ...baseEnv,
          REPUTATION_MAX_ATTESTATION_COUNT: '0',
        })
      ).toThrow(ConfigValidationError)
    })

    it('should reject negative max attestation count', () => {
      expect(() =>
        validateConfig({
          ...baseEnv,
          REPUTATION_MAX_ATTESTATION_COUNT: '-5',
        })
      ).toThrow(ConfigValidationError)
    })

    it('should reject fractional max duration days', () => {
      expect(() =>
        validateConfig({
          ...baseEnv,
          REPUTATION_MAX_DURATION_DAYS: '365.5',
        })
      ).toThrow(ConfigValidationError)
    })

    it('should reject fractional max attestation count', () => {
      expect(() =>
        validateConfig({
          ...baseEnv,
          REPUTATION_MAX_ATTESTATION_COUNT: '5.5',
        })
      ).toThrow(ConfigValidationError)
    })
  })

  describe('edge cases', () => {
    it('should handle very large ONE_ETH_WEI values', () => {
      const config = validateConfig({
        ...baseEnv,
        REPUTATION_ONE_ETH_WEI: '999999999999999999999999',
      })

      expect(config.reputation.oneEthWei).toBe(BigInt('999999999999999999999999'))
    })

    it('should handle very small ONE_ETH_WEI values', () => {
      const config = validateConfig({
        ...baseEnv,
        REPUTATION_ONE_ETH_WEI: '1',
      })

      expect(config.reputation.oneEthWei).toBe(BigInt('1'))
    })

    it('should handle very large max duration days', () => {
      const config = validateConfig({
        ...baseEnv,
        REPUTATION_MAX_DURATION_DAYS: '10000',
      })

      expect(config.reputation.maxDurationDays).toBe(10000)
    })

    it('should handle very large max attestation count', () => {
      const config = validateConfig({
        ...baseEnv,
        REPUTATION_MAX_ATTESTATION_COUNT: '1000',
      })

      expect(config.reputation.maxAttestationCount).toBe(1000)
    })
  })

  describe('regression - preserve current behavior', () => {
    it('should match original hardcoded constants with defaults', () => {
      const config = validateConfig(baseEnv)

      // Original constants from reputationService.ts
      const ORIGINAL_BOND_SCORE_MAX = 50
      const ORIGINAL_DURATION_SCORE_MAX = 20
      const ORIGINAL_ATTESTATION_SCORE_MAX = 30
      const ORIGINAL_ONE_ETH_WEI = BigInt('1000000000000000000')
      const ORIGINAL_MAX_DURATION_DAYS = 365
      const ORIGINAL_MAX_ATTESTATION_COUNT = 5

      expect(config.reputation.bondScoreMax).toBe(ORIGINAL_BOND_SCORE_MAX)
      expect(config.reputation.durationScoreMax).toBe(ORIGINAL_DURATION_SCORE_MAX)
      expect(config.reputation.attestationScoreMax).toBe(ORIGINAL_ATTESTATION_SCORE_MAX)
      expect(config.reputation.oneEthWei).toBe(ORIGINAL_ONE_ETH_WEI)
      expect(config.reputation.maxDurationDays).toBe(ORIGINAL_MAX_DURATION_DAYS)
      expect(config.reputation.maxAttestationCount).toBe(ORIGINAL_MAX_ATTESTATION_COUNT)
    })
  })
})
