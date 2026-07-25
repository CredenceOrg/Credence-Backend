import type {
  DeliveryOptions,
  EmailNotification,
  EmailProvider,
  NotificationDeliveryResult,
  NotificationDlqAttempt,
  NotificationDlqStore,
  NotificationStore,
} from './types.js'
import { createHash } from 'crypto'
import {
  NOTIFICATION_DELIVERY_JOB_TYPE,
  buildNotificationDeliveryJobKey,
  type AsyncJob,
  type IdempotentJobResult,
} from '../../jobs/notificationIdempotency.js'
import { buildNotificationDlqEntry } from './dlq.js'
import { NotificationProviderHealthTracker } from './health.js'
import {
  recordNotificationDlq,
  recordNotificationFailover,
  recordNotificationProviderAttempt,
  recordNotificationProviderSuccess,
} from './promMetrics.js'

/**
 * Generate an idempotency key for a notification provider attempt.
 */
function generateIdempotencyKey(notificationId: string, attemptGroup: number): string {
  const key = `${notificationId}:${attemptGroup}`
  return createHash('sha256').update(key).digest('hex')
}

interface DeliveryErrorClassification {
  message: string
  retryable: boolean
  transient: boolean
  ambiguous: boolean
  statusCode?: number
}

interface NotificationStoreWithJobExecutor extends NotificationStore {
  executeIdempotentJob<T>(
    jobKey: string,
    jobType: string,
    job: AsyncJob<T>,
    expiresInSeconds?: number
  ): Promise<IdempotentJobResult<T>>
}

export interface IdempotentEmailDeliveryDependencies {
  /** Optional DLQ store for exhausted or ambiguous deliveries. */
  dlqStore?: NotificationDlqStore
  /** Shared provider health tracker across notification sends. */
  healthTracker?: NotificationProviderHealthTracker
  /** Injectable sleep helper for tests. */
  sleep?: (delayMs: number) => Promise<void>
  /** Injectable random source for deterministic jitter in tests. */
  random?: () => number
}

function isStoreWithJobExecutor(
  store: NotificationStore
): store is NotificationStoreWithJobExecutor {
  return typeof (store as NotificationStoreWithJobExecutor).executeIdempotentJob === 'function'
}

function classifyDeliveryError(error: unknown): DeliveryErrorClassification {
  const message = error instanceof Error ? error.message : 'Unknown error'
  const normalized = message.toLowerCase()
  const statusMatch = message.match(/\b([45]\d{2})\b/)
  const statusCode = statusMatch ? Number(statusMatch[1]) : undefined

  if (
    normalized.includes('timeout') ||
    normalized.includes('timed out') ||
    normalized.includes('abort')
  ) {
    return {
      message,
      retryable: false,
      transient: true,
      ambiguous: true,
      statusCode,
    }
  }

  if (
    normalized.includes('5xx') ||
    (statusCode !== undefined && statusCode >= 500) ||
    normalized.includes('fetch failed') ||
    normalized.includes('econnreset') ||
    normalized.includes('econnrefused') ||
    normalized.includes('enotfound') ||
    normalized.includes('eai_again')
  ) {
    return {
      message,
      retryable: true,
      transient: true,
      ambiguous: false,
      statusCode,
    }
  }

  return {
    message,
    retryable: false,
    transient: false,
    ambiguous: false,
    statusCode,
  }
}

/**
 * Idempotent email delivery service with provider failover, retry/backoff, and DLQ routing.
 */
export class IdempotentEmailDeliveryService {
  private readonly providers: EmailProvider[]
  private readonly dlqStore?: NotificationDlqStore
  private readonly healthTracker: NotificationProviderHealthTracker
  private readonly sleep: (delayMs: number) => Promise<void>
  private readonly random: () => number

  constructor(
    private readonly store: NotificationStore,
    providers: EmailProvider | EmailProvider[],
    dependencies: IdempotentEmailDeliveryDependencies = {}
  ) {
    this.providers = Array.isArray(providers) ? providers : [providers]
    this.dlqStore = dependencies.dlqStore
    this.healthTracker =
      dependencies.healthTracker ?? new NotificationProviderHealthTracker()
    this.sleep =
      dependencies.sleep ??
      (async (delayMs: number) => {
        await new Promise(resolve => setTimeout(resolve, delayMs))
      })
    this.random = dependencies.random ?? (() => Math.random())
  }

