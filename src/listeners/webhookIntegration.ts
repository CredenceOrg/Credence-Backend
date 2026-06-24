import type { IdentityState } from './types.js'
import { detectEventType } from './webhookDetection.js'
import type { WebhookService, WebhookEventType } from '../services/webhooks/index.js'


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
export async function emitWebhookForAttestationChange(
  webhookService: WebhookService,
  eventType: 'attestation.added' | 'attestation.revoked',
  payload: { address: string; attestationId?: string; verifier?: string; weight?: number; claim?: string }
): Promise<void> {
  await webhookService.emit(eventType, {
    address: payload.address,
    ...payload
  })
}

export async function emitWebhookForScoreChange(
  webhookService: WebhookService,
  address: string,
  oldScore: number | null,
  newScore: number
): Promise<void> {
  if (oldScore !== newScore) {
    await webhookService.emit('score.updated', {
      address,
      score: newScore
    })
  }
}

