import { describe, it, expect } from 'vitest'
import { calculateBondScore, getBondMultiplier, getMaxBondScore } from './bondScore.js'
import type { BondData } from './types.js'
import { BOND_WEIGHT, MAX_BASE_SCORE } from './constants.js'

describe('bondScore', () => {
  describe('calculateBondScore', () => {
    describe('positive cases', () => {
      it('should calculate score for normal bond', () => {
        const bond: BondData = {
          bondedAmount: 1000,
          bondStart: 1000000,
          bondDuration: 100000,
          slashingHistory: 0,
        }
        const result = calculateBondScore(bond)
        expect(result).toBe(10) // 1000 * 0.01
      })

      it('should cap score at maximum (100)', () => {
        const bond: BondData = {
          bondedAmount: 200000,
          bondStart: 1000000,
          bondDuration: 100000,
          slashingHistory: 0,
        }
        const result = calculateBondScore(bond)
        expect(result).toBe(100) // Capped at MAX_BASE_SCORE
      })
    })

    describe('zero and negative bonds', () => {
      it('should return 0 for zero bond amount', () => {
        const bond: BondData = {
          bondedAmount: 0,
          bondStart: 1000000,
          bondDuration: 100000,
          slashingHistory: 0,
        }
        const result = calculateBondScore(bond)
        expect(result).toBe(0)
      })

      it('should return 0 for negative bond amount', () => {
        const bond: BondData = {
          bondedAmount: -1000,
          bondStart: 1000000,
          bondDuration: 100000,
          slashingHistory: 0,
        }
        const result = calculateBondScore(bond)
        expect(result).toBe(0)
      })
    })
  })

  describe('getBondMultiplier', () => {
    it('should return correct multiplier', () => {
      expect(getBondMultiplier()).toBe(BOND_WEIGHT)
    })
  })

  describe('getMaxBondScore', () => {
    it('should return correct max score', () => {
      expect(getMaxBondScore()).toBe(MAX_BASE_SCORE)
    })
  })
})
