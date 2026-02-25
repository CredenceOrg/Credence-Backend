/**
 * Unit tests for time weight calculation
 * Tests cover: normal cases, edge cases, boundary conditions
 */

import { describe, it, expect } from 'vitest'
import { calculateTimeWeight, getDecayRate, getMaxDuration } from './timeWeight.js'

describe('timeWeight', () => {
  describe('calculateTimeWeight', () => {
    const ONE_DAY = 24 * 60 * 60 * 1000
    const ONE_YEAR = 365 * ONE_DAY

    describe('positive cases', () => {
      it('should return 0 for zero duration', () => {
        const bondStart = 1000000
        const currentTime = 1000000
        const result = calculateTimeWeight(bondStart, currentTime)
        expect(result).toBe(0)
      })

      it('should return value between 0 and 1 for partial duration', () => {
        const bondStart = 1000000
        const currentTime = bondStart + ONE_DAY * 30 // 30 days
        const result = calculateTimeWeight(bondStart, currentTime)
        expect(result).toBeGreaterThan(0)
        expect(result).toBeLessThan(1)
      })

      it('should return 1 for max duration (1 year)', () => {
        const bondStart = 1000000
        const currentTime = bondStart + ONE_YEAR
        const result = calculateTimeWeight(bondStart, currentTime)
        expect(result).toBe(1)
      })

      it('should return 1 for duration exceeding max', () => {
        const bondStart = 1000000
        const currentTime = bondStart + ONE_YEAR * 2
        const result = calculateTimeWeight(bondStart, currentTime)
        expect(result).toBe(1)
      })

      it('should increase monotonically with time', () => {
        const bondStart = 1000000
        const weight1 = calculateTimeWeight(bondStart, bondStart + ONE_DAY * 10)
        const weight2 = calculateTimeWeight(bondStart, bondStart + ONE_DAY * 20)
        const weight3 = calculateTimeWeight(bondStart, bondStart + ONE_DAY * 30)
        
        expect(weight2).toBeGreaterThan(weight1)
        expect(weight3).toBeGreaterThan(weight2)
      })

      it('should calculate correct weight for 6 months', () => {
        const bondStart = 1000000
        const currentTime = bondStart + (ONE_YEAR / 2)
        const result = calculateTimeWeight(bondStart, currentTime)
        expect(result).toBeGreaterThan(0.9)
        expect(result).toBeLessThan(1)
      })

      it('should calculate correct weight for 1 day', () => {
        const bondStart = 1000000
        const currentTime = bondStart + ONE_DAY
        const result = calculateTimeWeight(bondStart, currentTime)
        expect(result).toBeGreaterThan(0)
        expect(result).toBeLessThan(0.1)
      })
    })

    describe('edge cases', () => {
      it('should return 0 for zero bondStart', () => {
        const result = calculateTimeWeight(0, 1000000)
        expect(result).toBe(0)
      })

      it('should return 0 for negative bondStart', () => {
        const result = calculateTimeWeight(-1000, 1000000)
        expect(result).toBe(0)
      })

      it('should return 0 for zero currentTime', () => {
        const result = calculateTimeWeight(1000000, 0)
        expect(result).toBe(0)
      })

      it('should return 0 for negative currentTime', () => {
        const result = calculateTimeWeight(1000000, -1000)
        expect(result).toBe(0)
      })

      it('should return 0 when bondStart is after currentTime', () => {
        const result = calculateTimeWeight(2000000, 1000000)
        expect(result).toBe(0)
      })

      it('should return 0 for both zero', () => {
        const result = calculateTimeWeight(0, 0)
        expect(result).toBe(0)
      })

      it('should handle very large timestamps', () => {
        const bondStart = Number.MAX_SAFE_INTEGER - ONE_YEAR
        const currentTime = Number.MAX_SAFE_INTEGER
        const result = calculateTimeWeight(bondStart, currentTime)
        expect(result).toBe(1)
      })

      it('should handle minimum positive duration', () => {
        const bondStart = 1000000
        const currentTime = 1000001 // 1ms difference
        const result = calculateTimeWeight(bondStart, currentTime)
        expect(result).toBeGreaterThanOrEqual(0)
        expect(result).toBeLessThan(0.001)
      })
    })

    describe('custom max duration', () => {
      it('should respect custom max duration', () => {
        const bondStart = 1000000
        const customMax = ONE_DAY * 30 // 30 days
        const currentTime = bondStart + customMax
        const result = calculateTimeWeight(bondStart, currentTime, customMax)
        expect(result).toBe(1)
      })

      it('should calculate partial weight with custom max', () => {
        const bondStart = 1000000
        const customMax = ONE_DAY * 30
        const currentTime = bondStart + ONE_DAY * 15 // Half of custom max
        const result = calculateTimeWeight(bondStart, currentTime, customMax)
        expect(result).toBeGreaterThan(0)
        expect(result).toBeLessThan(1)
      })

      it('should handle zero custom max duration', () => {
        const bondStart = 1000000
        const currentTime = bondStart + ONE_DAY
        const result = calculateTimeWeight(bondStart, currentTime, 0)
        expect(result).toBe(1)
      })
    })

    describe('boundary conditions', () => {
      it('should handle exact 1 year duration', () => {
        const bondStart = 1000000
        const currentTime = bondStart + ONE_YEAR
        const result = calculateTimeWeight(bondStart, currentTime)
        expect(result).toBe(1)
      })

      it('should handle 1 year + 1ms duration', () => {
        const bondStart = 1000000
        const currentTime = bondStart + ONE_YEAR + 1
        const result = calculateTimeWeight(bondStart, currentTime)
        expect(result).toBe(1)
      })

      it('should handle 1 year - 1ms duration', () => {
        const bondStart = 1000000
        const currentTime = bondStart + ONE_YEAR - 1
        const result = calculateTimeWeight(bondStart, currentTime)
        expect(result).toBeGreaterThan(0.99)
        expect(result).toBeLessThan(1)
      })
    })
  })

  describe('getDecayRate', () => {
    it('should return positive decay rate', () => {
      const rate = getDecayRate()
      expect(rate).toBeGreaterThan(0)
      expect(rate).toBe(0.5)
    })
  })

  describe('getMaxDuration', () => {
    it('should return positive max duration', () => {
      const duration = getMaxDuration()
      expect(duration).toBeGreaterThan(0)
      expect(duration).toBe(365 * 24 * 60 * 60 * 1000)
    })
  })
})
