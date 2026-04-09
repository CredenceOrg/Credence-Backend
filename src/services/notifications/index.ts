/**
 * Notification service for idempotent email delivery.
 * 
 * Features:
 * - Idempotency keys prevent duplicate sends on retries
 * - Persistent send markers prevent duplicate delivers
 * - Provider response reconciliation for unknown outcomes
 * - Exponential backoff with configurable retry semantics
 * - Metrics collection for deduplicated sends
 * - Provider adapter abstraction for compatibility
 */

export type {
  EmailNotification,
  NotificationRecipient,
  IdempotencyKey,
  SendAttempt,
  NotificationDeliveryResult,
  NotificationMetrics,
  DeliveryOptions,
  EmailProvider,
  NotificationStore,
} from './types.js'

export type { DeliveryMetricsEvent, MetricsCallback } from './metrics.js'

export {
  HttpEmailProvider,
  SendGridProvider,
  MailgunProvider,
  MockEmailProvider,
  createEmailProvider,
} from './providers.js'

export { NotificationRepository } from './repository.js'

export { IdempotentEmailDeliveryService, deliverNotification } from './delivery.js'

export {
  NotificationService,
  createNotificationService,
  createNotificationServiceWithProvider,
} from './service.js'

export { NotificationMetricsCollector, metricsToPrometheus, metricsToString } from './metrics.js'