  /**
   * Deliver a notification with idempotency protection and bounded failover.
   */
  async deliver(
    notification: EmailNotification,
    options: DeliveryOptions = {}
  ): Promise<NotificationDeliveryResult> {
    if (!isStoreWithJobExecutor(this.store)) {
      return this.executeDelivery(notification, options)
    }

    let terminalFailure: NotificationDeliveryResult | null = null

    try {
      const result = await this.store.executeIdempotentJob(
        buildNotificationDeliveryJobKey(notification.id),
        NOTIFICATION_DELIVERY_JOB_TYPE,
        {
          run: async () => {
            const deliveryResult = await this.executeDelivery(notification, options)
            if (!deliveryResult.success) {
              terminalFailure = deliveryResult
              throw new Error(`notification delivery failed: ${notification.id}`)
            }
            return deliveryResult
          },
        }
      )

      if (result.alreadyProcessed && result.result) {
        return {
          ...result.result,
          deduped: true,
        }
      }

      if (!result.result) {
        throw new Error(`Notification delivery returned no result for ${notification.id}`)
      }

      return result.result
    } catch (error) {
      if (terminalFailure) {
        return terminalFailure
      }

      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      const sentAttempt = await this.store.getLastSendAttempt(notification.id)

      if (sentAttempt?.status === 'sent') {
        return {
          notificationId: notification.id,
          success: true,
          deduped: true,
          statusCode: 200,
          providerResponseId: sentAttempt.providerResponseId,
          attempts: 1,
          idempotencyKey: sentAttempt.idempotencyKey,
          provider: sentAttempt.provider,
        }
      }

      if (errorMessage.includes('already pending')) {
        return {
          notificationId: notification.id,
          success: false,
          deduped: true,
          error: errorMessage,
          attempts: 0,
          idempotencyKey: buildNotificationDeliveryJobKey(notification.id),
        }
      }

      throw error
    }
  }

  /**
   * Reconcile a notification send with provider response.
   */
  async reconcileSend(
    notificationId: string,
    providerResponseId: string,
    statusCode: number
  ): Promise<void> {
    const attempt = await this.store.getLastSendAttempt(notificationId)
    const providerName = this.providers[0]?.name ?? 'unknown'

    if (!attempt) {
      const idempotencyKey = generateIdempotencyKey(notificationId, 1)
      const status = statusCode >= 200 && statusCode < 300 ? 'sent' : 'failed'
      const errorMessage = status === 'failed' ? `Provider returned ${statusCode}` : undefined

      await this.store.createSendAttempt({
        notificationId,
        idempotencyKey,
        attemptGroup: 1,
        attemptNumber: 1,
        provider: providerName,
        status,
        providerResponseId,
        errorMessage,
        attemptedAt: new Date(),
      })
      return
    }

    if (statusCode >= 200 && statusCode < 300) {
      await this.store.updateSendAttempt(attempt.id, {
        status: 'sent',
        providerResponseId,
        sentAt: new Date(),
      })
      this.healthTracker.recordSuccess(attempt.provider)
      return
    }

    if (statusCode >= 400 && statusCode < 500) {
      await this.store.updateSendAttempt(attempt.id, {
        status: 'failed',
        errorMessage: `Provider returned ${statusCode}`,
      })
    }
  }

