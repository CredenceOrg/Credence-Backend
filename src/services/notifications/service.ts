import type {
  EmailNotification,
  EmailProvider,
  NotificationDeliveryResult,
  DeliveryOptions,
  NotificationStore,
} from './types.js'
import { IdempotentEmailDeliveryService } from './delivery.js'
import { MemoryNotificationDlqStore } from './dlq.js'
import { NotificationProviderHealthTracker } from './health.js'
import { NotificationMetricsCollector } from './metrics.js'

/**
 * Notification service for idempotent email delivery.
 *
 * Features:
 * - Idempotent delivery prevents duplicate sends on retries
 * - Exponential backoff with configurable retry limits
 * - Provider response reconciliation for unknown outcomes
 * - Metrics collection for deduplication tracking
 * - Rate limiting per provider
 */
export class NotificationService {
  private rateLimitMap = new Map<string, number>()
  private metricsCollector: NotificationMetricsCollector
  private readonly healthTracker = new NotificationProviderHealthTracker()
  private readonly dlqStore = new MemoryNotificationDlqStore()

  constructor(
    private readonly store: NotificationStore,
    private readonly providers: Map<string, EmailProvider>,
    private readonly defaultProvider: string = 'sendgrid'
  ) {
    this.metricsCollector = new NotificationMetricsCollector()
  }

  /**
   * Send a notification email with idempotency protection.
   * Returns immediately; delivery happens asynchronously in queue.
   */
  async send(
    notification: EmailNotification,
    options?: DeliveryOptions & { providerName?: string }
  ): Promise<NotificationDeliveryResult> {
    const providerName = options?.providerName ?? this.defaultProvider
    const providerChain = this.getOrderedProviders(providerName)

    if (providerChain.length === 0) {
      throw new Error(`Email provider not found: ${providerName}`)
    }

    const result = await this.deliverNotification(notification, providerChain, options)

    // Record metrics
    await this.metricsCollector.recordDelivery(result)

    return result
  }

  /**
   * Send multiple notifications in parallel (respecting rate limits).
   */
  async sendBatch(
    notifications: EmailNotification[],
    options?: DeliveryOptions & { providerName?: string }
  ): Promise<NotificationDeliveryResult[]> {
    const results = await Promise.all(
      notifications.map(notification => this.send(notification, options))
    )
    return results
  }

  /**
   * Get delivery metrics.
   */
  getMetrics() {
    return this.metricsCollector.getMetrics()
  }

  /**
   * Register a metrics event listener.
   */
  onMetrics(callback: (event: { type: string; notificationId: string; timestamp: Date }) => void) {
    return this.metricsCollector.on(callback)
  }

  /**
   * Deliver a single notification with idempotency protection.
   */
  private async deliverNotification(
    notification: EmailNotification,
    providers: EmailProvider[],
    options?: DeliveryOptions
  ): Promise<NotificationDeliveryResult> {
    const rateLimitedProviders = providers.map(provider => ({
      ...provider,
      send: async (
        queuedNotification: EmailNotification,
        sendOptions?: { timeout?: number; idempotencyKey?: string; attemptNumber?: number }
      ) =>
        this.deliverWithRateLimit(provider.name, () =>
          provider.send(queuedNotification, sendOptions)
        ),
    }))

    const deliveryService = new IdempotentEmailDeliveryService(
      this.store,
      rateLimitedProviders,
      {
        dlqStore: this.dlqStore,
        healthTracker: this.healthTracker,
      }
    )
    return deliveryService.deliver(notification, options)
  }

  private getOrderedProviders(primaryProviderName: string): EmailProvider[] {
    const providers = Array.from(this.providers.values())
    const primaryProvider = this.providers.get(primaryProviderName)

    if (!primaryProvider) {
      return []
    }

    return [
      primaryProvider,
      ...providers.filter(provider => provider.name !== primaryProvider.name),
    ]
  }

  /**
   * Rate limit: max 10 deliveries per provider per 100ms.
   * Prevents overwhelming email service providers.
   */
  private async deliverWithRateLimit<T>(
    providerName: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const now = Date.now()
    const lastDelivery = this.rateLimitMap.get(providerName) ?? 0
    const timeSinceLastDelivery = now - lastDelivery

    if (timeSinceLastDelivery < 10) {
      await new Promise(resolve => setTimeout(resolve, 10 - timeSinceLastDelivery))
    }

    this.rateLimitMap.set(providerName, Date.now())
    return fn()
  }
}

/**
 * Create a notification service with providers.
 */
export function createNotificationService(
  store: NotificationStore,
  providers: Map<string, EmailProvider>,
  defaultProvider?: string
): NotificationService {
  return new NotificationService(store, providers, defaultProvider)
}

/**
 * Create a notification service with a single provider.
 */
export function createNotificationServiceWithProvider(
  store: NotificationStore,
  provider: EmailProvider,
  providerName: string = 'default'
): NotificationService {
  const providers = new Map([[providerName, provider]])
  return new NotificationService(store, providers, providerName)
}
