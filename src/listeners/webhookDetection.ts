import type { IdentityState } from './types.js'
import type { WebhookEventType } from '../services/webhooks/index.js'

export function detectEventType(
  oldState: IdentityState | null,
  newState: IdentityState
): WebhookEventType | null {
  if ((!oldState || !oldState.active) && newState.active) {
    return 'bond.created'
  }
  if (oldState?.active && !newState.active && newState.bondedAmount === '0') {
    return 'bond.withdrawn'
  }
  if (
    oldState?.active &&
    newState.active &&
    BigInt(newState.bondedAmount) < BigInt(oldState.bondedAmount)
  ) {
    return 'bond.slashed'
  }
  return null
}
