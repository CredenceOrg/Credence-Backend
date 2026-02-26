/**
 * Bond score calculation
 */

import type { BondData } from './types.js'

const BOND_MULTIPLIER = 0.01
const MAX_BOND_SCORE = 1000

/**
 * Calculate bond score from bond data
 * @param bond - Bond data
 * @returns Bond score (0 if slashed)
 */
export function calculateBondScore(bond: BondData): number {
  // Slashed bonds have zero score
  if (bond.isSlashed) {
    return 0
  }

  // Zero or negative bond amount has zero score
  if (bond.bondedAmount <= 0) {
    return 0
  }

  // Calculate score with multiplier and cap at max
  const score = Math.min(bond.bondedAmount * BOND_MULTIPLIER, MAX_BOND_SCORE)

  return score
}

/**
 * Get the bond multiplier constant
 */
export function getBondMultiplier(): number {
  return BOND_MULTIPLIER
}

/**
 * Get the maximum bond score constant
 */
export function getMaxBondScore(): number {
  return MAX_BOND_SCORE
}