  private async executeDelivery(
    notification: EmailNotification,
    options: DeliveryOptions
  ): Promise<NotificationDeliveryResult> {
    const {
      maxRetries = 3,
      maxAttempts = maxRetries + 1,
      initialDelay = 1000,
      backoffMultiplier = 2,
      jitterFactor = 0.2,
      timeout = 5000,
    } = options

    if (this.providers.length === 0) {
      throw new Error('No email providers configured')
    }

    const existingAttempt = await this.store.getLastSendAttempt(notification.id)
    if (existingAttempt?.status === 'sent') {
      return {
        notificationId: notification.id,
        success: true,
        deduped: true,
        statusCode: 200,
        providerResponseId: existingAttempt.providerResponseId,
        attempts: 1,
        idempotencyKey: existingAttempt.idempotencyKey,
        provider: existingAttempt.provider,
      }
    }

    let attemptGroup = (existingAttempt?.attemptGroup ?? 0) + 1
    let attempts = 0
    let cycle = 0
    const failures: NotificationDlqAttempt[] = []

    while (attempts < maxAttempts) {
      const orderedProviders = this.healthTracker.orderProviders(this.providers)

      for (
        let providerIndex = 0;
        providerIndex < orderedProviders.length && attempts < maxAttempts;
        providerIndex++
      ) {
        const provider = orderedProviders[providerIndex]
        const attemptNumber = attempts + 1
        const idempotencyKey = generateIdempotencyKey(notification.id, attemptGroup++)

        const existingSend = await this.store.getSendByIdempotencyKey(idempotencyKey)
        if (existingSend?.status === 'sent') {
          return {
            notificationId: notification.id,
            success: true,
            deduped: true,
            statusCode: 200,
            providerResponseId: existingSend.providerResponseId,
            attempts: attemptNumber,
            idempotencyKey,
            provider: existingSend.provider,
          }
        }

        const sendAttempt = await this.store.createSendAttempt({
          notificationId: notification.id,
          idempotencyKey,
          attemptGroup: attemptGroup - 1,
          attemptNumber,
          provider: provider.name,
          status: 'pending',
          attemptedAt: new Date(),
        })

        try {
          const response = await provider.send(notification, {
            timeout,
            idempotencyKey,
            attemptNumber,
          })

          await this.store.updateSendAttempt(sendAttempt.id, {
            status: 'sent',
            sentAt: new Date(),
            providerResponseId: response.id,
          })

          this.healthTracker.recordSuccess(provider.name)
          recordNotificationProviderAttempt(provider.name, 'success')
          recordNotificationProviderSuccess(provider.name)

          return {
            notificationId: notification.id,
            success: true,
            deduped: false,
            statusCode: response.statusCode,
            providerResponseId: response.id,
            attempts: attemptNumber,
            idempotencyKey,
            provider: provider.name,
          }
        } catch (error) {
          attempts = attemptNumber
          const classification = classifyDeliveryError(error)
          const failure: NotificationDlqAttempt = {
            provider: provider.name,
            attemptNumber,
            idempotencyKey,
            error: classification.message,
            statusCode: classification.statusCode,
            transient: classification.transient,
            ambiguous: classification.ambiguous,
          }
          failures.push(failure)

          await this.store.updateSendAttempt(sendAttempt.id, {
            status: 'failed',
            errorMessage: classification.message,
          })

          this.healthTracker.recordFailure(provider.name, classification.transient)
          recordNotificationProviderAttempt(
            provider.name,
            classification.ambiguous
              ? 'ambiguous_failure'
              : classification.retryable
                ? 'retryable_failure'
                : 'permanent_failure'
          )

          if (classification.ambiguous) {
            return this.routeToDlq(
              notification,
              orderedProviders,
              failures,
              classification.message,
              attemptNumber,
              idempotencyKey,
              provider.name
            )
          }

          const nextProvider = orderedProviders[providerIndex + 1]
          if (classification.retryable && nextProvider && attempts < maxAttempts) {
            recordNotificationFailover(provider.name, nextProvider.name)
            continue
          }

          if (!classification.retryable || attempts >= maxAttempts) {
            return this.routeToDlq(
              notification,
              orderedProviders,
              failures,
              classification.message,
              attemptNumber,
              idempotencyKey,
              provider.name
            )
          }
        }
      }

      if (attempts >= maxAttempts || failures.length === 0) {
        break
      }

      cycle++
      const baseDelay = initialDelay * Math.pow(backoffMultiplier, cycle - 1)
      const jitterOffset = baseDelay * jitterFactor * this.random()
      await this.sleep(Math.round(baseDelay + jitterOffset))
    }

    const lastFailure = failures[failures.length - 1]
    return {
      notificationId: notification.id,
      success: false,
      deduped: false,
      error: lastFailure?.error ?? 'Max attempts exceeded',
      attempts,
      idempotencyKey:
        lastFailure?.idempotencyKey ??
        generateIdempotencyKey(notification.id, attemptGroup),
      provider: lastFailure?.provider,
    }
  }

  private async routeToDlq(
    notification: EmailNotification,
    orderedProviders: EmailProvider[],
    failures: NotificationDlqAttempt[],
    failureReason: string,
    attempts: number,
    idempotencyKey: string,
    provider: string
  ): Promise<NotificationDeliveryResult> {
    if (this.dlqStore) {
      const entry = buildNotificationDlqEntry({
        notification,
        providers: orderedProviders.map(candidate => candidate.name),
        attempts: failures,
        failureReason,
      })
      await this.dlqStore.push(entry)
    }

    recordNotificationDlq(failureReason)

    return {
      notificationId: notification.id,
      success: false,
      deduped: false,
      error: failureReason,
      attempts,
      idempotencyKey,
      provider,
    }
  }
}

/**
 * Deliver a notification with idempotency protection.
 */
export async function deliverNotification(
  notification: EmailNotification,
  provider: EmailProvider | EmailProvider[],
  store: NotificationStore,
  options?: DeliveryOptions,
  dependencies?: IdempotentEmailDeliveryDependencies
): Promise<NotificationDeliveryResult> {
  const service = new IdempotentEmailDeliveryService(store, provider, dependencies)
  return service.deliver(notification, options)
}
