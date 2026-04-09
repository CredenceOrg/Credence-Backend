import type {
  EmailNotification,
  EmailProvider,
  NotificationDeliveryResult,
  DeliveryOptions,
  NotificationStore,
  SendAttempt,
} from './types.js'
import { createHash } from 'crypto'

/**
 * Generate an idempotency key for a notification dispatch attempt group.
 * Same attemptGroup will always produce the same key.
 */
function generateIdempotencyKey(
  notificationId: string,
  attemptGroup: number
): string {
  const key = `${notificationId}:${attemptGroup}`
  return createHash('sha256').update(key).digest('hex')
}

/**
 * Idempotent email delivery service.
 *
 * Prevents duplicate sends by:
 * 1. Persisting send marker BEFORE provider call
 * 2. Using idempotency keys to track attempt groups
 * 3. Deduplicating on retry of same attempt group
 * 4. Reconciling provider responses for unknown outcomes
 */
export class IdempotentEmailDeliveryService {
  constructor(
    private readonly store: NotificationStore,
    private readonly provider: EmailProvider
  ) {}

  /**
   * Deliver a notification with idempotency protection and retries.
   *
   * The send marker is persisted BEFORE the provider call, ensuring
   * that even if the provider fails or times out after accepting the
   * message, retries will be deduplicated.
   */
  async deliver(
    notification: EmailNotification,
    options: DeliveryOptions = {}
  ): Promise<NotificationDeliveryResult> {
    const {
      maxRetries = 3,
      initialDelay = 1000,
      backoffMultiplier = 2,
      timeout = 5000,
    } = options

    let attemptGroup = 1
    let lastAttempt: SendAttempt | null = null

    // Get the last attempt to determine if we're retrying
    const existingAttempt = await this.store.getLastSendAttempt(notification.id)
    if (existingAttempt?.status === 'sent') {
      // Already sent successfully
      return {
        notificationId: notification.id,
        success: true,
        deduped: true,
        statusCode: 200,
        providerResponseId: existingAttempt.providerResponseId,
        attempts: 1,
        idempotencyKey: existingAttempt.idempotencyKey,
      }
    }

    // For retries of unknown/timeout outcomes, increment attempt group
    if (existingAttempt && existingAttempt.status === 'pending') {
      attemptGroup = existingAttempt.attemptGroup + 1
    }

    for (let attemptNumber = 1; attemptNumber <= maxRetries + 1; attemptNumber++) {
      const idempotencyKey = generateIdempotencyKey(notification.id, attemptGroup)

      // Check if this idempotency key was already sent
      const existingSend = await this.store.getSendByIdempotencyKey(idempotencyKey)
      if (existingSend && existingSend.status === 'sent') {
        return {
          notificationId: notification.id,
          success: true,
          deduped: true,
          statusCode: 200,
          providerResponseId: existingSend.providerResponseId,
          attempts: attemptNumber,
          idempotencyKey,
        }
      }

      // Create send attempt record BEFORE provider call
      // This persists the marker early to prevent duplicate sends
      lastAttempt = await this.store.createSendAttempt({
        notificationId: notification.id,
        idempotencyKey,
        attemptGroup,
        attemptNumber,
        provider: this.provider.name,
        status: 'pending',
        attemptedAt: new Date(),
      })

      try {
        // Call provider with timeout handling
        const response = await this.provider.send(notification, { timeout })

        // Update attempt as sent with provider response ID
        await this.store.updateSendAttempt(lastAttempt.id, {
          status: 'sent',
          sentAt: new Date(),
          providerResponseId: response.id,
        })

        return {
          notificationId: notification.id,
          success: true,
          deduped: false,
          statusCode: response.statusCode,
          providerResponseId: response.id,
          attempts: attemptNumber,
          idempotencyKey,
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error'

        // Check if this is a retryable error
        const isRetryable =
          errorMessage.includes('timeout') ||
          errorMessage.includes('5xx') ||
          errorMessage.includes('503') ||
          errorMessage.includes('502') ||
          errorMessage.includes('500')

        if (attemptNumber === maxRetries + 1 || !isRetryable) {
          // Final attempt or non-retryable error
          await this.store.updateSendAttempt(lastAttempt.id, {
            status: 'failed',
            errorMessage,
          })

          return {
            notificationId: notification.id,
            success: false,
            deduped: false,
            error: errorMessage,
            attempts: attemptNumber,
            idempotencyKey,
          }
        }

        // Mark as failed but will retry with new attempt group
        await this.store.updateSendAttempt(lastAttempt.id, {
          status: 'failed',
          errorMessage,
        })

        // Exponential backoff
        const delay = initialDelay * Math.pow(backoffMultiplier, attemptNumber - 1)
        await new Promise(resolve => setTimeout(resolve, delay))

        // Increment attempt group for unknown/timeout outcomes
        if (errorMessage.includes('timeout') || !errorMessage.includes('5xx')) {
          attemptGroup++
        }
      }
    }

    // Should not reach here, but handle gracefully
    return {
      notificationId: notification.id,
      success: false,
      deduped: false,
      error: 'Max retries exceeded',
      attempts: maxRetries + 1,
      idempotencyKey: generateIdempotencyKey(notification.id, attemptGroup),
    }
  }

  /**
   * Reconcile a notification send with provider response.
   * Useful when you have a provider message ID but need to
   * reconcile the send status.
   */
  async reconcileSend(
    notificationId: string,
    providerResponseId: string,
    statusCode: number
  ): Promise<void> {
    // Find the most recent pending or failed attempt
    const attempt = await this.store.getLastSendAttempt(notificationId)

    if (!attempt) {
      // Create a reconciliation record
      const idempotencyKey = generateIdempotencyKey(notificationId, 1)
      const status = statusCode >= 200 && statusCode < 300 ? 'sent' : 'failed'
      const errorMessage = status === 'failed' ? `Provider returned ${statusCode}` : undefined

      await this.store.createSendAttempt({
        notificationId,
        idempotencyKey,
        attemptGroup: 1,
        attemptNumber: 1,
        provider: this.provider.name,
        status,
        providerResponseId,
        errorMessage,
        attemptedAt: new Date(),
      })
      return
    }

    // Update existing attempt
    if (statusCode >= 200 && statusCode < 300) {
      await this.store.updateSendAttempt(attempt.id, {
        status: 'sent',
        providerResponseId,
        sentAt: new Date(),
      })
    } else if (statusCode >= 400 && statusCode < 500) {
      await this.store.updateSendAttempt(attempt.id, {
        status: 'failed',
        errorMessage: `Provider returned ${statusCode}`,
      })
    }
  }
}

/**
 * Deliver a notification with idempotency protection.
 */
export async function deliverNotification(
  notification: EmailNotification,
  provider: EmailProvider,
  store: NotificationStore,
  options?: DeliveryOptions
): Promise<NotificationDeliveryResult> {
  const service = new IdempotentEmailDeliveryService(store, provider)
  return service.deliver(notification, options)
}
