import { randomUUID } from 'crypto'
import * as promClient from 'prom-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildNotificationDeliveryJobKey,
  type AsyncJob,
  type IdempotentJobResult,
} from '../../jobs/notificationIdempotency.js'
import { IdempotentEmailDeliveryService } from './delivery.js'
import { MemoryNotificationDlqStore } from './dlq.js'
import { NotificationProviderHealthTracker } from './health.js'
import { MockEmailProvider } from './providers.js'
import {
  _resetNotificationPromMetricsForTests,
} from './promMetrics.js'
import { createNotificationService } from './service.js'
import type {
  EmailNotification,
  NotificationDlqEntry,
  NotificationMetrics,
  NotificationStore,
  SendAttempt,
} from './types.js'

class MockNotificationStore implements NotificationStore {
  private readonly attempts = new Map<string, SendAttempt>()
  private readonly attemptsByKey = new Map<string, SendAttempt>()
  private readonly jobAttempts = new Map<
    string,
    {
      status: 'pending' | 'completed' | 'failed'
      result: string | null
    }
  >()

  async createSendAttempt(attempt: Omit<SendAttempt, 'id'>): Promise<SendAttempt> {
    const existing = this.attemptsByKey.get(attempt.idempotencyKey)
    if (existing) {
      return existing
    }

    const record: SendAttempt = {
      ...attempt,
      id: randomUUID(),
    }
    this.attempts.set(record.id, record)
    this.attemptsByKey.set(record.idempotencyKey, record)
    return record
  }

  async getLastSendAttempt(notificationId: string): Promise<SendAttempt | null> {
    return (
      Array.from(this.attempts.values())
        .filter(attempt => attempt.notificationId === notificationId)
        .sort((left, right) => right.attemptNumber - left.attemptNumber)[0] ?? null
    )
  }

  async getSendAttempts(notificationId: string): Promise<SendAttempt[]> {
    return Array.from(this.attempts.values())
      .filter(attempt => attempt.notificationId === notificationId)
      .sort((left, right) => left.attemptNumber - right.attemptNumber)
  }

  async updateSendAttempt(
    attemptId: string,
    updates: Partial<Pick<SendAttempt, 'status' | 'sentAt' | 'providerResponseId' | 'errorMessage'>>
  ): Promise<void> {
    const existing = this.attempts.get(attemptId)
    if (!existing) {
      return
    }

    Object.assign(existing, updates)
  }

  async getMetrics(): Promise<NotificationMetrics> {
    const attempts = Array.from(this.attempts.values())
    return {
      totalAttempts: attempts.length,
      successfulSends: attempts.filter(attempt => attempt.status === 'sent').length,
      failedSends: attempts.filter(attempt => attempt.status === 'failed').length,
      deduplicatedSends: attempts.filter(attempt => attempt.status === 'deduped').length,
      averageAttemptsPerNotification:
        attempts.length > 0
          ? attempts.length / new Set(attempts.map(attempt => attempt.notificationId)).size
          : 0,
    }
  }

  async getSendByIdempotencyKey(idempotencyKey: string): Promise<SendAttempt | null> {
    return this.attemptsByKey.get(idempotencyKey) ?? null
  }

  async executeIdempotentJob<T>(
    jobKey: string,
    _jobType: string,
    job: AsyncJob<T>
  ): Promise<IdempotentJobResult<T>> {
    const existing = this.jobAttempts.get(jobKey)

    if (existing?.status === 'completed') {
      return {
        alreadyProcessed: true,
        result: existing.result ? (JSON.parse(existing.result) as T) : null,
        attempt: null,
      }
    }

    if (existing?.status === 'pending') {
      throw new Error(`Duplicate job execution detected: job ${jobKey} is already pending`)
    }

    this.jobAttempts.set(jobKey, {
      status: 'pending',
      result: null,
    })

    try {
      const result = await job.run()
      this.jobAttempts.set(jobKey, {
        status: 'completed',
        result: JSON.stringify(result),
      })
      return {
        alreadyProcessed: false,
        result,
        attempt: null,
      }
    } catch (error) {
      this.jobAttempts.set(jobKey, {
        status: 'failed',
        result: error instanceof Error ? error.message : 'Unknown error',
      })
      throw error
    }
  }
}

