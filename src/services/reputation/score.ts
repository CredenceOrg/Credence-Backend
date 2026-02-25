import type { ReputationInput, ReputationScore } from './types.js'
import { calculateBondScore } from './bondScore.js'
import { calculateAttestationScore } from './attestationScore.js'
import { calculateTimeWeight } from './timeWeight.js'
import {
  SLASHING_PENALTY_BASE,
  MIN_TRUST_SCORE,
  MAX_TRUST_SCORE
} from './constants.js'

/**
 * Calculate comprehensive trust score
 * Formula: TrustScore = (BaseScore * TimeWeight * AttestationMultiplier) - SlashingPenalty
 * 
 * @param input - Reputation input data
 * @returns Trust score breakdown
 */
export function calculateReputationScore(input: ReputationInput): ReputationScore {
  // 1. Base Score from bond amount
  const bondScore = calculateBondScore(input.bond)

  // 2. Time Weight multiplier (0.0 to 1.0)
  const timeWeight = calculateTimeWeight(
    input.bond.bondStart,
    input.currentTime
  )

  // 3. Attestation Multiplier boost (1.0+)
  const attestationMultiplier = calculateAttestationScore(input.attestations)

  // 4. Slashing Penalty
  const slashingPenalty = (input.bond.slashingHistory || 0) * SLASHING_PENALTY_BASE

  // 5. Consolidated Formula
  let totalScore = (bondScore * timeWeight * attestationMultiplier) - slashingPenalty

  // 6. Clamp the final result
  totalScore = Math.min(Math.max(totalScore, MIN_TRUST_SCORE), MAX_TRUST_SCORE)

  return {
    totalScore,
    bondScore,
    attestationScore: attestationMultiplier, // Renamed to represent multiplier in types if needed, but keeping for compatibility
    timeWeight,
  }
}

/**
 * Calculate reputation score with custom time weight parameters
 * @param input - Reputation input data
 * @param maxDuration - Maximum duration for full time weight
 * @returns Reputation score breakdown
 */
export function calculateReputationScoreWithCustomDuration(
  input: ReputationInput,
  maxDuration: number
): ReputationScore {
  const bondScore = calculateBondScore(input.bond)
  const timeWeight = calculateTimeWeight(
    input.bond.bondStart,
    input.currentTime,
    maxDuration
  )
  const attestationMultiplier = calculateAttestationScore(input.attestations)
  const slashingPenalty = (input.bond.slashingHistory || 0) * SLASHING_PENALTY_BASE

  let totalScore = (bondScore * timeWeight * attestationMultiplier) - slashingPenalty
  totalScore = Math.min(Math.max(totalScore, MIN_TRUST_SCORE), MAX_TRUST_SCORE)

  return {
    totalScore,
    bondScore,
    attestationScore: attestationMultiplier,
    timeWeight,
  }
}
