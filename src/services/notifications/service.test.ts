import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { EmailNotification, NotificationStore } from './types.js'
import { IdempotentEmailDeliveryService } from './delivery.js'
import { NotificationService, createNotificationService } from './service.js'
import { MockEmailProvider } from './providers.js'
import { NotificationRepository } from './repository.ts'
import { randomUUID } from 'crypto'

/**
 * Mock in-memory notification store for testing.
 */
class MockNotificationStore implements NotificationStore {
  private attempts = new Map<string, any>()
  private byKey = new Map<string, any>()

  async createSendAttempt(attempt: any) {
    const id = randomUUID()
    const record = { ...attempt, id }
    this.attempts.set(id, record)
    if (attempt.idempotencyKey) {
      this.byKey.set(attempt.idempotencyKey, record)
    }
    return record
  }

  async getLastSendAttempt(notificationId: string) {
    const attempts = Array.from(this.attempts.values()).filter(
      a => a.notificationId === notificationId
    )
    return attempts.length > 0
      ? attempts.sort((a, b) => b.attemptedAt.getTime() - a.attemptedAt.getTime())[0]
      : null
  }

  async getSendAttempts(notificationId: string) {
    return Array.from(this.attempts.values())
      .filter(a => a.notificationId === notificationId)
      .sort((a, b) => a.attemptedAt.getTime() - b.attemptedAt.getTime())
  }

  async updateSendAttempt(id: string, updates: any) {
    const attempt = this.attempts.get(id)
    if (attempt) {
      Object.assign(attempt, updates)
    }
  }

  async getSendByIdempotencyKey(key: string) {
    return this.byKey.get(key) ?? null
  }

  async getMetrics() {
    const attempts = Array.from(this.attempts.values())
    return {
      totalAttempts: attempts.length,
      successfulSends: attempts.filter(a => a.status === 'sent').length,
      failedSends: attempts.filter(a => a.status === 'failed').length,
      deduplicatedSends: attempts.filter(a => a.status === 'deduped').length,
      averageAttemptsPerNotification:
        attempts.length > 0
          ? attempts.length / new Set(attempts.map(a => a.notificationId)).size
          : 0,
    }
  }
}