describe('Notifications failover', () => {
  let store: MockNotificationStore
  let dlqStore: MemoryNotificationDlqStore
  let healthTracker: NotificationProviderHealthTracker

  const notification: EmailNotification = {
    id: 'notification-470',
    recipients: [{ email: 'user@example.com', name: 'Alert User' }],
    subject: 'Critical alert',
    body: '<p>Important alert</p>',
    contentType: 'text/html',
  }

  beforeEach(() => {
    promClient.register.clear()
    _resetNotificationPromMetricsForTests()
    store = new MockNotificationStore()
    dlqStore = new MemoryNotificationDlqStore()
    healthTracker = new NotificationProviderHealthTracker(60_000)
  })

  afterEach(() => {
    promClient.register.clear()
    _resetNotificationPromMetricsForTests()
  })

  it('fails over from a down primary provider to the secondary provider', async () => {
    const primary = new MockEmailProvider('primary')
    const secondary = new MockEmailProvider('secondary')

    primary.send = vi.fn(async () => {
      throw new Error('HTTP 503 Service Unavailable')
    })

    const service = new IdempotentEmailDeliveryService(
      store,
      [primary, secondary],
      {
        dlqStore,
        healthTracker,
        sleep: vi.fn().mockResolvedValue(undefined),
        random: () => 0,
      }
    )

    const result = await service.deliver(notification, {
      maxAttempts: 2,
      initialDelay: 10,
      jitterFactor: 0,
    })

    expect(result.success).toBe(true)
    expect(result.provider).toBe('secondary')
    expect(result.attempts).toBe(2)
    expect(primary.send).toHaveBeenCalledTimes(1)
    expect(secondary.getSendCount()).toBe(1)

    const attempts = await store.getSendAttempts(notification.id)
    expect(attempts).toHaveLength(2)
    expect(attempts[0].provider).toBe('primary')
    expect(attempts[0].status).toBe('failed')
    expect(attempts[1].provider).toBe('secondary')
    expect(attempts[1].status).toBe('sent')

    const metrics = await promClient.register.getMetricsAsJSON()
    const failoverMetric = metrics.find(metric => metric.name === 'notification_failovers_total')
    expect(failoverMetric?.values[0]?.labels).toEqual({
      from_provider: 'primary',
      to_provider: 'secondary',
    })
  })

  it('routes exhausted notifications to the DLQ when all providers are down', async () => {
    const primary = new MockEmailProvider('primary')
    const secondary = new MockEmailProvider('secondary')

    primary.send = vi.fn(async () => {
      throw new Error('HTTP 503 Service Unavailable')
    })
    secondary.send = vi.fn(async () => {
      throw new Error('HTTP 502 Bad Gateway')
    })

    const service = new IdempotentEmailDeliveryService(
      store,
      [primary, secondary],
      {
        dlqStore,
        healthTracker,
        sleep: vi.fn().mockResolvedValue(undefined),
        random: () => 0,
      }
    )

    const result = await service.deliver(
      { ...notification, id: 'notification-470-dlq' },
      {
        maxAttempts: 2,
        initialDelay: 10,
        jitterFactor: 0,
      }
    )

    expect(result.success).toBe(false)
    expect(result.provider).toBe('secondary')

    const entries = await dlqStore.list()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject<Partial<NotificationDlqEntry>>({
      failureReason: 'HTTP 502 Bad Gateway',
      providers: ['primary', 'secondary'],
    })
    expect(entries[0].attempts).toHaveLength(2)

    const metrics = await promClient.register.getMetricsAsJSON()
    const dlqMetric = metrics.find(metric => metric.name === 'notification_dlq_total')
    expect(dlqMetric?.values[0]?.value).toBe(1)
  })

  it('deduplicates retries so failover does not double-send', async () => {
    const primary = new MockEmailProvider('primary')
    const secondary = new MockEmailProvider('secondary')

    primary.send = vi.fn(async () => {
      throw new Error('HTTP 503 Service Unavailable')
    })

    const service = new IdempotentEmailDeliveryService(
      store,
      [primary, secondary],
      {
        dlqStore,
        healthTracker,
        sleep: vi.fn().mockResolvedValue(undefined),
        random: () => 0,
      }
    )

    const firstResult = await service.deliver(
      { ...notification, id: 'notification-470-dedup' },
      {
        maxAttempts: 2,
        initialDelay: 10,
        jitterFactor: 0,
      }
    )
    const secondResult = await service.deliver(
      { ...notification, id: 'notification-470-dedup' },
      {
        maxAttempts: 2,
        initialDelay: 10,
        jitterFactor: 0,
      }
    )

    expect(firstResult.success).toBe(true)
    expect(secondResult.success).toBe(true)
    expect(secondResult.deduped).toBe(true)
    expect(secondary.getSendCount()).toBe(1)
    expect(primary.send).toHaveBeenCalledTimes(1)

    const attempts = await store.getSendAttempts('notification-470-dedup')
    expect(attempts).toHaveLength(2)
    expect(buildNotificationDeliveryJobKey('notification-470-dedup')).toContain(
      'notification_delivery'
    )
  })

  it('tracks provider health so unhealthy providers are deprioritized on later sends', async () => {
    const primary = new MockEmailProvider('primary')
    const secondary = new MockEmailProvider('secondary')

    primary.send = vi
      .fn()
      .mockRejectedValueOnce(new Error('HTTP 503 Service Unavailable'))
      .mockResolvedValue({ id: 'primary-recovered', statusCode: 200 })
    secondary.send = vi.fn(async () => ({ id: 'secondary-msg', statusCode: 200 }))

    const service = createNotificationService(
      store as NotificationStore,
      new Map([
        ['primary', primary],
        ['secondary', secondary],
      ]),
      'primary'
    )

    const first = await service.send(
      { ...notification, id: 'notification-health-1' },
      { maxAttempts: 2, initialDelay: 10, jitterFactor: 0 }
    )
    const second = await service.send(
      { ...notification, id: 'notification-health-2' },
      { maxAttempts: 1, initialDelay: 10, jitterFactor: 0 }
    )

    expect(first.success).toBe(true)
    expect(first.provider).toBe('secondary')
    expect(second.success).toBe(true)
    expect(second.provider).toBe('secondary')
    expect(primary.send).toHaveBeenCalledTimes(1)
    expect(secondary.send).toHaveBeenCalledTimes(2)
  })
})
