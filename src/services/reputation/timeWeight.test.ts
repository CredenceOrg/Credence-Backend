import { describe, it, expect } from 'vitest'
import { calculateTimeWeight, getMaxDuration } from './timeWeight.js'
import { MAX_DURATION_MS, TIME_WEIGHT_MAX } from './constants.js'

describe('timeWeight', () => {
  describe('calculateTimeWeight', () => {
    const ONE_DAY = 24 * 60 * 60 * 1000
    const ONE_YEAR = 365 * ONE_DAY

    describe('positive cases', () => {
      it('should return 0 for zero duration', () => {
        expect(calculateTimeWeight(100, 100)).toBe(0)
      })

      it('should return 0 for invalid inputs', () => {
        expect(calculateTimeWeight(0, 100)).toBe(0)
        expect(calculateTimeWeight(-1, 100)).toBe(0)
        expect(calculateTimeWeight(100, 0)).toBe(0)
        expect(calculateTimeWeight(100, -1)).toBe(0)
        expect(calculateTimeWeight(100, 50)).toBe(0)
      })

      it('should return 0.5 for half max duration', () => {
        const duration = MAX_DURATION_MS / 2
        expect(calculateTimeWeight(100, 100 + duration)).toBe(0.5)
      })

      it('should return TIME_WEIGHT_MAX for max duration', () => {
        expect(calculateTimeWeight(100, 100 + MAX_DURATION_MS)).toBe(TIME_WEIGHT_MAX)
      })
    })
  })

  describe('getMaxDuration', () => {
    it('should return correct max duration', () => {
      expect(getMaxDuration()).toBe(MAX_DURATION_MS)
    })
  })
})