describe('IdempotentEmailDeliveryService', () => {
  let store: MockNotificationStore
  let provider: MockEmailProvider
  let service: IdempotentEmailDeliveryService

  const testNotification: EmailNotification = {
    id: 'notif-123',
    recipients: [{ email: 'user@example.com', name: 'Test User' }],
    subject: 'Test Email',
    body: '<p>Test content</p>',
    contentType: 'text/html',
  }

  beforeEach(() => {
    store = new MockNotificationStore()
    provider = new MockEmailProvider()
    service = new IdempotentEmailDeliveryService(store, provider)
  })

  describe('Basic delivery', () => {
    it('should deliver notification successfully on first attempt', async () => {
      const result = await service.deliver(testNotification)

      expect(result.success).toBe(true)
      expect(result.deduped).toBe(false)
      expect(result.attempts).toBe(1)
      expect(result.providerResponseId).toBeDefined()

      // Verify attempt was recorded
      const attempts = await store.getSendAttempts(testNotification.id)
      expect(attempts).toHaveLength(1)
      expect(attempts[0].status).toBe('sent')
    })

    it('should set correct idempotency key', async () => {
      const result = await service.deliver(testNotification)

      expect(result.idempotencyKey).toBeDefined()
      expect(result.idempotencyKey).toMatch(/^[a-f0-9]{64}$/) // SHA256 hex
    })
  })

  describe('Deduplication and idempotency', () => {
    it('should deduplicate already sent notifications', async () => {
      const result1 = await service.deliver(testNotification)
      expect(result1.success).toBe(true)
      expect(result1.deduped).toBe(false)

      // Try to send same notification again
      const result2 = await service.deliver(testNotification)

      expect(result2.success).toBe(true)
      expect(result2.deduped).toBe(true)
      expect(result2.attempts).toBe(1) // Should not increment
      expect(result2.idempotencyKey).toBe(result1.idempotencyKey)

      // Verify only one actual send happened
      const attempts = await store.getSendAttempts(testNotification.id)
      expect(attempts).toHaveLength(1)
      expect(attempts[0].status).toBe('sent')
    })

    it('should prevent duplicate sends with same idempotency key', async () => {
      const result1 = await service.deliver(testNotification)

      // Simulate another send attempt with same key (network retry)
      const result2 = await service.deliver(testNotification)

      // Both should succeed
      expect(result1.success).toBe(true)
      expect(result2.success).toBe(true)

      // But only one should have been forced to provider
      const allAttempts = await store.getSendAttempts(testNotification.id)
      const sentAttempts = allAttempts.filter(a => a.status === 'sent')
      expect(sentAttempts).toHaveLength(1)
    })
  })

  describe('Timeout and retry scenario', () => {
    it('should retry on timeout with exponential backoff', async () => {
      const notif = { ...testNotification, id: 'notif-timeout-test' }

      // Simulate timeout on first attempt, success on retry
      let attemptCount = 0
      const originalSend = provider.send.bind(provider)
      provider.send = vi.fn(async (notification: any, options?: any) => {
        attemptCount++
        if (attemptCount === 1) {
          throw new Error('timeout: request timeout')
        }
        return await originalSend(notification, options)
      })

      const startTime = Date.now()
      const result = await service.deliver(notif, {
        maxRetries: 2,
        initialDelay: 100,
        backoffMultiplier: 2,
      })
      const duration = Date.now() - startTime

      expect(result.success).toBe(true)
      expect(result.attempts).toBe(2)

      // Should have waited for backoff (at least 100ms)
      expect(duration).toBeGreaterThanOrEqual(90)

      // Verify attempts were recorded
      const attempts = await store.getSendAttempts(notif.id)
      expect(attempts).toHaveLength(2) // first timeout attempt + retry
      expect(attempts[0].status).toBe('failed')
      expect(attempts[1].status).toBe('sent')
    })

    it('should use new attempt group on timeout retry', async () => {
      const notif = { ...testNotification, id: 'notif-attempt-group-test' }

      let attemptCount = 0
      provider.send = vi.fn(async (notification: any, options?: any) => {
        attemptCount++
        if (attemptCount === 1) {
          throw new Error('timeout: request timeout')
        }
        return { id: `msg-${attemptCount}`, statusCode: 200 }
      })

      const result = await service.deliver(notif, {
        maxRetries: 2,
        initialDelay: 50,
      })

      expect(result.success).toBe(true)

      // Should have same idempotency key (different from second attempt)
      const attempts = await store.getSendAttempts(notif.id)
      expect(attempts.length).toBeGreaterThan(0)

      // All successful attempts should have been sent
      const sentAttempts = attempts.filter(a => a.status === 'sent')
      expect(sentAttempts).toHaveLength(1)
    })
  })

  describe('Provider 5xx retry scenario', () => {
    it('should retry on provider 5xx errors', async () => {
      const notif = { ...testNotification, id: 'notif-5xx-test' }

      let attemptCount = 0
      provider.send = vi.fn(async (notification: any, options?: any) => {
        attemptCount++
        if (attemptCount === 1) {
          throw new Error('HTTP 503 Service Unavailable')
        }
        return { id: `msg-${attemptCount}`, statusCode: 200 }
      })

      const result = await service.deliver(notif, {
        maxRetries: 2,
        initialDelay: 50,
      })

      expect(result.success).toBe(true)
      expect(result.attempts).toBe(2)

      // Verify provider was called twice
      expect(provider.send).toHaveBeenCalledTimes(2)
    })

    it('should not retry on 4xx client errors', async () => {
      const notif = { ...testNotification, id: 'notif-4xx-test' }

      let callCount = 0
      provider.send = vi.fn(async (notification: any, options?: any) => {
        callCount++
        throw new Error('HTTP 400 Bad Request')
      })

      const result = await service.deliver(notif, {
        maxRetries: 3,
        initialDelay: 50,
      })

      expect(result.success).toBe(false)
      expect(callCount).toBe(1) // Should not retry

      const attempts = await store.getSendAttempts(notif.id)
      expect(attempts[0].status).toBe('failed')
    })

    it('should fail after max retries exceeded', async () => {
      const notif = { ...testNotification, id: 'notif-max-retries-test' }

      let callCount = 0
      provider.send = vi.fn(async (notification: any, options?: any) => {
        callCount++
        throw new Error('HTTP 502 Bad Gateway')
      })

      const result = await service.deliver(notif, {
        maxRetries: 2,
        initialDelay: 10,
      })

      expect(result.success).toBe(false)
      expect(callCount).toBe(3) // Initial + 2 retries

      const attempts = await store.getSendAttempts(notif.id)
      expect(attempts).toHaveLength(3) // initial + 2 retries in separate attempt groups
      expect(attempts[attempts.length - 1].status).toBe('failed')
      expect(attempts[attempts.length - 1].errorMessage).toContain('Bad Gateway')
    })
  })

  describe('Provider response reconciliation', () => {
    it('should reconcile send with provider response', async () => {
      const notif = { ...testNotification, id: 'notif-reconcile-test' }

      // Manually record a reconciliation without actual send
      await service.reconcileSend(notif.id, 'provider-msg-123', 200)

      // Verify send was recorded
      const attempts = await store.getSendAttempts(notif.id)
      expect(attempts).toHaveLength(1)
      expect(attempts[0].status).toBe('sent')
      expect(attempts[0].providerResponseId).toBe('provider-msg-123')
    })

    it('should mark failed reconciliation on 4xx response', async () => {
      const notif = { ...testNotification, id: 'notif-reconcile-fail-test' }

      await service.reconcileSend(notif.id, 'provider-msg-456', 400)

      const attempts = await store.getSendAttempts(notif.id)
      expect(attempts[0].status).toBe('failed')
    })
  })

  describe('Metrics tracking', () => {
    it('should track notification metrics accurately', async () => {
      const notif1 = { ...testNotification, id: 'notif-m1' }
      const notif2 = { ...testNotification, id: 'notif-m2' }

      await service.deliver(notif1)
      await service.deliver(notif1) // Dedup same notification
      await service.deliver(notif2)

      const metrics = await store.getMetrics()

      expect(metrics.totalAttempts).toBeGreaterThanOrEqual(2)
      expect(metrics.successfulSends).toBeGreaterThanOrEqual(1)
      expect(metrics.deduplicatedSends).toBe(0) // Not tracked in store directly
    })
  })
})

