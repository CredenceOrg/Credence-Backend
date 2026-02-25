/**
 * Attestation score calculation
 */

import type { Attestation } from './types.js'

const MAX_ATTESTATION_WEIGHT = 100
const ATTESTATION_MULTIPLIER = 0.1

/**
 * Calculate attestation score from attestations
 * @param attestations - Array of attestations
 * @returns Attestation score
 */
export function calculateAttestationScore(attestations: Attestation[]): number {
  if (!attestations || attestations.length === 0) {
    return 0
  }

  // Filter valid attestations only
  const validAttestations = attestations.filter(a => a.isValid)

  if (validAttestations.length === 0) {
    return 0
  }

  // Sum all weights
  const totalWeight = validAttestations.reduce((sum, attestation) => {
    return sum + Math.max(0, attestation.weight)
  }, 0)

  // Apply multiplier and cap at max
  const score = Math.min(totalWeight * ATTESTATION_MULTIPLIER, MAX_ATTESTATION_WEIGHT)

  return score
}

/**
 * Get the maximum attestation weight constant
 */
export function getMaxAttestationWeight(): number {
  return MAX_ATTESTATION_WEIGHT
}

/**
 * Get the attestation multiplier constant
 */
export function getAttestationMultiplier(): number {
  return ATTESTATION_MULTIPLIER
}
