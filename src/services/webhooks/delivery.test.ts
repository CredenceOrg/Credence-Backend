import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { deliverWebhook, signPayload } from './delivery.js'
import type { WebhookConfig, WebhookPayload } from './types.js'

describe('signPayload', () => {
  it('generates consistent HMAC-SHA256 signature', () => {
    const payload = '{"event":"bond.created","data":{}}'
    const secret = 'test-secret'
    const sig1 = signPayload(payload, secret)
    const sig2 = signPayload(payload, secret)
    expect(sig1).toBe(sig2)
    expect(sig1).toHaveLength(64) // SHA256 hex = 64 chars
  })

  it('generates different signatures for different secrets', () => {
    const payload = '{"event":"bond.created"}'
    const sig1 = signPayload(payload, 'secret1')
    const sig2 = signPayload(payload, 'secret2')
    expect(sig1).not.toBe(sig2)
  })

  it('generates different signatures for different payloads', () => {
    const secret = 'test-secret'
    const sig1 = signPayload('{"event":"bond.created"}', secret)
    const sig2 = signPayload('{"event":"bond.slashed"}', secret)
    expect(sig1).not.toBe(sig2)
  })
})

describe('deliverWebhook', () => {
  const mockWebhook: WebhookConfig = {
    id: 'wh_123',
    url: 'https://example.com/webhook',
    events: ['bond.created'],
    secret: 'test-secret',
    active: true,
  }

  const mockPayload: WebhookPayload = {
    event: 'bond.created',
    timestamp: '2024-01-01T00:00:00.000Z',
    data: {
      address: '0xabc',
      bondedAmount: '1000',
      bondStart: 1234567890,
      bondDuration: 86400,
      active: true,
    },
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('delivers webhook successfully on first attempt', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    })

    const result = await deliverWebhook(mockWebhook, mockPayload)

    expect(result).toEqual({
      webhookId: 'wh_123',
      success: true,
      statusCode: 200,
      attempts: 1,
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(
      mockWebhook.url,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Webhook-Signature': expect.any(String),
          'X-Webhook-Event': 'bond.created',
        }),
        body: JSON.stringify(mockPayload),
      })
    )
  })

  it('includes correct HMAC signature in headers', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })

    await deliverWebhook(mockWebhook, mockPayload)

    const call = (fetch as any).mock.calls[0]
    const headers = call[1].headers
    const expectedSig = signPayload(JSON.stringify(mockPayload), mockWebhook.secret)
    expect(headers['X-Webhook-Signature']).toBe(expectedSig)
  })

  it('retries on 5xx errors with exponential backoff', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 })

    const promise = deliverWebhook(mockWebhook, mockPayload, {
      maxRetries: 3,
      initialDelay: 1000,
      backoffMultiplier: 2,
    })

    // Fast-forward through retries
    await vi.advanceTimersByTimeAsync(1000) // First retry after 1s
    await vi.advanceTimersByTimeAsync(2000) // Second retry after 2s
    
    const result = await promise

    expect(result).toEqual({
      webhookId: 'wh_123',
      success: true,
      statusCode: 200,
      attempts: 3,
    })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('does not retry on 4xx client errors', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 400 })

    const result = await deliverWebhook(mockWebhook, mockPayload, { maxRetries: 3 })

    expect(result).toEqual({
      webhookId: 'wh_123',
      success: false,
      error: 'HTTP 400',
      attempts: 1,
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('fails after max retries exhausted', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 })

    const promise = deliverWebhook(mockWebhook, mockPayload, {
      maxRetries: 2,
      initialDelay: 100,
    })

    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(200)
    
    const result = await promise

    expect(result).toEqual({
      webhookId: 'wh_123',
      success: false,
      error: 'HTTP 500',
      attempts: 3, // Initial + 2 retries
    })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('handles network errors with retry', async () => {
    global.fetch = vi.fn()
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({ ok: true, status: 200 })

    const promise = deliverWebhook(mockWebhook, mockPayload, {
      maxRetries: 1,
      initialDelay: 100,
    })

    await vi.advanceTimersByTimeAsync(100)
    
    const result = await promise

    expect(result).toEqual({
      webhookId: 'wh_123',
      success: true,
      statusCode: 200,
      attempts: 2,
    })
  })

  it('uses default options when not provided', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })

    const result = await deliverWebhook(mockWebhook, mockPayload)

    expect(result.success).toBe(true)
    expect(result.attempts).toBe(1)
  })
})
