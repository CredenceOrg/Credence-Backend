import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fc from 'fast-check'
import {
  SorobanClient,
  SorobanClientError,
  createSorobanClient,
  encodeEventCursor,
  decodeEventCursor,
  DEFAULT_EVENTS_PAGE_LIMIT,
  MAX_EVENTS_PAGE_LIMIT,
  SOROBAN_EVENT_CURSOR_VERSION,
} from '../soroban.js'
import { resetCircuitBreakers } from '../circuitBreaker.js'
import { TimeoutExceededError } from '../../lib/timeoutExecutor.js'

describe('SorobanClient - Retry, Timeout, and Circuit Breaker', () => {
  beforeEach(() => {
    resetCircuitBreakers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('config validation', () => {
    it('rejects empty rpcUrl', () => {
      expect(() => {
        new SorobanClient({
          rpcUrl: '',
          network: 'testnet',
          contractId: 'CTEST',
        })
      }).toThrow(SorobanClientError)
    })

    it('rejects whitespace-only rpcUrl', () => {
      expect(() => {
        new SorobanClient({
          rpcUrl: '   ',
          network: 'testnet',
          contractId: 'CTEST',
        })
      }).toThrow(SorobanClientError)
    })

    it('rejects empty contractId', () => {
      expect(() => {
        new SorobanClient({
          rpcUrl: 'https://soroban-testnet.stellar.org',
          network: 'testnet',
          contractId: '',
        })
      }).toThrow(SorobanClientError)
    })

    it('rejects whitespace-only contractId', () => {
      expect(() => {
        new SorobanClient({
          rpcUrl: 'https://soroban-testnet.stellar.org',
          network: 'testnet',
          contractId: '  ',
        })
      }).toThrow(SorobanClientError)
    })

    it('rejects invalid network', () => {
      expect(() => {
        new SorobanClient({
          rpcUrl: 'https://soroban-testnet.stellar.org',
          network: 'invalid' as any,
          contractId: 'CTEST',
        })
      }).toThrow(SorobanClientError)
    })

    it('accepts valid testnet config', () => {
      const client = new SorobanClient({
        rpcUrl: 'https://soroban-testnet.stellar.org',
        network: 'testnet',
        contractId: 'CTEST',
      })
      expect(client).toBeDefined()
    })

    it('accepts valid mainnet config', () => {
      const client = new SorobanClient({
        rpcUrl: 'https://soroban-mainnet.stellar.org',
        network: 'mainnet',
        contractId: 'CMAIN',
      })
      expect(client).toBeDefined()
    })
  })

  describe('transient error handling and retry', () => {
    it('retries transient error and succeeds on second attempt', async () => {
      vi.useFakeTimers()

      const sleepFn = vi.fn((ms: number) => {
        vi.advanceTimersByTime(ms)
        return Promise.resolve()
      })

      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 'getIdentityState-1',
              result: { state: 'active' },
            }),
            { status: 200 }
          )
        )

      const client = new SorobanClient(
        {
          rpcUrl: 'https://soroban-testnet.stellar.org',
          network: 'testnet',
          contractId: 'CTEST',
          retry: {
            maxAttempts: 3,
            baseDelayMs: 100,
            maxDelayMs: 1000,
            backoffMultiplier: 2,
            jitterStrategy: 'none',
          },
        },
        { fetchFn: fetchMock, sleepFn }
      )

      const result = await client.getIdentityState('GAAddress')
      expect(result).toEqual({ state: 'active' })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(sleepFn).toHaveBeenCalledWith(100)
    })

    it('retries on 503 Service Unavailable', async () => {
      vi.useFakeTimers()

      const sleepFn = vi.fn((ms: number) => {
        vi.advanceTimersByTime(ms)
        return Promise.resolve()
      })

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 503 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 'getContractEvents-1',
              result: { events: [], latestCursor: null },
            }),
            { status: 200 }
          )
        )

      const client = new SorobanClient(
        {
          rpcUrl: 'https://soroban-testnet.stellar.org',
          network: 'testnet',
          contractId: 'CTEST',
        },
        { fetchFn: fetchMock, sleepFn }
      )

      const result = await client.getContractEvents()
      expect(result.events).toEqual([])
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('retries on 429 Too Many Requests', async () => {
      vi.useFakeTimers()

      const sleepFn = vi.fn((ms: number) => {
        vi.advanceTimersByTime(ms)
        return Promise.resolve()
      })

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 429 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 'getIdentityState-1',
              result: { state: 'verified' },
            }),
            { status: 200 }
          )
        )

      const client = new SorobanClient(
        {
          rpcUrl: 'https://soroban-testnet.stellar.org',
          network: 'testnet',
          contractId: 'CTEST',
        },
        { fetchFn: fetchMock, sleepFn }
      )

      const result = await client.getIdentityState('GAAddress')
      expect(result).toEqual({ state: 'verified' })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('respects exponential backoff', async () => {
      vi.useFakeTimers()

      const sleepFn = vi.fn((ms: number) => {
        vi.advanceTimersByTime(ms)
        return Promise.resolve()
      })

      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 'getIdentityState-1',
              result: { state: 'active' },
            }),
            { status: 200 }
          )
        )

      const client = new SorobanClient(
        {
          rpcUrl: 'https://soroban-testnet.stellar.org',
          network: 'testnet',
          contractId: 'CTEST',
          retry: {
            maxAttempts: 3,
            baseDelayMs: 100,
            maxDelayMs: 5000,
            backoffMultiplier: 2,
            jitterStrategy: 'none',
          },
        },
        { fetchFn: fetchMock, sleepFn }
      )

      const result = await client.getIdentityState('GAAddress')
      expect(result).toEqual({ state: 'active' })
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(sleepFn).toHaveBeenCalledTimes(2)
      expect(sleepFn).toHaveBeenNthCalledWith(1, 100) // first backoff
      expect(sleepFn).toHaveBeenNthCalledWith(2, 200) // second backoff
    })
  })

  describe('permanent error handling (no retry)', () => {
    it('does not retry on 400 Bad Request', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 400 }))

      const client = new SorobanClient(
        {
          rpcUrl: 'https://soroban-testnet.stellar.org',
          network: 'testnet',
          contractId: 'CTEST',
        },
        { fetchFn: fetchMock }
      )

      await expect(client.getIdentityState('GAAddress')).rejects.toThrow(
        SorobanClientError
      )
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('does not retry on 401 Unauthorized', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 401 }))

      const client = new SorobanClient(
        {
          rpcUrl: 'https://soroban-testnet.stellar.org',
          network: 'testnet',
          contractId: 'CTEST',
        },
        { fetchFn: fetchMock }
      )

      await expect(client.getIdentityState('GAAddress')).rejects.toThrow(
        SorobanClientError
      )
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('does not retry on non-transient RPC errors', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 'getIdentityState-1',
              error: { code: -32600, message: 'Invalid Request' },
            }),
            { status: 200 }
          )
        )

      const client = new SorobanClient(
        {
          rpcUrl: 'https://soroban-testnet.stellar.org',
          network: 'testnet',
          contractId: 'CTEST',
        },
        { fetchFn: fetchMock }
      )

      await expect(client.getIdentityState('GAAddress')).rejects.toThrow(
        SorobanClientError
      )
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('retries on transient RPC error -32004', async () => {
      vi.useFakeTimers()

      const sleepFn = vi.fn((ms: number) => {
        vi.advanceTimersByTime(ms)
        return Promise.resolve()
      })

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 'getIdentityState-1',
              error: { code: -32004, message: 'Transaction not found' },
            }),
            { status: 200 }
          )
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 'getIdentityState-2',
              result: { state: 'active' },
            }),
            { status: 200 }
          )
        )

      const client = new SorobanClient(
        {
          rpcUrl: 'https://soroban-testnet.stellar.org',
          network: 'testnet',
          contractId: 'CTEST',
        },
        { fetchFn: fetchMock, sleepFn }
      )

      const result = await client.getIdentityState('GAAddress')
      expect(result).toEqual({ state: 'active' })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('retries on transient RPC error -32005', async () => {
      vi.useFakeTimers()

      const sleepFn = vi.fn((ms: number) => {
        vi.advanceTimersByTime(ms)
        return Promise.resolve()
      })

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 'getContractEvents-1',
              error: { code: -32005, message: 'Not found' },
            }),
            { status: 200 }
          )
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 'getContractEvents-2',
              result: { events: [], latestCursor: null },
            }),
            { status: 200 }
          )
        )

      const client = new SorobanClient(
        {
          rpcUrl: 'https://soroban-testnet.stellar.org',
          network: 'testnet',
          contractId: 'CTEST',
        },
        { fetchFn: fetchMock, sleepFn }
      )

      const result = await client.getContractEvents()
      expect(result.events).toEqual([])
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('does not retry on non-transient RPC error -32001', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 'getIdentityState-1',
              error: { code: -32001, message: 'Server error' },
            }),
            { status: 200 }
          )
        )

      const client = new SorobanClient(
        {
          rpcUrl: 'https://soroban-testnet.stellar.org',
          network: 'testnet',
          contractId: 'CTEST',
        },
        { fetchFn: fetchMock }
      )

      await expect(client.getIdentityState('GAAddress')).rejects.toThrow(
        SorobanClientError
      )
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
  })

  describe('timeout handling', () => {
    it('timeout error is classified as TIMEOUT_ERROR', () => {
      const error = new SorobanClientError({
        code: 'TIMEOUT_ERROR',
        message: 'Request timed out after 1000ms',
      })

      expect(error.code).toBe('TIMEOUT_ERROR')
      expect(error.message).toContain('timed out')
    })

    it('SorobanClientError records timeout attempts', () => {
      const error = new SorobanClientError({
        code: 'TIMEOUT_ERROR',
        message: 'Request timed out',
        attempts: 3,
      })

      expect(error.attempts).toBe(3)
      expect(error.code).toBe('TIMEOUT_ERROR')
    })
  })

  describe('circuit breaker integration', () => {
    it('opens circuit breaker after failure threshold is reached', async () => {
      vi.useFakeTimers()

      const sleepFn = vi.fn((ms: number) => {
        vi.advanceTimersByTime(ms)
        return Promise.resolve()
      })

      const fetchMock = vi
        .fn()
        .mockRejectedValue(new Error('RPC unavailable'))

      const client = new SorobanClient(
        {
          rpcUrl: 'https://soroban-testnet.stellar.org',
          network: 'testnet',
          contractId: 'CTEST',
          retry: { maxAttempts: 1 },
          circuitBreaker: { failureThreshold: 2, openWindowMs: 5000, halfOpenAfterMs: 10000 },
        },
        { fetchFn: fetchMock, sleepFn }
      )

      await expect(client.getIdentityState('GAAddress1')).rejects.toThrow(
        SorobanClientError
      )

      await expect(client.getIdentityState('GAAddress2')).rejects.toThrow(
        SorobanClientError
      )

      fetchMock.mockClear()

      await expect(client.getIdentityState('GAAddress3')).rejects.toThrow(
        'circuit breaker is OPEN'
      )

      expect(fetchMock).not.toHaveBeenCalled()

      vi.useRealTimers()
    })

    it('short-circuits requests when breaker is OPEN', async () => {
      vi.useFakeTimers()

      const sleepFn = vi.fn((ms: number) => {
        vi.advanceTimersByTime(ms)
        return Promise.resolve()
      })

      const fetchMock = vi
        .fn()
        .mockRejectedValue(new Error('Network error'))

      const client = new SorobanClient(
        {
          rpcUrl: 'https://soroban-testnet.stellar.org',
          network: 'testnet',
          contractId: 'CTEST',
          retry: { maxAttempts: 1 },
          circuitBreaker: { failureThreshold: 1, openWindowMs: 5000, halfOpenAfterMs: 10000 },
        },
        { fetchFn: fetchMock, sleepFn }
      )

      await expect(client.getIdentityState('GAAddress')).rejects.toThrow()

      const error = await client.getIdentityState('GAAddress2').catch((e) => e)
      expect(error).toBeInstanceOf(SorobanClientError)
      expect(error.message).toContain('circuit breaker is OPEN')

      expect(fetchMock).toHaveBeenCalledTimes(1)

      vi.useRealTimers()
    })

    it('probes and closes circuit breaker after halfOpenAfterMs (30 s default)', async () => {
      vi.useFakeTimers()

      const sleepFn = vi.fn((ms: number) => {
        vi.advanceTimersByTime(ms)
        return Promise.resolve()
      })

      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 'getContractData-1',
              result: { state: 'recovered' },
            }),
            { status: 200 }
          )
        )

      const client = new SorobanClient(
        {
          rpcUrl: 'https://soroban-testnet.stellar.org',
          network: 'testnet',
          contractId: 'CTEST',
          retry: { maxAttempts: 1 },
          circuitBreaker: { failureThreshold: 1, openWindowMs: 10_000, halfOpenAfterMs: 30_000 },
        },
        { fetchFn: fetchMock, sleepFn }
      )

      await expect(client.getIdentityState('GAAddress')).rejects.toThrow()

      // Requests rejected during the fail-fast window (< 10 s)
      vi.advanceTimersByTime(5_000)
      const duringOpenWindow = await client.getIdentityState('GAAddress2').catch((e) => e)
      expect(duringOpenWindow.message).toContain('circuit breaker is OPEN')

      // Still OPEN between 10 s and 30 s
      vi.advanceTimersByTime(15_000)   // now 20 s elapsed
      const stillOpen = await client.getIdentityState('GAAddress3').catch((e) => e)
      expect(stillOpen.message).toContain('circuit breaker is OPEN')

      // At 30 s HALF_OPEN probe window opens
      vi.advanceTimersByTime(10_000)   // now 30 s elapsed

      const result = await client.getIdentityState('GAAddress4')
      expect(result).toEqual({ state: 'recovered' })
      expect(fetchMock).toHaveBeenCalledTimes(2)

      vi.useRealTimers()
    })

    it('reopens circuit breaker if probe fails', async () => {
      vi.useFakeTimers()

      const sleepFn = vi.fn((ms: number) => {
        vi.advanceTimersByTime(ms)
        return Promise.resolve()
      })

      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new Error('Error 1'))
        .mockRejectedValueOnce(new Error('Error 2 - probe failed'))

      const client = new SorobanClient(
        {
          rpcUrl: 'https://soroban-testnet.stellar.org',
          network: 'testnet',
          contractId: 'CTEST',
          retry: { maxAttempts: 1 },
          circuitBreaker: { failureThreshold: 1, openWindowMs: 10_000, halfOpenAfterMs: 30_000 },
        },
        { fetchFn: fetchMock, sleepFn }
      )

      await expect(client.getIdentityState('GAAddress')).rejects.toThrow()

      vi.advanceTimersByTime(30_000)

      await expect(client.getIdentityState('GAAddress2')).rejects.toThrow()

      const error = await client
        .getIdentityState('GAAddress3')
        .catch((e) => e)
      expect(error.message).toContain('circuit breaker is OPEN')

      vi.useRealTimers()
    })

    it('allows only one concurrent probe in HALF_OPEN state', async () => {
      vi.useFakeTimers()

      const sleepFn = vi.fn((ms: number) => {
        vi.advanceTimersByTime(ms)
        return Promise.resolve()
      })

      let resolveProbe: ((value: any) => void) | null = null
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new Error('Initial failure'))
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveProbe = resolve
            })
        )

      const client = new SorobanClient(
        {
          rpcUrl: 'https://soroban-testnet.stellar.org',
          network: 'testnet',
          contractId: 'CTEST',
          retry: { maxAttempts: 1 },
          circuitBreaker: { failureThreshold: 1, openWindowMs: 10_000, halfOpenAfterMs: 30_000 },
        },
        { fetchFn: fetchMock, sleepFn }
      )

      await expect(client.getIdentityState('GAAddress1')).rejects.toThrow()

      vi.advanceTimersByTime(30_000)

      const probe = client.getIdentityState('GAAddress2')

      const concurrent = client.getIdentityState('GAAddress3')
      await expect(concurrent).rejects.toThrow(SorobanClientError)

      if (resolveProbe) {
        resolveProbe(
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 'getContractData-1',
              result: { state: 'active' },
            }),
            { status: 200 }
          )
        )
      }

      const probeResult = await probe
      expect(probeResult).toEqual({ state: 'active' })

      vi.useRealTimers()
    })
  })

  describe('combined retry + timeout + circuit breaker', () => {
    it('integrates all three layers correctly', async () => {
      vi.useFakeTimers()

      const sleepFn = vi.fn((ms: number) => {
        vi.advanceTimersByTime(ms)
        return Promise.resolve()
      })

      const fetchMock = vi
        .fn()
        .mockRejectedValue(new Error('ECONNRESET'))

      const client = new SorobanClient(
        {
          rpcUrl: 'https://rpc-host.stellar.org',
          network: 'testnet',
          contractId: 'CTEST',
          timeoutMs: 5000,
          retry: {
            maxAttempts: 2,
            baseDelayMs: 200,
            maxDelayMs: 1000,
            backoffMultiplier: 2,
            jitterStrategy: 'none',
          },
          circuitBreaker: {
            failureThreshold: 2,
            openWindowMs: 10_000,
            halfOpenAfterMs: 30_000,
          },
        },
        { fetchFn: fetchMock, sleepFn }
      )

      // First call: 2 retry attempts → 1st circuit breaker failure
      await expect(client.getIdentityState('GAAddress1')).rejects.toThrow(
        SorobanClientError
      )
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(sleepFn).toHaveBeenCalledTimes(1)

      fetchMock.mockClear()

      // Second call: 2 retry attempts → 2nd circuit breaker failure → OPEN
      await expect(client.getIdentityState('GAAddress2')).rejects.toThrow(
        SorobanClientError
      )
      expect(fetchMock).toHaveBeenCalledTimes(2)

      fetchMock.mockClear()

      // Third call: breaker OPEN → fail-fast, no network
      const breakerErr = await client.getIdentityState('GAAddress3').catch((e) => e)
      expect(breakerErr.message).toContain('circuit breaker is OPEN')
      expect(fetchMock).not.toHaveBeenCalled()

      // Advance 30 s → HALF_OPEN probe window
      vi.advanceTimersByTime(30_000)

      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 'getContractData-1',
            result: { state: 'recovered' },
          }),
          { status: 200 }
        )
      )

      const recovered = await client.getIdentityState('GAAddress4')
      expect(recovered).toEqual({ state: 'recovered' })

      vi.useRealTimers()
    })
  })

  describe('resource and cancellation limits', () => {
    it('sends the configured event page limit and rejects oversized responses', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: 'getContractEvents-1',
          result: { events: [{ id: '1' }, { id: '2' }], latestCursor: 'next' },
        }), { status: 200 }),
      )
      const client = new SorobanClient({
        rpcUrl: 'https://soroban-testnet.stellar.org',
        network: 'testnet',
        contractId: 'CTEST',
        maxEventsPerPage: 1,
        retry: { maxAttempts: 1 },
      }, { fetchFn: fetchMock })

      await expect(client.getContractEvents()).rejects.toMatchObject({
        code: 'LIMIT_ERROR',
        details: { received: 2, limit: 1 },
      })
      expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).params.limit).toBe(1)
    })

    it('rejects a cancelled operation before contacting the provider', async () => {
      const controller = new AbortController()
      controller.abort()
      const fetchMock = vi.fn()
      const client = new SorobanClient({
        rpcUrl: 'https://soroban-testnet.stellar.org',
        network: 'testnet',
        contractId: 'CTEST',
        retry: { maxAttempts: 1 },
      }, { fetchFn: fetchMock, signal: controller.signal })

      await expect(client.getIdentityState('cancelled')).rejects.toMatchObject({
        code: 'LIMIT_ERROR',
      })
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe('factory function', () => {
    it('creates client successfully', () => {
      const client = createSorobanClient({
        rpcUrl: 'https://soroban-testnet.stellar.org',
        network: 'testnet',
        contractId: 'CTEST',
      })

      expect(client).toBeInstanceOf(SorobanClient)
    })

    it('factory rejects invalid config', () => {
      expect(() => {
        createSorobanClient({
          rpcUrl: '',
          network: 'testnet',
          contractId: 'CTEST',
        })
      }).toThrow(SorobanClientError)
    })
  })
})

