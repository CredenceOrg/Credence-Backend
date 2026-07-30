import type { NotificationDeliveryResult, NotificationMetrics } from './types.js'

/**
 * Event emitted when a notification is delivered.
 */
export interface DeliveryMetricsEvent {
  type: 'delivery' | 'deduplication' | 'failure'
  notificationId: string
  result: NotificationDeliveryResult
  timestamp: Date
}

/**
 * Callback for metrics events.
 */
export type MetricsCallback = (event: DeliveryMetricsEvent) => void | Promise<void>

/**
 * In-memory metrics collector and event emitter.
 * Tracks notification delivery metrics including deduplication.
 */
export class NotificationMetricsCollector {
  private listeners: MetricsCallback[] = []
  private attemptCounts = new Map<string, number>()
  private successfulNotifications = new Set<string>()
  private failedNotifications = new Set<string>()
  private deduplicatedCount = 0

  /**
   * Register a metrics event listener.
   */
  on(callback: MetricsCallback): () => void {
    this.listeners.push(callback)
    // Return unsubscribe function
    return () => {
      this.listeners = this.listeners.filter(l => l !== callback)
    }
  }

  /**
   * Record a delivery result and emit metrics events.
   */
  async recordDelivery(result: NotificationDeliveryResult): Promise<void> {
    const { notificationId, success, deduped, attempts } = result

    // Track attempt count
    this.attemptCounts.set(notificationId, attempts)

    // Track success/failure
    if (success) {
      this.successfulNotifications.add(notificationId)
      this.failedNotifications.delete(notificationId)
    } else {
      this.failedNotifications.add(notificationId)
      this.successfulNotifications.delete(notificationId)
    }

    // Emit appropriate event
    const eventType = deduped ? 'deduplication' : success ? 'delivery' : 'failure'
    if (deduped && !this.deduplicatedCount) {
      // Only count first dedup per notification ID to avoid double counting
      this.deduplicatedCount++
    } else if (deduped) {
      this.deduplicatedCount++
    }

    const event: DeliveryMetricsEvent = {
      type: eventType,
      notificationId,
      result,
      timestamp: new Date(),
    }

    // Emit to all listeners
    await Promise.all(this.listeners.map(listener => listener(event)))
  }

  /**
   * Get current metrics snapshot.
   */
  getMetrics(): NotificationMetrics {
    const totalNotifications = this.attemptCounts.size
    const totalAttempts = Array.from(this.attemptCounts.values()).reduce(
      (sum, count) => sum + count,
      0
    )

    return {
      totalAttempts,
      successfulSends: this.successfulNotifications.size,
      failedSends: this.failedNotifications.size,
      deduplicatedSends: this.deduplicatedCount,
      averageAttemptsPerNotification:
        totalNotifications > 0 ? totalAttempts / totalNotifications : 0,
    }
  }

  /**
   * Reset all metrics.
   */
  reset(): void {
    this.attemptCounts.clear()
    this.successfulNotifications.clear()
    this.failedNotifications.clear()
    this.deduplicatedCount = 0
    this.listeners = []
  }
}

/**
 * Prometheus-compatible metrics exporter.
 * Converts NotificationMetrics to Prometheus format.
 */
export function metricsToPrometheus(metrics: NotificationMetrics): string {
  const lines = [
    `# HELP notification_delivery_attempts_total Total number of notification delivery attempts`,
    `# TYPE notification_delivery_attempts_total counter`,
    `notification_delivery_attempts_total ${metrics.totalAttempts}`,
    ``,
    `# HELP notification_delivery_successful_total Successfully delivered notifications`,
    `# TYPE notification_delivery_successful_total counter`,
    `notification_delivery_successful_total ${metrics.successfulSends}`,
    ``,
    `# HELP notification_delivery_failed_total Failed notification deliveries`,
    `# TYPE notification_delivery_failed_total counter`,
    `notification_delivery_failed_total ${metrics.failedSends}`,
    ``,
    `# HELP notification_delivery_deduped_total Deduplicated notification sends (prevented by idempotency)`,
    `# TYPE notification_delivery_deduped_total counter`,
    `notification_delivery_deduped_total ${metrics.deduplicatedSends}`,
    ``,
    `# HELP notification_delivery_attempts_average Average number of attempts per notification`,
    `# TYPE notification_delivery_attempts_average gauge`,
    `notification_delivery_attempts_average ${metrics.averageAttemptsPerNotification}`,
  ]

  return lines.join('\n')
}

/**
 * Format metrics for human-readable output.
 */
export function metricsToString(metrics: NotificationMetrics): string {
  return `
Notification Delivery Metrics
------------------------------
Total Attempts:          ${metrics.totalAttempts}
Successful Sends:        ${metrics.successfulSends}
Failed Sends:            ${metrics.failedSends}
Deduplicated Sends:      ${metrics.deduplicatedSends} (prevented duplicate sends)
Avg Attempts/Notif:      ${metrics.averageAttemptsPerNotification.toFixed(2)}
`.trim()
}
