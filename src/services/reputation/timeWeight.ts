/**
 * Time weight calculation for reputation scores
 * Applies exponential decay based on bond duration
 */

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
 * Calculate time weight based on bond duration
 * @param bondStart - Bond start timestamp in ms
 * @param currentTime - Current timestamp in ms
 * @param maxDuration - Maximum duration for full weight (default: from config)
 * @param config - Optional scoring configuration (defaults to module defaults)
 * @returns Time weight between 0 and 1
 */
export function calculateTimeWeight(
  bondStart: number,
  currentTime: number,
  maxDuration?: number,
  config?: ReputationModuleConfig
): number {
  const { decayRate, maxDurationMs } = config ?? DEFAULT_CONFIG
  const effectiveMaxDuration = maxDuration ?? maxDurationMs

  if (bondStart <= 0 || currentTime <= 0) {
    return 0
  }

  if (bondStart > currentTime) {
    return 0
  }

  const duration = currentTime - bondStart

  if (duration <= 0) {
    return 0
  }

  if (duration >= effectiveMaxDuration) {
    return 1
  }

  // Exponential growth: weight = 1 - e^(-k * t/T)
  // where k is decay rate, t is duration, T is max duration
  const normalizedTime = duration / effectiveMaxDuration
  const weight = 1 - Math.exp(-decayRate * normalizedTime * 10)

  return Math.min(Math.max(weight, 0), 1)
}

/**
 * Get the decay rate constant
 */
export function getDecayRate(): number {
  return DEFAULT_CONFIG.decayRate
}

/**
 * Get the maximum duration constant
 */
export function getMaxDuration(): number {
  return DEFAULT_CONFIG.maxDurationMs
}
