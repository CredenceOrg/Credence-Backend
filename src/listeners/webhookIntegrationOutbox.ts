import type { Queryable } from '../db/repositories/queryable.js'
import type { IdentityState } from './types.js'
import type { WebhookEventType } from '../services/webhooks/index.js'
import { outboxEmitter } from '../db/outbox/emitter.js'

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
 * Emit webhook event to outbox for identity state change.
 * Call this within the same transaction as the state update.
 * 
 * @param db - Database connection or transaction client
 * @param oldState - Previous identity state (null if new)
 * @param newState - New identity state
 */
export async function emitWebhookForStateChange(
  db: Queryable,
  oldState: IdentityState | null,
  newState: IdentityState
): Promise<void> {
  const eventType = detectEventType(oldState, newState)
  
  if (eventType) {
    await outboxEmitter.emit(db, {
      aggregateType: 'identity',
      aggregateId: newState.address,
      eventType,
      payload: {
        address: newState.address,
        bondedAmount: newState.bondedAmount,
        bondStart: newState.bondStart,
        bondDuration: newState.bondDuration,
        active: newState.active,
      },
    })
  }
}
