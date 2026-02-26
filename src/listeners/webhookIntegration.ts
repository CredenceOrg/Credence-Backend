import type { IdentityState } from './types.js'
import type { WebhookService, WebhookEventType } from '../services/webhooks/index.js'

/**
 * Determine webhook event type based on state change.
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

/**
 * Emit webhook for identity state change.
 * Call this after updating state in the store.
 */
export async function emitWebhookForStateChange(
  webhookService: WebhookService,
  oldState: IdentityState | null,
  newState: IdentityState
): Promise<void> {
  const eventType = detectEventType(oldState, newState)
  
  if (eventType) {
    await webhookService.emit(eventType, {
      address: newState.address,
      bondedAmount: newState.bondedAmount,
      bondStart: newState.bondStart,
      bondDuration: newState.bondDuration,
      active: newState.active,
    })
  }
}
