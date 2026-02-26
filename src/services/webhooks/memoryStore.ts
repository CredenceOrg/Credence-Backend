import type { WebhookStore, WebhookConfig, WebhookEventType } from './types.js'

/**
 * In-memory webhook store for testing/development.
 * In production, use a database-backed store.
 */
export class MemoryWebhookStore implements WebhookStore {
  private webhooks = new Map<string, WebhookConfig>()

  async getByEvent(event: WebhookEventType): Promise<WebhookConfig[]> {
    return Array.from(this.webhooks.values()).filter(w => w.events.includes(event))
  }

  async get(id: string): Promise<WebhookConfig | null> {
    return this.webhooks.get(id) ?? null
  }

  async set(config: WebhookConfig): Promise<void> {
    this.webhooks.set(config.id, config)
  }
}
