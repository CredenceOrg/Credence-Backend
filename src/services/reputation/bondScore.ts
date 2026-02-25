import type { BondData } from './types.js'
import { BOND_WEIGHT, MAX_BASE_SCORE } from './constants.js'

/**
 * Calculate base bond score
 * Formula: min(bondedAmount * BOND_WEIGHT, MAX_BASE_SCORE)
 * 
 * @param bond - Bond data
 * @returns Base bond score
 */
export function calculateBondScore(bond: BondData): number {
  // Negative bond amount has zero score
  if (bond.bondedAmount <= 0) {
    return 0
  }

  // Calculate score with weight and cap at max
  const score = Math.min(bond.bondedAmount * BOND_WEIGHT, MAX_BASE_SCORE)

  return score
}

/**
 * Get the bond multiplier constant
 */
export function getBondMultiplier(): number {
  return BOND_WEIGHT
}

/**
 * Get the maximum bond score constant
 */
export function getMaxBondScore(): number {
  return MAX_BASE_SCORE
}
