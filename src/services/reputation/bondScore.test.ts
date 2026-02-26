/**
 * Unit tests for bond score calculation
 * Tests cover: normal cases, edge cases, slashed bonds, zero bonds
 */

import { describe, it, expect } from 'vitest'
import { calculateBondScore, getBondMultiplier, getMaxBondScore } from './bondScore.js'
import type { BondData } from './types.js'

describe('bondScore', () => {
  describe('calculateBondScore', () => {
    describe('positive cases', () => {
      it('should calculate score for normal bond', () => {
        const bond: BondData = {
          bondedAmount: 1000,
          bondStart: 1000000,
          bondDuration: 100000,
          isSlashed: false,
        }
        const result = calculateBondScore(bond)
        expect(result).toBe(10) // 1000 * 0.01
      })

      it('should calculate score for large bond', () => {
        const bond: BondData = {
          bondedAmount: 50000,
          bondStart: 1000000,
          bondDuration: 100000,
          isSlashed: false,
        }
        const result = calculateBondScore(bond)
        expect(result).toBe(500) // 50000 * 0.01
      })

      it('should cap score at maximum (1000)', () => {
        const bond: BondData = {
          bondedAmount: 200000, // Would be 2000 without cap
          bondStart: 1000000,
          bondDuration: 100000,
          isSlashed: false,
        }
        const result = calculateBondScore(bond)
        expect(result).toBe(1000) // Capped at MAX_BOND_SCORE
      })

      it('should calculate score for minimum positive bond', () => {
        const bond: BondData = {
          bondedAmount: 1,
          bondStart: 1000000,
          bondDuration: 100000,
          isSlashed: false,
        }
        const result = calculateBondScore(bond)
        expect(result).toBe(0.01) // 1 * 0.01
      })

      it('should calculate score for bond at max threshold', () => {
        const bond: BondData = {
          bondedAmount: 100000, // Exactly at max
          bondStart: 1000000,
          bondDuration: 100000,
          isSlashed: false,
        }
        const result = calculateBondScore(bond)
        expect(result).toBe(1000)
      })

      it('should calculate score for fractional bond amount', () => {
        const bond: BondData = {
          bondedAmount: 123.45,
          bondStart: 1000000,
          bondDuration: 100000,
          isSlashed: false,
        }
        const result = calculateBondScore(bond)
        expect(result).toBeCloseTo(1.2345, 4)
      })
    })

    describe('slashed bonds', () => {
      it('should return 0 for slashed bond', () => {
        const bond: BondData = {
          bondedAmount: 10000,
          bondStart: 1000000,
          bondDuration: 100000,
          isSlashed: true,
        }
        const result = calculateBondScore(bond)
        expect(result).toBe(0)
      })

      it('should return 0 for slashed bond with large amount', () => {
        const bond: BondData = {
          bondedAmount: 1000000,
          bondStart: 1000000,
          bondDuration: 100000,
          isSlashed: true,
        }
        const result = calculateBondScore(bond)
        expect(result).toBe(0)
      })

      it('should return 0 for slashed bond with zero amount', () => {
        const bond: BondData = {
          bondedAmount: 0,
          bondStart: 1000000,
          bondDuration: 100000,
          isSlashed: true,
        }
        const result = calculateBondScore(bond)
        expect(result).toBe(0)
      })
    })

    describe('zero and negative bonds', () => {
      it('should return 0 for zero bond amount', () => {
        const bond: BondData = {
          bondedAmount: 0,
          bondStart: 1000000,
          bondDuration: 100000,
          isSlashed: false,
        }
        const result = calculateBondScore(bond)
        expect(result).toBe(0)
      })

      it('should return 0 for negative bond amount', () => {
        const bond: BondData = {
          bondedAmount: -1000,
          bondStart: 1000000,
          bondDuration: 100000,
          isSlashed: false,
        }
        const result = calculateBondScore(bond)
        expect(result).toBe(0)
      })

      it('should return 0 for very small negative amount', () => {
        const bond: BondData = {
          bondedAmount: -0.01,
          bondStart: 1000000,
          bondDuration: 100000,
          isSlashed: false,
        }
        const result = calculateBondScore(bond)
        expect(result).toBe(0)
      })
    })

    describe('edge cases', () => {
      it('should handle very large bond amount', () => {
        const bond: BondData = {
          bondedAmount: Number.MAX_SAFE_INTEGER,
          bondStart: 1000000,
          bondDuration: 100000,
          isSlashed: false,
        }
        const result = calculateBondScore(bond)
        expect(result).toBe(1000) // Capped at max
      })

      it('should handle zero bondStart', () => {
        const bond: BondData = {
          bondedAmount: 1000,
          bondStart: 0,
          bondDuration: 100000,
          isSlashed: false,
        }
        const result = calculateBondScore(bond)
        expect(result).toBe(10) // bondStart doesn't affect score
      })

      it('should handle zero bondDuration', () => {
        const bond: BondData = {
          bondedAmount: 1000,
          bondStart: 1000000,
          bondDuration: 0,
          isSlashed: false,
        }
        const result = calculateBondScore(bond)
        expect(result).toBe(10) // bondDuration doesn't affect score
      })

      it('should handle negative bondStart', () => {
        const bond: BondData = {
          bondedAmount: 1000,
          bondStart: -1000000,
          bondDuration: 100000,
          isSlashed: false,
        }
        const result = calculateBondScore(bond)
        expect(result).toBe(10)
      })

      it('should handle negative bondDuration', () => {
        const bond: BondData = {
          bondedAmount: 1000,
          bondStart: 1000000,
          bondDuration: -100000,
          isSlashed: false,
        }
        const result = calculateBondScore(bond)
        expect(result).toBe(10)
      })
    })

    describe('boundary conditions', () => {
      it('should handle bond amount just below max threshold', () => {
        const bond: BondData = {
          bondedAmount: 99999,
          bondStart: 1000000,
          bondDuration: 100000,
          isSlashed: false,
        }
        const result = calculateBondScore(bond)
        expect(result).toBeCloseTo(999.99, 2)
      })

      it('should handle bond amount just above max threshold', () => {
        const bond: BondData = {
          bondedAmount: 100001,
          bondStart: 1000000,
          bondDuration: 100000,
          isSlashed: false,
        }
        const result = calculateBondScore(bond)
        expect(result).toBe(1000)
      })

      it('should handle very small positive bond', () => {
        const bond: BondData = {
          bondedAmount: 0.0001,
          bondStart: 1000000,
          bondDuration: 100000,
          isSlashed: false,
        }
        const result = calculateBondScore(bond)
        expect(result).toBeCloseTo(0.000001, 6)
      })
    })
  })

  describe('getBondMultiplier', () => {
    it('should return correct multiplier', () => {
      const multiplier = getBondMultiplier()
      expect(multiplier).toBe(0.01)
    })
  })

  describe('getMaxBondScore', () => {
    it('should return correct max score', () => {
      const maxScore = getMaxBondScore()
      expect(maxScore).toBe(1000)
    })
  })
})
