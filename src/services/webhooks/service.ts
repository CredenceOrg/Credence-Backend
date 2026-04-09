import { randomBytes } from 'crypto'
import type { WebhookStore, WebhookEventType, WebhookPayload, WebhookDeliveryResult, WebhookConfig } from './types.js'
import { deliverWebhook, type DeliveryOptions } from './delivery.js'
import { type AuditLogService, AuditAction } from '../audit/index.js'

/**
 * Webhook service for delivering bond lifecycle events.
 */
export class WebhookService {
  private deliveryQueue: Promise<void> = Promise.resolve()
  private rateLimitMap = new Map<string, number>()

  constructor(
    private readonly store: WebhookStore,
    private readonly auditLog?: AuditLogService,
    private readonly deliveryOptions?: DeliveryOptions
  ) {}

  /**
   * Rotate a webhook's signing secret.
   * Moves current secret to previousSecret and generates a new one.
   */
  async rotateSecret(id: string, admin?: { id: string, email: string }): Promise<WebhookConfig> {
    const webhook = await this.store.get(id)
    if (!webhook) {
      throw new Error('Webhook not found')
    }

    // Move current to previous and generate new
    webhook.previousSecret = webhook.secret
    webhook.secret = randomBytes(32).toString('hex')
    webhook.secretUpdatedAt = new Date()

    await this.store.set(webhook)

    if (this.auditLog && admin) {
      this.auditLog.logAction(
        admin.id,
        admin.email,
        AuditAction.ROTATE_WEBHOOK_SECRET,
        id,
        webhook.url,
        { rotatedAt: webhook.secretUpdatedAt }
      )
    }

    return webhook
  }

  /**
   * Revoke the previous secret for a webhook.
   */
  async revokePreviousSecret(id: string, admin?: { id: string, email: string }): Promise<WebhookConfig> {
    const webhook = await this.store.get(id)
    if (!webhook) {
      throw new Error('Webhook not found')
    }

    webhook.previousSecret = undefined
    await this.store.set(webhook)

    if (this.auditLog && admin) {
      this.auditLog.logAction(
        admin.id,
        admin.email,
        AuditAction.REVOKE_WEBHOOK_SECRET,
        id,
        webhook.url
      )
    }

    return webhook
  }

  /**
   * Emit an event to all subscribed webhooks.
   * Deliveries are queued and rate-limited per webhook.
   * Permanently failed deliveries are routed to the DLQ if one is configured.
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

    if (this.dlq) {
      await Promise.all(
        results
          .filter(r => !r.success)
          .map(r => this.dlq!.push(buildDlqEntry(r, payload)))
      )
    }

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
  auditLog?: AuditLogService,
  deliveryOptions?: DeliveryOptions
): WebhookService {
  return new WebhookService(store, auditLog, deliveryOptions)
}
