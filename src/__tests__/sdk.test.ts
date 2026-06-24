import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CredenceClient } from '../sdk/client.js'
import {
  CredenceError,
  ForbiddenCredenceError,
  InternalServerErrorCredenceError,
  NotFoundCredenceError,
  SdkInvalidJsonCredenceError,
  SdkNetworkErrorCredenceError,
  SdkRequestTimeoutCredenceError,
  SdkUnmappedHttpCredenceError,
} from '../sdk/errors.generated.js'

function mockFetch(body: unknown, init?: { status?: number; statusText?: string; headers?: Record<string, string> }) {
  const status = init?.status ?? 200
  const statusText = init?.statusText ?? 'OK'
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response)
}

describe('CredenceClient', () => {
  const baseUrl = 'http://localhost:3000'
  let client: CredenceClient

  beforeEach(() => {
    client = new CredenceClient({ baseUrl })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('constructor', () => {
    it('throws when baseUrl is empty', () => {
      expect(() => new CredenceClient({ baseUrl: '' })).toThrow('baseUrl is required')
    })

    it('strips trailing slashes from baseUrl', () => {
      const c = new CredenceClient({ baseUrl: 'http://localhost:3000///' })
      expect((c as unknown as { baseUrl: string }).baseUrl).toBe('http://localhost:3000')
    })

    it('accepts optional apiKey and timeout', () => {
      const c = new CredenceClient({ baseUrl, apiKey: 'test-key', timeout: 5000 })
      expect(c).toBeInstanceOf(CredenceClient)
    })
  })

  describe('getTrustScore', () => {
    it('returns trust score data for an address', async () => {
      const payload = {
        address: '0xabc',
        score: 85,
        bondedAmount: '1000',
        bondStart: '2025-01-01T00:00:00Z',
        attestationCount: 3,
      }
      vi.stubGlobal('fetch', mockFetch(payload))

      const result = await client.getTrustScore('0xabc')
      expect(result).toEqual(payload)
      expect(fetch).toHaveBeenCalledOnce()

      const call = vi.mocked(fetch).mock.calls[0]
      expect(call[0]).toBe('http://localhost:3000/api/trust/0xabc')
    })

    it('encodes the address in the URL', async () => {
      vi.stubGlobal('fetch', mockFetch({ address: '0x a&b', score: 0, bondedAmount: '0', bondStart: null, attestationCount: 0 }))

      await client.getTrustScore('0x a&b')

      const call = vi.mocked(fetch).mock.calls[0]
      expect(call[0]).toBe('http://localhost:3000/api/trust/0x%20a%26b')
    })
  })

  describe('getBondStatus', () => {
    it('returns bond status for an address', async () => {
      const payload = {
        address: '0xdef',
        bondedAmount: '500',
        bondStart: '2025-06-01T00:00:00Z',
        bondDuration: '365',
        active: true,
      }
      vi.stubGlobal('fetch', mockFetch(payload))

      const result = await client.getBondStatus('0xdef')
      expect(result).toEqual(payload)

      const call = vi.mocked(fetch).mock.calls[0]
      expect(call[0]).toBe('http://localhost:3000/api/bond/0xdef')
    })
  })

  describe('getAttestations', () => {
    it('returns attestations for an address', async () => {
      const payload = {
        address: '0x123',
        attestations: [
          { id: '1', attester: '0xaaa', subject: '0x123', value: 'trusted', timestamp: '2025-01-01T00:00:00Z' },
        ],
        count: 1,
      }
      vi.stubGlobal('fetch', mockFetch(payload))

      const result = await client.getAttestations('0x123')
      expect(result).toEqual(payload)

      const call = vi.mocked(fetch).mock.calls[0]
      expect(call[0]).toBe('http://localhost:3000/api/attestations/0x123')
    })

    it('returns empty attestations list', async () => {
      const payload = { address: '0x456', attestations: [], count: 0 }
      vi.stubGlobal('fetch', mockFetch(payload))

      const result = await client.getAttestations('0x456')
      expect(result.attestations).toEqual([])
      expect(result.count).toBe(0)
    })
  })

  describe('getVerificationProof', () => {
    it('returns verification proof for an address', async () => {
      const payload = {
        address: '0x789',
        proof: '0xdeadbeef',
        verified: true,
        timestamp: '2025-02-01T00:00:00Z',
      }
      vi.stubGlobal('fetch', mockFetch(payload))

      const result = await client.getVerificationProof('0x789')
      expect(result).toEqual(payload)

      const call = vi.mocked(fetch).mock.calls[0]
      expect(call[0]).toBe('http://localhost:3000/api/verification/0x789')
    })

    it('returns null proof when address is not verified', async () => {
      const payload = { address: '0xnone', proof: null, verified: false, timestamp: null }
      vi.stubGlobal('fetch', mockFetch(payload))

      const result = await client.getVerificationProof('0xnone')
      expect(result.verified).toBe(false)
      expect(result.proof).toBeNull()
    })
  })

  describe('API key handling', () => {
    it('sends Authorization header when apiKey is set', async () => {
      const authedClient = new CredenceClient({ baseUrl, apiKey: 'my-secret-key' })
      vi.stubGlobal('fetch', mockFetch({ address: '0x1', score: 0, bondedAmount: '0', bondStart: null, attestationCount: 0 }))

      await authedClient.getTrustScore('0x1')

      const call = vi.mocked(fetch).mock.calls[0]
      const opts = call[1] as RequestInit
      expect((opts.headers as Record<string, string>).Authorization).toBe('Bearer my-secret-key')
    })

    it('omits Authorization header when apiKey is not set', async () => {
      vi.stubGlobal('fetch', mockFetch({ address: '0x1', score: 0, bondedAmount: '0', bondStart: null, attestationCount: 0 }))

      await client.getTrustScore('0x1')

      const call = vi.mocked(fetch).mock.calls[0]
      const opts = call[1] as RequestInit
      expect((opts.headers as Record<string, string>).Authorization).toBeUndefined()
    })
  })

  describe('error handling', () => {
    it('throws NotFoundCredenceError for structured 404 envelopes', async () => {
      vi.stubGlobal(
        'fetch',
        mockFetch({ error: 'Identity not found', code: 'not_found' }, { status: 404, statusText: 'Not Found' }),
      )

      await expect(client.getTrustScore('0xbad')).rejects.toThrow(NotFoundCredenceError)
      try {
        await client.getTrustScore('0xbad')
      } catch (err) {
        expect(err).toBeInstanceOf(CredenceError)
        const credenceErr = err as NotFoundCredenceError
        expect(credenceErr.code).toBe('not_found')
        expect(credenceErr.status).toBe(404)
        expect(credenceErr.message).toBe('Identity not found')
      }
    })

    it('throws InternalServerErrorCredenceError for structured 500 envelopes', async () => {
      vi.stubGlobal(
        'fetch',
        mockFetch(
          { error: 'Unexpected failure', code: 'internal_server_error' },
          { status: 500, statusText: 'Internal Server Error' },
        ),
      )

      try {
        await client.getBondStatus('0xfail')
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(InternalServerErrorCredenceError)
        const credenceErr = err as InternalServerErrorCredenceError
        expect(credenceErr.status).toBe(500)
        expect(credenceErr.code).toBe('internal_server_error')
      }
    })

    it('throws SdkUnmappedHttpCredenceError for unstructured HTTP errors', async () => {
      vi.stubGlobal('fetch', mockFetch('Not Found', { status: 404, statusText: 'Not Found' }))

      await expect(client.getTrustScore('0xbad')).rejects.toThrow(SdkUnmappedHttpCredenceError)
      await expect(client.getTrustScore('0xbad')).rejects.toThrow('HTTP 404: Not Found')
    })

    it('throws SdkInvalidJsonCredenceError on invalid JSON response', async () => {
      vi.stubGlobal('fetch', mockFetch('this is not json'))

      await expect(client.getAttestations('0x1')).rejects.toThrow(SdkInvalidJsonCredenceError)
      await expect(client.getAttestations('0x1')).rejects.toThrow('Invalid JSON response')
    })

    it('throws SdkNetworkErrorCredenceError on network error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))

      await expect(client.getTrustScore('0x1')).rejects.toThrow(SdkNetworkErrorCredenceError)
      await expect(client.getTrustScore('0x1')).rejects.toThrow('Network error: fetch failed')
    })

    it('throws SdkRequestTimeoutCredenceError on timeout (AbortError)', async () => {
      const abortError = new DOMException('The operation was aborted', 'AbortError')
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError))

      await expect(client.getVerificationProof('0x1')).rejects.toThrow(SdkRequestTimeoutCredenceError)
      await expect(client.getVerificationProof('0x1')).rejects.toThrow('Request timed out')
    })

    it('throws SdkRequestTimeoutCredenceError on timeout (Error with AbortError name)', async () => {
      const abortError = new Error('The operation was aborted')
      abortError.name = 'AbortError'
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError))

      await expect(client.getVerificationProof('0x1')).rejects.toThrow('Request timed out')
    })

    it('maps structured forbidden envelopes to ForbiddenCredenceError', async () => {
      vi.stubGlobal(
        'fetch',
        mockFetch({ error: 'Forbidden access', code: 'forbidden' }, { status: 403, statusText: 'Forbidden' }),
      )

      try {
        await client.getTrustScore('0x1')
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenCredenceError)
        const credenceErr = err as ForbiddenCredenceError
        expect(credenceErr.code).toBe('forbidden')
        expect(credenceErr.status).toBe(403)
        expect(credenceErr.rawBody).toContain('forbidden')
      }
    })

    it('maps structured rate-limit envelopes from getAttestations', async () => {
      vi.stubGlobal(
        'fetch',
        mockFetch(
          { error: 'Rate limit exceeded. Try again later.', code: 'rate_limit_exceeded', details: { retryAfter: 30 } },
          { status: 429, statusText: 'Too Many Requests' },
        ),
      )

      try {
        await client.getAttestations('0x1')
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toMatchObject({
          code: 'rate_limit_exceeded',
          status: 429,
          details: { retryAfter: 30 },
        })
      }
    })

    it('maps structured not-found envelopes from getVerificationProof', async () => {
      vi.stubGlobal(
        'fetch',
        mockFetch({ error: 'Proof not found', code: 'not_found' }, { status: 404, statusText: 'Not Found' }),
      )

      await expect(client.getVerificationProof('0x1')).rejects.toMatchObject({
        code: 'not_found',
        status: 404,
        message: 'Proof not found',
      })
    })

    it('throws SdkRequestTimeoutCredenceError when the configured timeout elapses', async () => {
      vi.useFakeTimers()
      const slowClient = new CredenceClient({ baseUrl, timeout: 1_000 })
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted', 'AbortError'))
            })
          }),
        ),
      )

      const pending = expect(slowClient.getTrustScore('0x1')).rejects.toThrow(SdkRequestTimeoutCredenceError)
      await vi.advanceTimersByTimeAsync(1_000)
      await pending
      vi.useRealTimers()
    })

    it('handles non-Error thrown values during fetch', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue('string error'))

      await expect(client.getTrustScore('0x1')).rejects.toThrow('Network error: string error')
    })
  })
})
