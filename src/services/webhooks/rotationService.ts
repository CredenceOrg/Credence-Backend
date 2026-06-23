import { randomBytes } from 'crypto'
import type { WebhookStore, WebhookSecretRotationResult } from './types.js'
import type { AuditLogService } from '../audit/index.js'
import { AuditAction } from '../audit/index.js'

/** Grace period during which the previous secret remains valid for client verification. */
const PREVIOUS_SECRET_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

export class WebhookNotFoundError extends Error {
  constructor(webhookId: string) {
    super(`Webhook not found: ${webhookId}`)
    this.name = 'WebhookNotFoundError'
  }
}

/**
 * Handles webhook signing-secret rotation with safe-rollout semantics:
 * - Generates a cryptographically random new secret.
 * - Keeps the old secret alive as `previousSecret` for 24 h so consumers
 *   can migrate without downtime.
 * - Emits an audit log entry for every rotation attempt (success or failure).
 */
export class WebhookRotationService {
  constructor(
    private readonly store: WebhookStore,
    private readonly audit: AuditLogService,
  ) {}

  async rotateSecret(
    webhookId: string,
    actorId: string,
    actorEmail: string,
    ipAddress?: string,
  ): Promise<WebhookSecretRotationResult> {
    const webhook = await this.store.get(webhookId)

    if (!webhook) {
      void this.audit.logAction({
        tenantId: 'tenant-unknown',
        actorId,
        actorEmail,
        action: AuditAction.ROTATE_WEBHOOK_SECRET,
        resourceType: 'webhook',
        resourceId: webhookId,
        details: { webhookId },
        status: 'failure',
        errorMessage: 'Webhook not found',
        ipAddress,
      })
      throw new WebhookNotFoundError(webhookId)
    }

    const newSecret = randomBytes(32).toString('hex')
    const now = new Date()
    const previousSecretExpiresAt = new Date(now.getTime() + PREVIOUS_SECRET_TTL_MS).toISOString()
    const rotatedAt = now.toISOString()

    await this.store.rotateSecret(webhookId, newSecret, webhook.secret, previousSecretExpiresAt)

    void this.audit.logAction({
      tenantId: 'tenant-unknown',
      actorId,
      actorEmail,
      action: AuditAction.ROTATE_WEBHOOK_SECRET,
      resourceType: 'webhook',
      resourceId: webhookId,
      details: { webhookId, url: webhook.url, previousSecretExpiresAt },
      status: 'success',
      ipAddress,
    })

    return { webhookId, newSecret, rotatedAt, previousSecretExpiresAt }
  }
}
