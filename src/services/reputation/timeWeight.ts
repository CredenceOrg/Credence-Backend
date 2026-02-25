import { MAX_DURATION_MS, TIME_WEIGHT_MAX } from './constants.js'

/**
 * Calculate time weight based on bond duration
 * Linear growth from 0 to TIME_WEIGHT_MAX capped at MAX_DURATION_MS
 * 
 * @param bondStart - Bond start timestamp in ms
 * @param currentTime - Current timestamp in ms
 * @param maxDuration - Maximum duration for full weight (default: 1 year)
 * @returns Time weight between 0 and TIME_WEIGHT_MAX
 */
export function calculateTimeWeight(
  bondStart: number,
  currentTime: number,
  maxDuration: number = MAX_DURATION_MS
): number {
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

  if (duration >= maxDuration) {
    return TIME_WEIGHT_MAX
  }

  // Linear growth
  const weight = (duration / maxDuration) * TIME_WEIGHT_MAX

  return Math.min(Math.max(weight, 0), TIME_WEIGHT_MAX)
}

/**
 * Get the maximum duration constant
 */
export function getMaxDuration(): number {
  return MAX_DURATION_MS
}
