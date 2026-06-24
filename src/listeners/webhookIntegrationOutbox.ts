import type { Queryable } from '../db/repositories/queryable.js'
import type { IdentityState } from './types.js'
import { outboxEmitter } from '../db/outbox/emitter.js'
import { detectEventType } from './webhookEventDetection.js'

export { detectEventType } from './webhookEventDetection.js'

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
