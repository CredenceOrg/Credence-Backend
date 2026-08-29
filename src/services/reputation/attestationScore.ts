/**
 * Attestation score calculation
 */

import type { Attestation } from './types.js'
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
 * Calculate attestation score from attestations
 * @param attestations - Array of attestations
 * @param config - Optional scoring configuration (defaults to module defaults)
 * @returns Attestation score
 */
export function calculateAttestationScore(
  attestations: Attestation[],
  config?: ReputationModuleConfig
): number {
  const { attestationMultiplier, maxAttestationWeight } = config ?? DEFAULT_CONFIG

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
  const score = Math.min(totalWeight * attestationMultiplier, maxAttestationWeight)

  return score
}

/**
 * Get the maximum attestation weight constant
 */
export function getMaxAttestationWeight(): number {
  return DEFAULT_CONFIG.maxAttestationWeight
}

/**
 * Get the attestation multiplier constant
 */
export function getAttestationMultiplier(): number {
  return DEFAULT_CONFIG.attestationMultiplier
}
