import { createHash } from 'crypto'

export const WEBHOOK_IDEMPOTENCY_PREFIX = 'webhook-delivery'

/**
 * Generate a deterministic idempotency key for a webhook delivery.
 * The key is derived from the webhook subscriber id and the originating event id.
 */
export function generateWebhookIdempotencyKey(subscriberId: string, eventId: string): string {
  return createHash('sha256')
    .update(`${WEBHOOK_IDEMPOTENCY_PREFIX}:${subscriberId}:${eventId}`)
    .digest('hex')
}
