import type { WebhookStore, WebhookConfig, WebhookEventType } from './types.js'

/**
 * In-memory webhook store for testing/development.
 * In production, use a database-backed store.
 */
export class MemoryWebhookStore implements WebhookStore {
  private webhooks = new Map<string, WebhookConfig>()
  private deliveryReservations = new Map<string, string>()

  async getByEvent(event: WebhookEventType): Promise<WebhookConfig[]> {
    return Array.from(this.webhooks.values()).filter(w => w.events.includes(event))
  }

  async get(id: string): Promise<WebhookConfig | null> {
    return this.webhooks.get(id) ?? null
  }

  async set(config: WebhookConfig): Promise<void> {
    this.webhooks.set(config.id, config)
  }

  async reserveWebhookDelivery(subscriberId: string, eventId: string, idempotencyKey: string): Promise<boolean> {
    const marker = `${subscriberId}:${eventId}`
    if (this.deliveryReservations.has(marker)) {
      return false
    }

    this.deliveryReservations.set(marker, idempotencyKey)
    return true
  }

  async clearWebhookDeliveryAttempt(subscriberId: string, eventId: string): Promise<void> {
    this.deliveryReservations.delete(`${subscriberId}:${eventId}`)
  }

  async rotateSecret(
    id: string,
    newSecret: string,
    previousSecret: string,
    previousSecretExpiresAt: string,
  ): Promise<WebhookConfig> {
    const existing = this.webhooks.get(id)
    if (!existing) throw new Error(`Webhook not found: ${id}`)
    const updated: WebhookConfig = {
      ...existing,
      secret: newSecret,
      previousSecret,
      secretRotatedAt: new Date().toISOString(),
      previousSecretExpiresAt,
    }
    this.webhooks.set(id, updated)
    return updated
  }
}
