import type { Queryable } from '../db/repositories/queryable.js'
import type { IdentityState } from './types.js'
import type { WebhookEventType } from '../services/webhooks/index.js'
import { detectEventType } from './webhookDetection.js'
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
export async function emitWebhookForAttestationChange(
  db: any,
  eventType: 'attestation.added' | 'attestation.revoked',
  payload: { address: string; attestationId?: string; verifier?: string; weight?: number; claim?: string }
): Promise<void> {
  await outboxEmitter.emit(db, {
    aggregateType: 'identity',
    aggregateId: payload.address,
    eventType,
    payload: {
      address: payload.address,
      ...payload
    },
  })
}

export async function emitWebhookForScoreChange(
  db: any,
  address: string,
  oldScore: number | null,
  newScore: number
): Promise<void> {
  if (oldScore !== newScore) {
    await outboxEmitter.emit(db, {
      aggregateType: 'identity',
      aggregateId: address,
      eventType: 'score.updated',
      payload: {
        address,
        score: newScore
      },
    })
  }
}

