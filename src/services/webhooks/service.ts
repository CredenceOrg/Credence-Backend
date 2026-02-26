import type { WebhookStore, WebhookEventType, WebhookPayload, WebhookDeliveryResult } from './types.js'
import { deliverWebhook, type DeliveryOptions } from './delivery.js'

/**
 * Webhook service for delivering bond lifecycle events.
 */
export class WebhookService {
  private deliveryQueue: Promise<void> = Promise.resolve()
  private rateLimitMap = new Map<string, number>()

  constructor(
    private readonly store: WebhookStore,
    private readonly deliveryOptions?: DeliveryOptions
  ) {}

  /**
   * Emit an event to all subscribed webhooks.
   * Deliveries are queued and rate-limited per webhook.
   */
  async emit(event: WebhookEventType, data: WebhookPayload['data']): Promise<WebhookDeliveryResult[]> {
    const webhooks = await this.store.getByEvent(event)
    const activeWebhooks = webhooks.filter(w => w.active)

    if (activeWebhooks.length === 0) {
      return []
    }

    const payload: WebhookPayload = {
      event,
      timestamp: new Date().toISOString(),
      data,
    }

    const results = await Promise.all(
      activeWebhooks.map(webhook => this.deliverWithRateLimit(webhook.id, () =>
        deliverWebhook(webhook, payload, this.deliveryOptions)
      ))
    )

    return results
  }

  /**
   * Rate limit: max 1 delivery per webhook per 100ms.
   */
  private async deliverWithRateLimit<T>(
    webhookId: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const now = Date.now()
    const lastDelivery = this.rateLimitMap.get(webhookId) ?? 0
    const timeSinceLastDelivery = now - lastDelivery

    if (timeSinceLastDelivery < 100) {
      await new Promise(resolve => setTimeout(resolve, 100 - timeSinceLastDelivery))
    }

    this.rateLimitMap.set(webhookId, Date.now())
    return fn()
  }
}

/**
 * Create webhook service with store and optional delivery options.
 */
export function createWebhookService(
  store: WebhookStore,
  deliveryOptions?: DeliveryOptions
): WebhookService {
  return new WebhookService(store, deliveryOptions)
}
