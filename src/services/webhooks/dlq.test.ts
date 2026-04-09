import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebhookService } from './service.js'
import { MemoryDlqStore, buildDlqEntry } from './dlq.js'
import { MemoryWebhookStore } from './memoryStore.js'
import type { WebhookConfig, WebhookPayload } from './types.js'

const mockWebhook: WebhookConfig = {
  id: 'wh_test',
  url: 'https://example.com/hook',
  events: ['bond.created'],
  secret: 'secret',
  active: true,
}

const mockPayload: WebhookPayload = {
  event: 'bond.created',
  timestamp: '2026-01-01T00:00:00.000Z',
  data: { address: 'GABC', bondedAmount: '100', bondStart: 1000, bondDuration: 86400, active: true },
}

describe('MemoryDlqStore', () => {
  it('stores and retrieves entries', async () => {
    const store = new MemoryDlqStore()
    const entry = buildDlqEntry(
      { webhookId: 'wh_1', success: false, attempts: 3, error: 'HTTP 500', statusCode: 500, responseBodySnippet: 'err' },
      mockPayload
    )
    await store.push(entry)
    expect(await store.get(entry.id)).toMatchObject({ webhookId: 'wh_1', attempts: 3 })
    expect(await store.list()).toHaveLength(1)
  })

  it('marks entry as replayed', async () => {
    const store = new MemoryDlqStore()
    const entry = buildDlqEntry(
      { webhookId: 'wh_1', success: false, attempts: 3 },
      mockPayload
    )
    await store.push(entry)
    await store.markReplayed(entry.id, '2026-01-02T00:00:00.000Z')
    const updated = await store.get(entry.id)
    expect(updated?.replayedAt).toBe('2026-01-02T00:00:00.000Z')
  })

  it('returns null for unknown id', async () => {
    const store = new MemoryDlqStore()
    expect(await store.get('nonexistent')).toBeNull()
  })
})

describe('buildDlqEntry', () => {
  it('preserves failure metadata', () => {
    const entry = buildDlqEntry(
      { webhookId: 'wh_1', success: false, attempts: 4, error: 'HTTP 503', statusCode: 503, responseBodySnippet: 'Service Unavailable' },
      mockPayload
    )
    expect(entry.webhookId).toBe('wh_1')
    expect(entry.attempts).toBe(4)
    expect(entry.lastStatusCode).toBe(503)
    expect(entry.lastError).toBe('HTTP 503')
    expect(entry.responseBodySnippet).toBe('Service Unavailable')
    expect(entry.payload.event).toBe('bond.created')
    expect(entry.id).toBeTruthy()
    expect(entry.failedAt).toBeTruthy()
  })

  it('does not expose secret in stored payload', () => {
    const entry = buildDlqEntry(
      { webhookId: 'wh_1', success: false, attempts: 1 },
      mockPayload
    )
    // Payload should not contain any secret field
    expect(JSON.stringify(entry.payload)).not.toContain('secret')
  })
})

describe('WebhookService DLQ integration', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('pushes to DLQ after retry exhaustion', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'Internal Server Error' })

    const webhookStore = new MemoryWebhookStore()
    await webhookStore.set(mockWebhook)

    const dlq = new MemoryDlqStore()
    const service = new WebhookService(webhookStore, { maxRetries: 1, initialDelay: 10 }, dlq)

    const emitPromise = service.emit('bond.created', mockPayload.data)
    await vi.runAllTimersAsync()
    const results = await emitPromise

    expect(results[0].success).toBe(false)
    const entries = await dlq.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].webhookId).toBe('wh_test')
    expect(entries[0].attempts).toBeGreaterThanOrEqual(1)
    expect(entries[0].lastStatusCode).toBe(500)
  })

  it('does not push to DLQ on successful delivery', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })

    const webhookStore = new MemoryWebhookStore()
    await webhookStore.set(mockWebhook)

    const dlq = new MemoryDlqStore()
    const service = new WebhookService(webhookStore, {}, dlq)

    const results = await service.emit('bond.created', mockPayload.data)

    expect(results[0].success).toBe(true)
    expect(await dlq.list()).toHaveLength(0)
  })

  it('works without a DLQ configured', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => '' })

    const webhookStore = new MemoryWebhookStore()
    await webhookStore.set(mockWebhook)

    const service = new WebhookService(webhookStore, { maxRetries: 0 })

    const emitPromise = service.emit('bond.created', mockPayload.data)
    await vi.runAllTimersAsync()
    const results = await emitPromise

    expect(results[0].success).toBe(false)
    // No error thrown — DLQ is optional
  })
})
