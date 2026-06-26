import type { IdentityState } from './types.js'
import type { WebhookEventType } from '../services/webhooks/index.js'

/**
 * Determine webhook event type based on identity state change.
 * Uses BigInt-safe comparisons for bonded amounts.
 */
export function detectEventType(
  oldState: IdentityState | null,
  newState: IdentityState
): WebhookEventType | null {
  // Bond created: no previous state or was inactive, now active
  if ((!oldState || !oldState.active) && newState.active) {
    return 'bond.created'
  }

  // Bond withdrawn: was active, now inactive with zero amount
  if (oldState?.active && !newState.active && newState.bondedAmount === '0') {
    return 'bond.withdrawn'
  }

  // Bond slashed: was active, amount decreased
  if (
    oldState?.active &&
    newState.active &&
    BigInt(newState.bondedAmount) < BigInt(oldState.bondedAmount)
  ) {
    return 'bond.slashed'
  }

  return null
}
