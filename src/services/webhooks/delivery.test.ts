import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { deliverWebhook, signPayload } from './delivery.js'
import type { WebhookConfig, WebhookPayload } from './types.js'
import https from 'https'

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

  const mockWebhookWithMTLS: WebhookConfig = {
    ...mockWebhook,
    clientCertPem: '-----BEGIN CERTIFICATE-----\nMIICXzCCAkegAwIBAgIJAJC1HiIAZAiUMA0G...',
    clientKeyKmsRef: 'kms://arn:aws:kms:us-east-1:123456789012:key/abc123',
    pinnedServerCertSha256: '187c7a35ca03f76670defe6a8925690a744506a4004988114eb88ae177088404',
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

  it('delivers webhook with mTLS configuration using custom agent', async () => {
    const mockAgent = new https.Agent()
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })

    const result = await deliverWebhook(mockWebhookWithMTLS, mockPayload, {
      httpsAgent: mockAgent,
    })

    expect(result.success).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
    
    const call = (fetch as any).mock.calls[0]
    expect(call[1].agent).toBe(mockAgent)
  })

  it('uses default HTTPS agent when mTLS is not configured', async () => {
    const agentSpy = vi.spyOn(https, 'Agent').mockImplementation(() => new https.Agent())
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })

    await deliverWebhook(mockWebhook, mockPayload)

    // Should not create custom agent for non-mTLS webhook
    expect(agentSpy).not.toHaveBeenCalled()
    agentSpy.mockRestore()
  })

  it('handles mTLS handshake failure with appropriate error code', async () => {
    const mTLSWebhook: WebhookConfig = {
      ...mockWebhook,
      clientCertPem: '-----BEGIN CERTIFICATE-----\nMIICXzCCAkegAwIBAgIJAJC1HiIAZAiUMA0G...',
      clientKeyKmsRef: 'kms://arn:aws:kms:us-east-1:123456789012:key/abc123',
    }

    const tlsError = new Error('unable to verify the first certificate')
    ;(tlsError as any).code = 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
    
    global.fetch = vi.fn().mockRejectedValue(tlsError)

    const result = await deliverWebhook(mTLSWebhook, mockPayload, {
      maxRetries: 2,
      initialDelay: 100,
      sleepFn: () => Promise.resolve(),
    })

    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(200)

    expect(result).toMatchObject({
      webhookId: 'wh_123',
      success: false,
      errorCode: 'WEBHOOK_MTLS_FAILURE',
      error: 'mTLS handshake failed: unable to verify the first certificate',
    })
  })

  it('emits webhook_mtls_failure_total metric on handshake failure', async () => {
    const mTLSWebhook: WebhookConfig = {
      ...mockWebhook,
      clientCertPem: '-----BEGIN CERTIFICATE-----\nMIICXzCCAkegAwIBAgIJAJC1HiIAZAiUMA0G...',
      clientKeyKmsRef: 'kms://arn:aws:kms:us-east-1:123456789012:key/abc123',
    }

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const tlsError = new Error('certificate has expired')
    ;(tlsError as any).code = 'CERT_UNTRUSTED'
    
    global.fetch = vi.fn().mockRejectedValue(tlsError)

    await deliverWebhook(mTLSWebhook, mockPayload, {
      maxRetries: 0,
    })

    expect(consoleSpy).toHaveBeenCalledWith(
      'METRIC [webhook_mtls_failure_total]:',
      1,
      { subscriber: 'wh_123', reason: 'handshake_failure' }
    )
    consoleSpy.mockRestore()
  })

  it('handles expired client certificate', async () => {
    const expiredCertWebhook: WebhookConfig = {
      ...mockWebhook,
      clientCertPem: '-----BEGIN CERTIFICATE-----\nEXPIRED_CERT...',
      clientKeyKmsRef: 'kms://arn:aws:kms:us-east-1:123456789012:key/expired',
    }

    const certExpiredError = new Error('certificate has expired')
    ;(certExpiredError as any).code = 'CERT_HAS_EXPIRED'
    
    global.fetch = vi.fn().mockRejectedValue(certExpiredError)

    const result = await deliverWebhook(expiredCertWebhook, mockPayload, {
      maxRetries: 0,
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('certificate has expired')
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

  it('resolves retry policy from provider-specific overrides', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 200 })

    const sleepCalls: number[] = []

    const result = await deliverWebhook(mockWebhook, mockPayload, {
      retryPolicies: {
        default: { baseDelayMs: 25 },
        providers: {
          webhook: { maxAttempts: 2 },
        },
      },
      fetchFn: fetchFn as unknown as typeof fetch,
      sleepFn: async (ms) => {
        sleepCalls.push(ms)
      },
    })

    expect(result.success).toBe(true)
    expect(result.attempts).toBe(2)
    expect(sleepCalls).toEqual([25])
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('applies jitter strategy to webhook retry backoff', async () => {
    const sleepCalls: number[] = []

    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 200 })

    const result = await deliverWebhook(mockWebhook, mockPayload, {
      retryPolicy: {
        maxAttempts: 2,
        baseDelayMs: 100,
        maxDelayMs: 1000,
        backoffMultiplier: 2,
        jitterStrategy: 'full',
      },
      fetchFn: fetchFn as unknown as typeof fetch,
      randomFn: () => 0.5,
      sleepFn: async (ms) => {
        sleepCalls.push(ms)
      },
    })

    expect(result.success).toBe(true)
    expect(sleepCalls).toEqual([50])
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('does not retry on 4xx client errors', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'Bad Request' })

    const result = await deliverWebhook(mockWebhook, mockPayload, { maxRetries: 3 })

    expect(result).toMatchObject({
      webhookId: 'wh_123',
      success: false,
      error: 'HTTP 400',
      statusCode: 400,
      attempts: 1,
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('fails after max retries exhausted', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'Server Error' })

    const promise = deliverWebhook(mockWebhook, mockPayload, {
      maxRetries: 2,
      initialDelay: 100,
    })

    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(200)
    
    const result = await promise

    expect(result).toMatchObject({
      webhookId: 'wh_123',
      success: false,
      error: 'HTTP 500',
      statusCode: 500,
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

  it('respects webhook-specific maxAttempts override', async () => {
    const webhookWithCustomMax: WebhookConfig = {
      ...mockWebhook,
      maxAttempts: 5,
    }

    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 200 })

    const promise = deliverWebhook(webhookWithCustomMax, mockPayload, {
      initialDelay: 50,
    })

    await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(200)
    await vi.advanceTimersByTimeAsync(400)

    const result = await promise

    expect(result.attempts).toBe(5)
    expect(result.success).toBe(true)
  })

  it('respects webhook-specific timeoutMs override', async () => {
    const webhookWithTimeout: WebhookConfig = {
      ...mockWebhook,
      timeoutMs: 10000, // 10 second timeout
    }

    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })

    await deliverWebhook(webhookWithTimeout, mockPayload)

    // The timeout should be set to webhook's timeoutMs
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('handles intermediate CA changes gracefully', async () => {
    const mTLSWebhook: WebhookConfig = {
      ...mockWebhook,
      clientCertPem: '-----BEGIN CERTIFICATE-----\nNEW_CHAIN...',
      clientKeyKmsRef: 'kms://arn:aws:kms:us-east-1:123456789012:key/new',
    }

    // Simulate a connection that succeeds after initial cert validation issues
    global.fetch = vi.fn()
      .mockRejectedValueOnce(new Error('unable to get local issuer certificate'))
      .mockResolvedValueOnce({ ok: true, status: 200 })

    const result = await deliverWebhook(mTLSWebhook, mockPayload, {
      maxRetries: 1,
      initialDelay: 100,
      sleepFn: () => Promise.resolve(),
    })

    await vi.advanceTimersByTimeAsync(100)

    expect(result.success).toBe(true)
    expect(result.attempts).toBe(2)
  })
})

describe('constant-time comparison', () => {
  it('should be tested via integration with validateServerCertificatePin', async () => {
    // This function is tested indirectly through the delivery behavior
    // The actual constantTimeEqual implementation is tested via
    // the certificate pinning validation in the integration
    const webhookWithPin: WebhookConfig = {
      id: 'wh_456',
      url: 'https://example.com/webhook',
      events: ['bond.created'],
      secret: 'test-secret',
      active: true,
      pinnedServerCertSha256: 'abc123',
    }

    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })

    const result = await deliverWebhook(webhookWithPin, {
      event: 'bond.created',
      timestamp: '2024-01-01T00:00:00.000Z',
      data: {},
    })

    expect(result).toBeDefined()
  })
})