// ════════════════════════════════════════════════════════════════════════════
// getContractEvents — deterministic pagination and cursor semantics (#1269)
// ════════════════════════════════════════════════════════════════════════════

describe('getContractEvents — pagination and cursor semantics', () => {
  let client: SorobanClient
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    resetCircuitBreakers()
    vi.clearAllMocks()
    fetchMock = vi.fn()
    client = new SorobanClient(
      {
        rpcUrl: 'https://rpc-events.stellar.org',
        network: 'testnet',
        contractId: 'CTEST',
      },
      { fetchFn: fetchMock },
    )
  })

  function mockGetEvents(result: unknown): void {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 'getEvents-1', result }),
        { status: 200 },
      ),
    )
  }

  /** Captures the `params` object sent in the last getEvents RPC body. */
  function lastGetEventsParams(): Record<string, unknown> {
    const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [
      string,
      { body: string },
    ]
    expect(url).toBe('https://rpc-events.stellar.org')
    const body = JSON.parse(init.body) as { method: string; params: unknown }
    expect(body.method).toBe('getEvents')
    return body.params as Record<string, unknown>
  }

  // ── Ordering, page limits, end-of-stream (happy path) ────────────────────

  it('requests ascending ordering and defaults to the standard page limit', async () => {
    mockGetEvents({ events: [], latestCursor: null })
    const page = await client.getContractEvents()

    const params = lastGetEventsParams()
    expect(params.order).toBe('asc')
    expect(params.limit).toBe(DEFAULT_EVENTS_PAGE_LIMIT)
    expect(params.cursor).toBeUndefined()

    expect(page.events).toEqual([])
    expect(page.cursor).toBeNull()
    expect(page.hasNextPage).toBe(false)
    expect(page.seq).toBe(1)
    expect(page.limit).toBe(DEFAULT_EVENTS_PAGE_LIMIT)
  })

  it('returns a single full page with end-of-stream when the provider has no next cursor', async () => {
    const events = [
      { id: 'e1', type: 'add' },
      { id: 'e2', type: 'add' },
    ]
    mockGetEvents({ events, latestCursor: null })

    const page = await client.getContractEvents(undefined, { limit: 2 })
    expect(page.events).toEqual(events)
    expect(page.hasNextPage).toBe(false)
    expect(page.cursor).toBeNull()
    expect(page.limit).toBe(2)
  })

  it('uses the provider cursor field when latestCursor is absent (backward compat)', async () => {
    const events = [{ id: 'e1', type: 'add' }]
    mockGetEvents({ events, cursor: 'provider-tok-1' })

    const page = await client.getContractEvents()
    expect(page.events).toEqual(events)
    expect(page.hasNextPage).toBe(true)
    expect(page.cursor).not.toBeNull()
    expect(page.cursor).not.toBe('provider-tok-1') // encoded, not raw
  })

  it('signals a next page and exposes a resumable cursor mid-stream', async () => {
    const events = [{ id: 'e1', type: 'add' }]
    mockGetEvents({ events, latestCursor: 'ledger-100-1' })

    const page = await client.getContractEvents()
    expect(page.events).toEqual(events)
    expect(page.hasNextPage).toBe(true)
    expect(page.seq).toBe(1)

    // Cursor is the deterministic, versioned encoding of the server token.
    const decoded = decodeEventCursor(page.cursor as string)
    expect(decoded).toEqual({ cursor: 'ledger-100-1', seq: 2 })
  })

  it('resumes from a returned cursor and forwards the raw server token to the RPC', async () => {
    // First page returns a next cursor.
    mockGetEvents({ events: [{ id: 'e1' }], latestCursor: 'ledger-100-1' })
    const first = await client.getContractEvents()

    // Second page consumes the encoded cursor.
    mockGetEvents({ events: [{ id: 'e2' }], latestCursor: 'ledger-200-1' })
    const second = await client.getContractEvents(first.cursor as string)

    const params = lastGetEventsParams()
    expect(params.cursor).toBe('ledger-100-1') // raw server token forwarded
    expect(second.seq).toBe(2)
    expect(second.events).toEqual([{ id: 'e2' }])
    expect(second.hasNextPage).toBe(true)

    // Third (final) page reaches end of stream.
    mockGetEvents({ events: [], latestCursor: null })
    const third = await client.getContractEvents(second.cursor as string)
    expect(third.hasNextPage).toBe(false)
    expect(third.cursor).toBeNull()
  })

  it('honours explicit page limits, including boundary values', async () => {
    mockGetEvents({ events: [{ id: 'e1' }], latestCursor: null })
    await client.getContractEvents(undefined, { limit: 1 })
    expect(lastGetEventsParams().limit).toBe(1)

    mockGetEvents({ events: [{ id: 'e1' }], latestCursor: null })
    await client.getContractEvents(undefined, { limit: MAX_EVENTS_PAGE_LIMIT })
    expect(lastGetEventsParams().limit).toBe(MAX_EVENTS_PAGE_LIMIT)
  })

  it('returns large result sets unchanged', async () => {
    const events = Array.from({ length: DEFAULT_EVENTS_PAGE_LIMIT }, (_, i) => ({
      id: `e-${i}`,
      type: 'add',
    }))
    mockGetEvents({ events, latestCursor: 'ledger-5-1' })
    const page = await client.getContractEvents()
    expect(page.events).toHaveLength(DEFAULT_EVENTS_PAGE_LIMIT)
    expect(page.hasNextPage).toBe(true)
  })

  // ── Invalid page limits are rejected before any RPC call ────────────────

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['non-integer', 2.5],
    ['NaN', Number.NaN],
    ['above max', MAX_EVENTS_PAGE_LIMIT + 1],
  ])('rejects out-of-range page limit (%s) with CONFIG_ERROR and no RPC call', async (_label, limit) => {
    await expect(
      client.getContractEvents(undefined, { limit: limit as number }),
    ).rejects.toMatchObject({ code: 'CONFIG_ERROR' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // ── Cursor encoding / decoding ──────────────────────────────────────────

  it('round-trips encode -> decode deterministically', () => {
    const token = encodeEventCursor('ledger-42-7', 3)
    const decoded = decodeEventCursor(token)
    expect(decoded).toEqual({ cursor: 'ledger-42-7', seq: 3 })
    // Deterministic: same inputs -> same token.
    expect(encodeEventCursor('ledger-42-7', 3)).toBe(token)
  })

  it('property: encode/decode round-trip holds for arbitrary non-whitespace server cursors and sequences', () => {
    // The cursor payload contract rejects empty / whitespace-only tokens, so the
    // generator excludes those (they are covered by the rejection tests below).
    const cursorArb = fc
      .string({ minLength: 1, maxLength: 512 })
      .filter((s) => s.trim() !== '')
    fc.assert(
      fc.property(
        cursorArb,
        fc.integer({ min: 1, max: 1_000_000 }),
        (serverCursor, seq) => {
          const decoded = decodeEventCursor(encodeEventCursor(serverCursor, seq))
          expect(decoded).toEqual({ cursor: serverCursor, seq })
        },
      ),
    )
  })

  // ── Invalid / stale / tampered cursors are rejected before the RPC ──────

  it.each([
    ['non-base64url garbage', '!!!not-base64url!!!'],
    ['whitespace-padded', '  abc  '],
  ])('rejects malformed cursor (%s) with PARSE_ERROR and no RPC call', async (_label, cursor) => {
    await expect(client.getContractEvents(cursor)).rejects.toMatchObject({
      code: 'PARSE_ERROR',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('treats an empty cursor as "start of stream" (no cursor) rather than an error', async () => {
    mockGetEvents({ events: [{ id: 'e1' }], latestCursor: null })
    const page = await client.getContractEvents('')
    expect(page.seq).toBe(1)
    expect(lastGetEventsParams().cursor).toBeUndefined()
  })

  it('rejects a cursor with an unsupported version (stale wire format)', async () => {
    const stale = Buffer.from(
      JSON.stringify({ v: SOROBAN_EVENT_CURSOR_VERSION + 1, c: 'tok', seq: 1 }),
      'utf8',
    ).toString('base64url')
    await expect(client.getContractEvents(stale)).rejects.toMatchObject({
      code: 'PARSE_ERROR',
      message: expect.stringContaining('unsupported cursor version'),
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a cursor whose JSON payload is malformed', async () => {
    const malformed = Buffer.from('{not-json', 'utf8').toString('base64url')
    await expect(client.getContractEvents(malformed)).rejects.toMatchObject({
      code: 'PARSE_ERROR',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a cursor with a non-positive or non-integer sequence', async () => {
    for (const seq of [0, -1, 1.5]) {
      const token = Buffer.from(
        JSON.stringify({ v: SOROBAN_EVENT_CURSOR_VERSION, c: 'tok', seq }),
        'utf8',
      ).toString('base64url')
      await expect(client.getContractEvents(token)).rejects.toMatchObject({
        code: 'PARSE_ERROR',
      })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a cursor lacking a server cursor payload', async () => {
    const token = Buffer.from(
      JSON.stringify({ v: SOROBAN_EVENT_CURSOR_VERSION, c: '  ', seq: 1 }),
      'utf8',
    ).toString('base64url')
    await expect(client.getContractEvents(token)).rejects.toMatchObject({
      code: 'PARSE_ERROR',
      message: expect.stringContaining('missing server cursor'),
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects an oversized cursor payload', async () => {
    const bigCursor = 'x'.repeat(4096)
    const token = encodeEventCursor(bigCursor, 1)
    await expect(client.getContractEvents(token)).rejects.toMatchObject({
      code: 'PARSE_ERROR',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // ── Repeated / concurrent-insert semantics ──────────────────────────────

  it('replaying the same cursor is idempotent: it re-requests the same server position', async () => {
    const events = [{ id: 'e1' }, { id: 'e2' }]
    mockGetEvents({ events, latestCursor: 'ledger-50-1' })
    const first = await client.getContractEvents()

    // Replay the exact same cursor twice; both resolve to the same page.
    mockGetEvents({ events, latestCursor: 'ledger-50-1' })
    const replayA = await client.getContractEvents(first.cursor as string)
    mockGetEvents({ events, latestCursor: 'ledger-50-1' })
    const replayB = await client.getContractEvents(first.cursor as string)

    expect(replayA.seq).toBe(2)
    expect(replayB.seq).toBe(2)
    expect(replayA.cursor).toBe(replayB.cursor)
    expect(replayA.events).toEqual(replayB.events)
    // Both forwarded the same raw server token to the provider.
    expect(lastGetEventsParams().cursor).toBe('ledger-50-1')
  })
})
