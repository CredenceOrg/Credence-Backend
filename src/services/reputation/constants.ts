/**
 * Configurable weights and constants for trust score calculation
 */

// Bond amount to base score conversion
export const BOND_WEIGHT = 0.01

// Maximum base score from bond
export const MAX_BASE_SCORE = 100

// Time factor
export const TIME_WEIGHT_MAX = 1.0
export const MAX_DURATION_MS = 365 * 24 * 60 * 60 * 1000 // 1 year

// Attestation boost factor (multiplier)
// score = score * (1 + (attestations * boost))
export const ATTESTATION_BOOST_PER_ITEM = 0.05
export const MAX_ATTESTATION_MULTIPLIER = 2.0

// Slashing penalty
export const SLASHING_PENALTY_BASE = 50

// Final score clamping
export const MIN_TRUST_SCORE = 0
export const MAX_TRUST_SCORE = 100
