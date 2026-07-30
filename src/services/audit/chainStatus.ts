import type { ChainVerificationResult } from './types.js'

/**
 * Derive the last verified chain height from a verification result.
 * When a break is detected, this is the highest intact sequence number.
 */
export function computeLastVerifiedHeight(result: ChainVerificationResult): number {
  if (result.valid) {
    return result.lastCheckedSeq ?? 0
  }

  if (result.firstViolationSeq !== undefined) {
    return Math.max(0, result.firstViolationSeq - 1)
  }

  return 0
}

/**
 * Map a verification result to durable operator-facing state.
 */
export function toChainVerificationState(result: ChainVerificationResult) {
  return {
    lastVerifiedHeight: computeLastVerifiedHeight(result),
    verifiedAt: result.checkedAt,
    status: result.valid ? ('valid' as const) : ('break_detected' as const),
    firstBreakSeq: result.valid ? null : (result.firstViolationSeq ?? null),
    violationCount: result.violationCount,
    rowsChecked: result.rowsChecked,
  }
}
