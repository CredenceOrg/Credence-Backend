/**
 * Email notification types for idempotent dispatch.
 */

/**
 * Recipient of an email notification.
 */
export interface NotificationRecipient {
  /** Email address. */
  email: string
  /** Optional recipient name. */
  name?: string
}

/**
 * Email notification to be sent.
 */
export interface EmailNotification {
  /** Unique identifier for this notification. */
  id: string
  /** Recipient(s) of the email. */
  recipients: NotificationRecipient[]
  /** Email subject line. */
  subject: string
  /** Email body content (HTML or plain text). */
  body: string
  /** Email body content type. */
  contentType?: 'text/plain' | 'text/html'
  /** Optional metadata for tracking/debugging. */
  metadata?: Record<string, string | number | boolean>
}

/**
 * Idempotency key for a notification dispatch attempt.
 * Groups related retries to prevent duplicates.
 */
export interface IdempotencyKey {
  /** Unique key for this dispatch attempt group. */
  key: string
  /** Notification ID. */
  notificationId: string
  /** Attempt group identifier (incremented on timeout/unknown outcome). */
  attemptGroup: number
}

/**
 * Tracked send attempt for idempotency.
 */
export interface SendAttempt {
  /** Unique identifier. */
  id: string
  /** Notification ID being sent. */
  notificationId: string
  /** Idempotency key for this attempt group. */
  idempotencyKey: string
  /** Attempt group identifier for related retries. */
  attemptGroup: number
  /** Attempt number within this group. */
  attemptNumber: number
  /** Email provider used. */
  provider: string
  /** Status of the send attempt. */
  status: 'pending' | 'sent' | 'failed' | 'deduped'
  /** Provider response code/ID if available. */
  providerResponseId?: string
  /** Error message if failed. */
  errorMessage?: string
  /** Timestamp of the send attempt. */
  attemptedAt: Date
  /** Timestamp when marked as sent (set before provider call returns). */
  sentAt?: Date
}

/**
 * Result of a notification delivery attempt.
 */
export interface NotificationDeliveryResult {
  /** Notification ID. */
  notificationId: string
  /** Whether delivery succeeded. */
  success: boolean
  /** Whether this was a deduplicated send (idempotency worked). */
  deduped: boolean
  /** HTTP status code if applicable. */
  statusCode?: number
  /** Provider response ID if available. */
  providerResponseId?: string
  /** Error message if failed. */
  error?: string
  /** Number of attempts made. */
  attempts: number
  /** Idempotency key used. */
  idempotencyKey: string
  /** Provider that ultimately delivered or failed the notification. */
  provider?: string
}

/**
 * Metrics for notification delivery.
 */
export interface NotificationMetrics {
  /** Total sends attempted. */
  totalAttempts: number
  /** Successful sends. */
  successfulSends: number
  /** Failed sends. */
  failedSends: number
  /** Deduplicated sends (prevented by idempotency). */
  deduplicatedSends: number
  /** Average attempts per notification. */
  averageAttemptsPerNotification: number
}

/**
 * Configuration for notification delivery.
 */
export interface DeliveryOptions {
  /** Maximum retry attempts (default: 3). */
  maxRetries?: number
  /** Maximum provider attempts across retries/failovers. */
  maxAttempts?: number
  /** Initial retry delay in ms (default: 1000). */
  initialDelay?: number
  /** Backoff multiplier (default: 2). */
  backoffMultiplier?: number
  /** Jitter factor applied to retry delays (default: 0.2). */
  jitterFactor?: number
  /** Request timeout in ms (default: 5000). */
  timeout?: number
  /** Email provider to use (default: 'sendgrid'). */
  provider?: string
}

/**
 * Interface for email provider implementations.
 */
export interface EmailProvider {
  /** Provider name. */
  name: string
  /** Send email and return provider response ID. */
  send(
    notification: EmailNotification,
    options?: {
      timeout?: number
      idempotencyKey?: string
      attemptNumber?: number
    }
  ): Promise<{ id: string; statusCode: number }>
}

/**
 * Health snapshot for a notification provider.
 */
export interface NotificationProviderHealth {
  /** Provider name. */
  provider: string
  /** Consecutive transient failures observed for this provider. */
  consecutiveFailures: number
  /** Timestamp until which the provider is considered unhealthy. */
  unhealthyUntil?: Date
}

/**
 * Delivery attempt captured in the notification DLQ.
 */
export interface NotificationDlqAttempt {
  /** Provider name used for this attempt. */
  provider: string
  /** 1-based attempt number. */
  attemptNumber: number
  /** Idempotency key used for the provider call. */
  idempotencyKey: string
  /** Error message from the provider. */
  error: string
  /** Optional status code extracted from the failure. */
  statusCode?: number
  /** Whether the failure was considered transient. */
  transient: boolean
  /** Whether the result may still complete out-of-band. */
  ambiguous: boolean
}

/**
 * Dead-letter entry for exhausted notification delivery.
 */
export interface NotificationDlqEntry {
  /** DLQ entry identifier. */
  id: string
  /** Notification that could not be safely delivered. */
  notification: EmailNotification
  /** Ordered providers considered for this delivery. */
  providers: string[]
  /** Recorded attempts made before DLQ. */
  attempts: NotificationDlqAttempt[]
  /** Final failure reason. */
  failureReason: string
  /** Timestamp when the message entered the DLQ. */
  failedAt: string
}

/**
 * Store for notification DLQ entries.
 */
export interface NotificationDlqStore {
  /** Push a failed notification into the DLQ. */
  push(entry: NotificationDlqEntry): Promise<void>
  /** List DLQ entries. */
  list(): Promise<NotificationDlqEntry[]>
}

/**
 * Store for notification state (attempts and send markers).
 */
export interface NotificationStore {
  /** Record a new send attempt. */
  createSendAttempt(attempt: Omit<SendAttempt, 'id'>): Promise<SendAttempt>
  /** Get the last send attempt for a notification (if any). */
  getLastSendAttempt(notificationId: string): Promise<SendAttempt | null>
  /** Get all send attempts for a notification. */
  getSendAttempts(notificationId: string): Promise<SendAttempt[]>
  /** Update send attempt status. */
  updateSendAttempt(
    attemptId: string,
    updates: Partial<Pick<SendAttempt, 'status' | 'sentAt' | 'providerResponseId' | 'errorMessage'>>
  ): Promise<void>
  /** Get metrics for notification delivery. */
  getMetrics(): Promise<NotificationMetrics>
  /** Check if a send was already completed for an idempotency key. */
  getSendByIdempotencyKey(idempotencyKey: string): Promise<SendAttempt | null>
}