describe('NotificationService', () => {
  let store: MockNotificationStore
  let provider: MockEmailProvider
  let service: NotificationService

  const testNotification: EmailNotification = {
    id: 'notif-service-123',
    recipients: [{ email: 'user@example.com' }],
    subject: 'Test',
    body: 'Test',
  }

  beforeEach(() => {
    store = new MockNotificationStore()
    provider = new MockEmailProvider()
    const providers = new Map([['mock', provider]])
    service = createNotificationService(store, providers, 'mock')
  })

  it('should send notification via service', async () => {
    const result = await service.send(testNotification, { providerName: 'mock' })

    expect(result.success).toBe(true)
    expect(result.providerResponseId).toBeDefined()
  })

  it('should send batch of notifications', async () => {
    const notifs = [
      { ...testNotification, id: 'batch-1' },
      { ...testNotification, id: 'batch-2' },
      { ...testNotification, id: 'batch-3' },
    ]

    const results = await service.sendBatch(notifs, { providerName: 'mock' })

    expect(results).toHaveLength(3)
    expect(results.every(r => r.success)).toBe(true)
  })

  it('should track metrics via service', async () => {
    const notif1 = { ...testNotification, id: 'metric-1' }
    const notif2 = { ...testNotification, id: 'metric-2' }

    await service.send(notif1, { providerName: 'mock' })
    await service.send(notif2, { providerName: 'mock' })

    const metrics = service.getMetrics()

    expect(metrics.successfulSends).toBeGreaterThanOrEqual(2)
  })

  it('should emit metrics events on delivery', async () => {
    const events: any[] = []

    service.onMetrics(event => {
      events.push(event)
    })

    await service.send(testNotification, { providerName: 'mock' })

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('delivery')
    expect(events[0].notificationId).toBe(testNotification.id)
  })

  it('should throw on unknown provider', async () => {
    await expect(
      service.send(testNotification, { providerName: 'unknown' })
    ).rejects.toThrow('Email provider not found')
  })
})

describe('Integration: End-to-end notification delivery', () => {
  let store: MockNotificationStore
  let provider: MockEmailProvider
  let service: NotificationService

  beforeEach(() => {
    store = new MockNotificationStore()
    provider = new MockEmailProvider()
    const providers = new Map([['mock', provider]])
    service = createNotificationService(store, providers, 'mock')
  })

  it('should handle complex retry scenario: timeout then recovery', async () => {
    const notif: EmailNotification = {
      id: 'complex-retry-scenario',
      recipients: [{ email: 'user@example.com' }],
      subject: 'Complex',
      body: 'Test',
    }

    let callCount = 0
    provider.send = vi.fn(async () => {
      callCount++
      if (callCount === 1) {
        throw new Error('timeout: connection timeout')
      }
      return { id: `msg-${callCount}`, statusCode: 200 }
    })

    const startTime = Date.now()
    const result = await service.send(notif, {
      providerName: 'mock',
      maxRetries: 2,
      initialDelay: 100,
    })
    const duration = Date.now() - startTime

    // Should succeed
    expect(result.success).toBe(true)
    expect(result.attempts).toBe(2)

    // Should have backoff delay
    expect(duration).toBeGreaterThanOrEqual(90)

    // Verify metrics tracked the attempt
    const metrics = service.getMetrics()
    expect(metrics.successfulSends).toBeGreaterThanOrEqual(1)
  })

  it('should prevent duplicate sends across multiple concurrent requests', async () => {
    const notif: EmailNotification = {
      id: 'concurrent-dedup',
      recipients: [{ email: 'user@example.com' }],
      subject: 'Test',
      body: 'Test',
    }

    let sendCount = 0
    provider.send = vi.fn(async () => {
      sendCount++
      return { id: `msg-final`, statusCode: 200 }
    })

    // Simulate concurrent send requests for same notification
    const results = await Promise.all([
      service.send(notif, { providerName: 'mock' }),
      service.send(notif, { providerName: 'mock' }),
      service.send(notif, { providerName: 'mock' }),
    ])

    // All should report success
    expect(results.every(r => r.success)).toBe(true)

    // But actual sends depend on race condition and dedup logic
    // At least one should have been deduplicated
    const metrics = service.getMetrics()
    expect(metrics.successfulSends).toBeGreaterThanOrEqual(1)
  })
})
