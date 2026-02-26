import type { IdentityData } from './types.js'

/**
 * Default score computation algorithm.
 * 
 * Score is computed based on:
 * - Bond amount (normalized)
 * - Attestation count
 * 
 * Formula: score = bondWeight * bondScore + attestationWeight * attestationScore
 * 
 * @param data - Identity data for score computation
 * @returns Computed score (0-100)
 */
export function computeScore(data: IdentityData): number {
  if (!data.active) {
    return 0
  }

  // Normalize bond amount (assuming 1000 is max for 100% bond score)
  const bondAmount = BigInt(data.bondedAmount)
  const maxBond = BigInt(1000)
  const bondScore = Math.min(Number(bondAmount * 100n / maxBond), 100)

  // Normalize attestation count (assuming 50 is max for 100% attestation score)
  const maxAttestations = 50
  const attestationScore = Math.min((data.attestationCount / maxAttestations) * 100, 100)

  // Weighted average (60% bond, 40% attestations)
  const bondWeight = 0.6
  const attestationWeight = 0.4
  const score = bondWeight * bondScore + attestationWeight * attestationScore

  return Math.round(score)
}
