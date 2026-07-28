import { randomBytes } from 'crypto'
import type { WebhookStore, WebhookEventType, WebhookPayload, WebhookDeliveryResult, WebhookConfig, DlqStore, WebhookEmitOptions } from './types.js'
import { deliverWebhook, type DeliveryOptions } from './delivery.js'
import { type AuditLogService, AuditAction } from '../audit/index.js'
import { buildDlqEntry } from './dlq.js'
import {
  recordJobDeadLetter,
  recordJobTerminalOutcome,
} from '../../jobs/retryMetrics.js'
import { recordWebhookDeliveryOutcome } from '../../metrics/webhookLagDashboard.js'

/**
 * Webhook service for delivering bond lifecycle events.
 */
export class WebhookService {
  private deliveryQueue: Promise<void> = Promise.resolve()
  private rateLimitMap = new Map<string, number>()

  constructor(
    private readonly store: WebhookStore,
    private readonly deliveryOptions?: DeliveryOptions,
    private readonly dlq?: DlqStore,
    private readonly auditLog?: AuditLogService,
  ) {}

  /**
   * Rotate a webhook's signing secret.
   * Moves current secret to previousSecret and generates a new one.
   */
  async rotateSecret(id: string, admin?: { id: string, email: string, tenantId: string }, requestId?: string): Promise<WebhookConfig> {
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
        admin.tenantId,
        admin.id,
        admin.email,
        AuditAction.ROTATE_WEBHOOK_SECRET,
        id,
        webhook.url,
        { rotatedAt: webhook.secretUpdatedAt },
        undefined,
        undefined,
        undefined,
        requestId
      )
    }

    return webhook
  }

  /**
   * Revoke the previous secret for a webhook.
   */
  async revokePreviousSecret(id: string, admin?: { id: string, email: string, tenantId: string }, requestId?: string): Promise<WebhookConfig> {
    const webhook = await this.store.get(id)
    if (!webhook) {
      throw new Error('Webhook not found')
    }

    webhook.previousSecret = undefined
    await this.store.set(webhook)

    if (this.auditLog && admin) {
      this.auditLog.logAction(
        admin.tenantId,
        admin.id,
        admin.email,
        AuditAction.REVOKE_WEBHOOK_SECRET,
        id,
        webhook.url,
        undefined,
        undefined,
        undefined,
        undefined,
        requestId
      )
    }

    return webhook
  }

  /**
   * Emit an event to all subscribed webhooks.
   * Deliveries are queued and rate-limited per webhook.
   * Permanently failed deliveries are routed to the DLQ if one is configured.
   */
  async emit(event: WebhookEventType, data: WebhookPayload['data'], options: WebhookEmitOptions = {}): Promise<(WebhookDeliveryResult | WebhookDeliveryResult[])[]> {
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

    const rawResults = await Promise.all(
      activeWebhooks.map(webhook => this.deliverWithRateLimit(webhook.id, () =>
        deliverWebhook(webhook, payload, {
          ...this.deliveryOptions,
          returnAllChunks: true,
          eventId: options.eventId,
          idempotencyStore: this.store,
        })
      ))
    )

    const flatResults = rawResults.flat()

    if (this.dlq) {
      // Cross-cutting retry/DLQ metrics — see src/jobs/retryMetrics.ts.
      // We compute the exhausted-result list exactly once and reuse it for
      // both the metric increment AND the DLQ push so the metrics always
      // agree with what was actually DLQ-ed. Reason attribution prefers
      // `error` (human-readable message), falling back to mTLS-specific
      // `errorCode`, then to `UNKNOWN`. The boundedReason helper inside
      // retryMetrics.ts normalizes the label to a low-cardinality
      // ASCII-uppercase-underscore identifier.
      const exhaustedResults = flatResults.filter(r => !r.success)
      for (const r of exhaustedResults) {
        const reasonText = r.error ?? r.errorCode ?? 'UNKNOWN'
        // WebhookDeliveryResult.attempts is REQUIRED by the type but the
        // runtime path is defensive — historical callers have delivered
        // results that omit it under failure paths.
        const attempts =
          typeof r.attempts === 'number' && r.attempts >= 1 ? r.attempts : 1
        recordJobDeadLetter('webhook', reasonText)
        recordJobTerminalOutcome('webhook', 'dead_letter', attempts)
      }
      await Promise.all(
        exhaustedResults.map(r => this.dlq!.push(buildDlqEntry(r, payload)))
      )
    }

    // Compact lag-dashboard success-rate counters (no high-cardinality labels).
    // See docs/WEBHOOK_LAG_DASHBOARD.md / src/metrics/webhookLagDashboard.ts.
    for (const r of flatResults) {
      recordWebhookDeliveryOutcome(r.success ? 'success' : 'failure')
    }

    return rawResults.map(webhookResults => 
      webhookResults.length === 1 ? webhookResults[0] : webhookResults
    )
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

  /**
   * Replay a specific webhook delivery from the DLQ.
   */
  async replayWebhook(dlqId: string, admin?: { id: string, email: string, tenantId: string }, requestId?: string): Promise<WebhookDeliveryResult> {
    if (!this.dlq) {
      throw new Error('DLQ is not configured')
    }
    const entry = await this.dlq.get(dlqId)
    if (!entry) {
      throw new Error('DLQ entry not found')
    }

    const webhook = await this.store.get(entry.webhookId)
    if (!webhook) {
      throw new Error('Webhook not found')
    }

    // Deliver without idempotency check since we are explicitly replaying
    const results = await deliverWebhook(webhook, entry.payload, {
      ...this.deliveryOptions,
      returnAllChunks: true,
      eventId: entry.payload.data && typeof entry.payload.data === 'object' && 'eventId' in entry.payload.data ? (entry.payload.data as any).eventId : undefined,
    })

    const allSucceeded = results.every(r => r.success)
    if (allSucceeded) {
      await this.dlq.markReplayed(dlqId, new Date().toISOString())
    }

    const result = results[0]

    if (this.auditLog && admin) {
      this.auditLog.logAction(
        admin.tenantId,
        admin.id,
        admin.email,
        AuditAction.REPLAY_WEBHOOK,
        dlqId,
        webhook.url,
        { webhookId: entry.webhookId, success: result.success },
        undefined,
        undefined,
        undefined,
        requestId
      )
    }

    return result
  }
}

/**
 * Create webhook service with store and optional delivery options.
 */
export function createWebhookService(
  store: WebhookStore,
  deliveryOptions?: DeliveryOptions,
  dlq?: DlqStore,
  auditLog?: AuditLogService,
): WebhookService {
  return new WebhookService(store, deliveryOptions, dlq, auditLog)
}
