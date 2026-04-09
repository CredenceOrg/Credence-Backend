import type { EventPublisher } from './publisher.js'
import type { OutboxEvent } from './types.js'
import type { WebhookService } from '../../services/webhooks/service.js'
import type { WebhookEventType } from '../../services/webhooks/types.js'

/**
 * Event publisher that integrates with the webhook service.
 * Publishes domain events from the outbox to registered webhooks.
 */
export class WebhookEventPublisher implements EventPublisher {
  constructor(private webhookService: WebhookService) {}

  async publish(event: OutboxEvent): Promise<void> {
    // Map outbox event types to webhook event types
    const webhookEventType = this.mapEventType(event.eventType)
    
    if (!webhookEventType) {
      console.warn(`[WebhookEventPublisher] Unknown event type: ${event.eventType}`)
      return
    }

    // Emit to webhook service
    await this.webhookService.emit(webhookEventType, event.payload as any)
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
      'attestation.created': 'attestation.created',
      'attestation.revoked': 'attestation.revoked',
    }

    return mapping[eventType] ?? null
  }
}
