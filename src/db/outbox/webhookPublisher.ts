import type { EventPublisher } from './publisher.js'
import type { OutboxEvent } from './types.js'
import type { WebhookService } from '../../services/webhooks/service.js'
import type { WebhookEventType } from '../../services/webhooks/types.js'
import { logger } from '../../utils/logger.js'

/**
 * Event publisher that integrates with the webhook service.
 * Publishes domain events from the outbox to registered webhooks.
 *
 * Invariants:
 *  - A given outbox event is either forwarded exactly once or not at all;
 *    the publisher never duplicates a delivery on its own account.
 *  - Unmapped event types are skipped (not an error) and logged at debug
 *    level so they do not noise up warning channels.
 *  - Errors from the webhook service are propagated to the caller so the
 *    outbox retry loop can attempt redelivery; the publisher does not swallow
 *    failures.
 *  - No payload content is included in logs; only identifiers and types.
 */
export class WebhookEventPublisher implements EventPublisher {
  constructor(private readonly webhookService: WebhookService) {}

  async publish(event: OutboxEvent): Promise<void> {
    // Map outbox event types to webhook event types
    const webhookEventType = this.mapEventType(event.eventType)

    if (!webhookEventType) {
      // Unmapped event types are expected during rollout of new domain
      // events; treat as a no-op but keep a trail for diagnosis.
      logger.debug(
        `[WebhookEventPublisher] Skipping unmapped event type: ${event.eventType} (id=${event.id})`
      )
      return
    }

    // Emit to webhook service, carrying the correlation id forward so the
    // outbound delivery can tag its request and logs with it.
    // Errors are logged with correlation context and re-thrown so the outbox
    // retry mechanism observes the failure and can retry with backoff.
    try {
      await this.webhookService.emit(webhookEventType, event.payload as any, {
        correlationId: event.correlationId ?? undefined,
      })
    } catch (error) {
      logger.error(
        `[WebhookEventPublisher] Failed to emit ${webhookEventType} for outbox event id=${event.id} correlationId=${event.correlationId ?? 'none'}`,
        error
      )
      throw error
    }
  }

  /**
   * Map domain event types to webhook event types.
   * Extend this as new event types are added.
   */
  private mapEventType(eventType: string): WebhookEventType | null {
    const mapping: Record<string, WebhookEventType> = {
      'bond.created': 'bond.created',
      'bond.slashed': 'bond.slashed',
      'bond.withdrawn': 'bond.withdrawn',
      'attestation.created': 'attestation.added',
      'attestation.revoked': 'attestation.revoked',
      'credits.low': 'credits.low',
    }

    return mapping[eventType] ?? null
  }
}
