import type { Attestation } from './types.js'
import { ATTESTATION_BOOST_PER_ITEM, MAX_ATTESTATION_MULTIPLIER } from './constants.js'

/**
 * Calculate attestation multiplier boost
 * Formula: 1 + min(validAttestationCount * ATTESTATION_BOOST_PER_ITEM, MAX_ATTESTATION_MULTIPLIER - 1)
 * 
 * @param attestations - Array of attestations
 * @returns Attestation multiplier (>= 1.0)
 */
export function calculateAttestationScore(attestations: Attestation[]): number {
  if (!attestations || attestations.length === 0) {
    return 1.0
  }

  // Filter valid attestations only
  const validAttestations = attestations.filter(a => a.isValid)

  if (validAttestations.length === 0) {
    return 1.0
  }

  // Count valid attestations and apply boost
  const boost = validAttestations.length * ATTESTATION_BOOST_PER_ITEM
  const multiplier = Math.min(1.0 + boost, MAX_ATTESTATION_MULTIPLIER)

  return multiplier
}

/**
 * Get the attestation boost per item constant
 */
export function getAttestationBoost(): number {
  return ATTESTATION_BOOST_PER_ITEM
}

/**
 * Get the maximum attestation multiplier constant
 */
export function getMaxAttestationMultiplier(): number {
  return MAX_ATTESTATION_MULTIPLIER
}
