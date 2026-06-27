import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SorobanClient, SorobanClientError, createSorobanClient } from '../soroban.js'
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
