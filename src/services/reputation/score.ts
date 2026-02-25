/**
 * Main reputation score calculation
 * Combines bond score, attestation score, and time weight
 */

import type { ReputationInput, ReputationScore } from './types.js'
import { calculateBondScore } from './bondScore.js'
import { calculateAttestationScore } from './attestationScore.js'
import { calculateTimeWeight } from './timeWeight.js'

/**
 * Calculate comprehensive reputation score
 * Formula: totalScore = (bondScore + attestationScore) * timeWeight
 * 
 * @param input - Reputation input data
 * @returns Reputation score breakdown
 */
export function calculateReputationScore(input: ReputationInput): ReputationScore {
  // Calculate individual components
  const bondScore = calculateBondScore(input.bond)
  const attestationScore = calculateAttestationScore(input.attestations)
  const timeWeight = calculateTimeWeight(
    input.bond.bondStart,
    input.currentTime
  )

  // Apply formula: (bond + attestation) * timeWeight
  const totalScore = (bondScore + attestationScore) * timeWeight

  return {
    totalScore,
    bondScore,
    attestationScore,
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
  const attestationScore = calculateAttestationScore(input.attestations)
  const timeWeight = calculateTimeWeight(
    input.bond.bondStart,
    input.currentTime,
    maxDuration
  )

  const totalScore = (bondScore + attestationScore) * timeWeight

  return {
    totalScore,
    bondScore,
    attestationScore,
    timeWeight,
  }
}
