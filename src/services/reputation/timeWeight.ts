/**
 * Time weight calculation for reputation scores.
 * Applies exponential growth based on bond duration to reward long-term commitment.
 */

const MAX_DURATION_MS = 365 * 24 * 60 * 60 * 1000 // 1 year in ms
const DECAY_RATE = 0.5 // Half-life factor

/**
 * Calculate time weight based on bond duration.
 * Formula: 1 - e^(-k * (duration / maxDuration) * 10)
 * * @param bondStart - Bond start timestamp in ms (UTC)
 * @param currentTime - Current timestamp in ms (UTC)
 * @param maxDuration - Maximum duration for full weight (default: 1 year)
 * @returns Time weight between 0 and 1 (4 decimal precision)
 */
export function calculateTimeWeight(
  bondStart: number,
  currentTime: number,
  maxDuration: number = MAX_DURATION_MS
): number {
  if (bondStart <= 0 || currentTime <= 0 || bondStart >= currentTime) {
    return 0
  }

  const duration = currentTime - bondStart

  if (duration >= maxDuration) {
    return 1
  }

  const normalizedTime = duration / maxDuration
  const weight = 1 - Math.exp(-DECAY_RATE * normalizedTime * 10)

  // Return clamped value with 4 decimal precision
  return parseFloat(Math.min(Math.max(weight, 0), 1).toFixed(4))
}

export const getDecayRate = () => DECAY_RATE
export const getMaxDuration = () => MAX_DURATION_MS
