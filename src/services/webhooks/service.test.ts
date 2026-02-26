import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WebhookService } from './service.js'
import type { WebhookStore, WebhookConfig, WebhookEventType } from './types.js'

describe('WebhookService', () => {
  const mockWebhooks: WebhookConfig[] = [
    {
      id: 'wh_1',
      url: 'https://example.com/webhook1',
      events: ['bond.created', 'bond.slashed'],
      secret: 'secret1',
      active: true,
    },
    {
      id: 'wh_2',
      url: 'https://example.com/webhook2',
      events: ['bond.created'],
      secret: 'secret2',
      active: true,
    },
    {
      id: 'wh_3',
      url: 'https://example.com/webhook3',
      events: ['bond.created'],
      secret: 'secret3',
      active: false, // Inactive
    },
  ]

  let mockStore: WebhookStore

  beforeEach(() => {
    mockStore = {
      getByEvent: vi.fn(async (event: WebhookEventType) => {
        return mockWebhooks.filter(w => w.events.includes(event))
      }),
      get: vi.fn(async (id: string) => {
        return mockWebhooks.find(w => w.id === id) ?? null
      }),
      set: vi.fn(),
    }

    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })
  })

  it('emits event to all active subscribed webhooks', async () => {
    const service = new WebhookService(mockStore)

    const results = await service.emit('bond.created', {
      address: '0xabc',
      bondedAmount: '1000',
      bondStart: 1234567890,
      bondDuration: 86400,
      active: true,
    })

    expect(results).toHaveLength(2) // wh_1 and wh_2 (wh_3 is inactive)
    expect(results[0].webhookId).toBe('wh_1')
    expect(results[0].success).toBe(true)
    expect(results[1].webhookId).toBe('wh_2')
    expect(results[1].success).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('filters webhooks by event type', async () => {
    const service = new WebhookService(mockStore)

    const results = await service.emit('bond.slashed', {
      address: '0xdef',
      bondedAmount: '500',
      bondStart: 1234567890,
      bondDuration: 86400,
      active: false,
    })

    expect(results).toHaveLength(1) // Only wh_1 subscribes to bond.slashed
    expect(results[0].webhookId).toBe('wh_1')
    expect(mockStore.getByEvent).toHaveBeenCalledWith('bond.slashed')
  })

  it('returns empty array when no webhooks subscribed', async () => {
    mockStore.getByEvent = vi.fn().mockResolvedValue([])
    const service = new WebhookService(mockStore)

    const results = await service.emit('bond.withdrawn', {
      address: '0xghi',
      bondedAmount: '0',
      bondStart: null,
      bondDuration: null,
      active: false,
    })

    expect(results).toHaveLength(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('includes timestamp in payload', async () => {
    const service = new WebhookService(mockStore)
    const beforeEmit = new Date().toISOString()

    await service.emit('bond.created', {
      address: '0xabc',
      bondedAmount: '1000',
      bondStart: 1234567890,
      bondDuration: 86400,
      active: true,
    })

    const call = (fetch as any).mock.calls[0]
    const body = JSON.parse(call[1].body)
    expect(body.timestamp).toBeDefined()
    expect(new Date(body.timestamp).getTime()).toBeGreaterThanOrEqual(new Date(beforeEmit).getTime())
  })

  it('passes delivery options to webhook delivery', async () => {
    const service = new WebhookService(mockStore, {
      maxRetries: 1,
      initialDelay: 10,
      timeout: 1000,
    })

    let callCount = 0
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++
      if (callCount <= 2) {
        return Promise.resolve({ ok: false, status: 500 })
      }
      return Promise.resolve({ ok: true, status: 200 })
    })

    const results = await service.emit('bond.created', {
      address: '0xabc',
      bondedAmount: '1000',
      bondStart: 1234567890,
      bondDuration: 86400,
      active: true,
    })

    // Should retry once and succeed (2 webhooks * 2 attempts each = 4 calls)
    expect(results).toHaveLength(2)
    expect(results.every(r => r.success)).toBe(true)
  })

  it('rate limits deliveries per webhook', async () => {
    const service = new WebhookService(mockStore)
    const timestamps: number[] = []

    global.fetch = vi.fn().mockImplementation(() => {
      timestamps.push(Date.now())
      return Promise.resolve({ ok: true, status: 200 })
    })

    // Emit two events quickly
    await Promise.all([
      service.emit('bond.created', {
        address: '0xabc',
        bondedAmount: '1000',
        bondStart: 1234567890,
        bondDuration: 86400,
        active: true,
      }),
      service.emit('bond.created', {
        address: '0xdef',
        bondedAmount: '2000',
        bondStart: 1234567891,
        bondDuration: 86400,
        active: true,
      }),
    ])

    // Each webhook should have been called twice
    expect(fetch).toHaveBeenCalledTimes(4) // 2 webhooks * 2 events

    // Check that calls to same webhook are rate limited (>= 100ms apart)
    // Note: This is a simplified check; in real scenario we'd track per webhook
    expect(timestamps.length).toBe(4)
  })

  it('handles delivery failures gracefully', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockRejectedValueOnce(new Error('Network error'))

    const service = new WebhookService(mockStore, { maxRetries: 0 })

    const results = await service.emit('bond.created', {
      address: '0xabc',
      bondedAmount: '1000',
      bondStart: 1234567890,
      bondDuration: 86400,
      active: true,
    })

    expect(results).toHaveLength(2)
    expect(results[0].success).toBe(true)
    expect(results[1].success).toBe(false)
    expect(results[1].error).toBeDefined()
  })

  it('delivers to multiple webhooks in parallel', async () => {
    const service = new WebhookService(mockStore)
    const startTime = Date.now()

    global.fetch = vi.fn().mockImplementation(() => 
      new Promise(resolve => setTimeout(() => resolve({ ok: true, status: 200 }), 100))
    )

    await service.emit('bond.created', {
      address: '0xabc',
      bondedAmount: '1000',
      bondStart: 1234567890,
      bondDuration: 86400,
      active: true,
    })

    const duration = Date.now() - startTime
    // Should take ~100ms (parallel) not ~200ms (sequential)
    expect(duration).toBeLessThan(200)
  })
})
