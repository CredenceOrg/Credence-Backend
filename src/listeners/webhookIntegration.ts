import type { IdentityState } from './types.js'
import type { WebhookService } from '../services/webhooks/index.js'
import { detectEventType } from './webhookEventDetection.js'

export { detectEventType } from './webhookEventDetection.js'

/**
 * Emit webhook for identity state change via direct service call.
 *
 * @deprecated Use `emitWebhookForStateChange` from `./webhookIntegrationOutbox.js`
 * instead. Direct emission bypasses the transactional outbox and is not crash-safe.
 * This module is retained only for backward compatibility and will be removed in a
 * future release.
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
