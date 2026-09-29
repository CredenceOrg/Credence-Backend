/**
 * Bond score calculation
 */

import type { BondData } from './types.js'
import type { ReputationModuleConfig } from './types.js'

const DEFAULT_CONFIG: ReputationModuleConfig = {
  bondMultiplier: 0.01,
  maxBondScore: 1000,
  attestationMultiplier: 0.1,
  maxAttestationWeight: 100,
  maxDurationMs: 365 * 24 * 60 * 60 * 1000,
  decayRate: 0.5,
}

/**
 * Calculate bond score from bond data
 * @param bond - Bond data
 * @param config - Optional scoring configuration (defaults to module defaults)
 * @returns Bond score (0 if slashed)
 */
export function calculateBondScore(
  bond: BondData,
  config?: ReputationModuleConfig
): number {
  const { bondMultiplier, maxBondScore } = config ?? DEFAULT_CONFIG

  // Slashed bonds have zero score
  if (bond.isSlashed) {
    return 0
  }

  // Zero or negative bond amount has zero score
  if (bond.bondedAmount <= 0) {
    return 0
  }

  // Calculate score with multiplier and cap at max
  const score = Math.min(bond.bondedAmount * bondMultiplier, maxBondScore)

  return score
}

/**
 * Get the bond multiplier constant
 */
export function getBondMultiplier(): number {
  return DEFAULT_CONFIG.bondMultiplier
}

/**
 * Get the maximum bond score constant
 */
export function getMaxBondScore(): number {
  return DEFAULT_CONFIG.maxBondScore
}
