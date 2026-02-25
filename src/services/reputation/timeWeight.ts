/**
 * Time weight calculation for reputation scores
 * Applies exponential decay based on bond duration
 */

const MAX_DURATION_MS = 365 * 24 * 60 * 60 * 1000 // 1 year in ms
const DECAY_RATE = 0.5 // Half-life factor

/**
 * Calculate time weight based on bond duration
 * @param bondStart - Bond start timestamp in ms
 * @param currentTime - Current timestamp in ms
 * @param maxDuration - Maximum duration for full weight (default: 1 year)
 * @returns Time weight between 0 and 1
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
    return 1
  }

  // Exponential growth: weight = 1 - e^(-k * t/T)
  // where k is decay rate, t is duration, T is max duration
  const normalizedTime = duration / maxDuration
  const weight = 1 - Math.exp(-DECAY_RATE * normalizedTime * 10)

  return Math.min(Math.max(weight, 0), 1)
}

/**
 * Get the decay rate constant
 */
export function getDecayRate(): number {
  return DECAY_RATE
}

/**
 * Get the maximum duration constant
 */
export function getMaxDuration(): number {
  return MAX_DURATION_MS
}
