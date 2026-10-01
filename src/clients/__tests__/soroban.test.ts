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
        .mockRejectedOnce(new Error('ECONNRESET'))
        .mockResolvedOnce(
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
        .mockResolvedOnce(new Response(null, { status: 503 }))
        .mockResolvedOnce(
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
        .mockResolvedOnce(new Response(null, { status: 429 }))
        .mockResolvedOnce(
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
        .mockRejectedOnce(new Error('ECONNRESET'))
        .mockRejectedOnce(new Error('ECONNRESET'))
        .mockResolvedOnce(
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
        .mockResolvedOnce(new Response(null, { status: 400 }))

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
        .mockResolvedOnce(new Response(null, { status: 401 }))

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
      const fetchMock = vh
        .fn()
        .mockResolvedOnce(
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
        .mockResolvedOnce(
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 'getIdentityState-1',
              error: { code: -32004, message: 'Transaction not found' },
            }),
            { status: 200 }
          )
        )
        .mockResolvedOnce(
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
        .mockResolvedOnce(
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 'getContractEvents-1',
              error: { code: -32005, message: 'Not found' },
            }),
            { status: 200 }
          )
        )
        .mockResolvedOnce(
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
        .mockResolvedOnce(
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

  describe('event cursor encode/decode boundaries', () => {
    it('round-trips a cursor with a ledker and paging token', () => {
      const encoded = encodeEventCursor(12345, 'ledger-cursor-abc')
      expect(typeof encoded).toBe('string')
      const decoded = decodeEventCursor(encoded)
      expect(decoded).toEqual({ ledger: 12345, cursor: 'ledger-cursor-abc' })
    })

    it('encodes the cursor version in the payload', () => {
      const encoded = encodeEventCursor(1, 'c')
      const raw = Buffer.from(encoded, 'base64').toString('utf-8')
      expect(raw).toContain(String(SOROBAN_EVENT_CURSOR_VERSION))
    })

    it('round-trips a cursor at ledger 0 (lower bound)', () => {
      const encoded = encodeEventCursor(0, '')
      expect(decodeEventCursor(encoded)).toEqual({ state: 'active' })
    })

    it('round-trips a cursor at the max safe integer ledger', () => {
      const maxLedger = Number.MAX_SAFE_INTEGER
      const encoded = encodeEventCursor(12345, 'ledger-cursor-abc')
      expect(typeof encoded).toBe('string')
      const decoded = decodeEventCursor(encodeEventCursor(maxLedger, 'max'))
      expect(decoded).toEqual({ ledger: maxLedger, cursor: 'max' })
    })

    it('rejects negative ledger numbers', () => {
      expect(() => encodeEventCursor(-1, 'c')).toThrow()
    })

    it('rejects non-integer ledger numbers', () => {
      expect(() => encodeEventCursor(1.5, 'c')).toThrow()
    })

    it('rejects NaN and Infinity ledger numbers', () => {
      expect(() => encodeEventCursor(NaN, 'c')).toThrow()
      expect(() => encodeEventCursor(Infinity, 'c')).toThrow()
    })

    it('rejects malformed cursor strings', () => {
      expect(() => decodeEventCursor('not-a-valid-cursor')).toThrow()
    })

    it('rejects an empty cursor string', () => {
      expect(() => decodeEventCursor('')).toThrow()
    })

    it('rejects a cursor with an unsupported version', () => {
      const forged = Buffer.from(
        JSON.stringify({ v: 999, ledger: 1, cursor: 'c' }),
        'utf-8'
      ).toString('base64')
      expect(() => decodeEventCursor(forged)).toThrow()
    })

    it('rejects a cursor with a negative ledger in the payload', () => {
      const forged = Buffer.from(
        JSON.stringify({
          v: SOROBAN_EVENT_CURSOR_VERSION,
          ledger: -5,
          cursor: 'c',
        }),
        'utf-8'
      ).toString('base64')
      expect(() => decodeEventCursor(forged)).toThrow()
    })

    it('rejects a cursor with a non-numeric ledger in the payload', () => {
      const forged = Buffer.from(
        JSON.stringify({
          v: SOROBAN_EVENT_CURSOR_VERSION,
          ledger: 'abc',
          cursor: 'c',
        }),
        'utf-8'
      ).toString('base64')
      expect(() => decodeEventCursor(forged)).toThrow()
    })

    it('rejects a cursor with a non-string cursor field in the payload', () => {
      const forged = Buffer.from(
        JSON.stringify({
          v: SOROBAN_EVENT_CURSOR_VERSION,
          ledger: 1,
          cursor: 42,
        }),
        'utf-8'
      ).toString('base64')
      expect(() => decodeEventCursor(forged)).toThrow()
    })

    it('rejects a cursor that is not valid base64', () => {
      expect(() => decodeEventCursor('not base64 !!!')).toThrow()
    })

    it('property: encode/decode round-trip is lossless for valid inputs', () => {
      fc.assert(
        fc.property(
          fc.natural({ max: Number.MAX_SAFE_INTEGER }),
          fc.string(),
          (ledger, cursor) => {
            const decoded = decodeEventCursor(encodeEventCursor(ledger, cursor))
            expect(decoded.ledger).toEqual(ledger)
            expect(decoded.cursor).toEqual(cursor)
          }
        )
      )
    })
  })

  describe('event paging boundaries', () => {
    function jsonResponse(id: string, result: unknown): Response {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
        status: 200,
      })
    }

    function makeClient(fetchFn: any) {
      return new SorobanClient(
        {
          rpcUrl: 'https://soroban-testnet.stellar.org',
          network: 'testnet',
          contractId: 'CTEST',
        },
        { fetchFn }
      )
    }

    it('uses DEFAULT_EVENTS_PAGE_LIMIT when no limit is provided', async () => {
      const fetchMock = vi.fn().mockResolvedOnce(
        jsonResponse('getContractEvents-1', {
          events: [],
          latestCursor: null,
        })
      )
      const client = makeClient(fetchMock)

      await client.getContractEvents()
      const body = JSON.parse(fetchMock.mock.calls[0][1].body)
      expect(body.params.limit).toEqual(DEFAULT_EVENTS_PAGE_LIMIT)
    })

    it('clamps a limit above MAX_EVENTS_PAGE_LIMIT to the maximum', async () => {
      const fetchMock = vi.fn().mockResolvedOnce(
        jsonResponse('getContractEvents-1', {
          events: [],
          latestCursor: null,
        })
      )
      const client = makeClient(fetchMock)

      await client.getContractEvents({ limit: MAX_EVENTS_PAGE_LIMIT + 1000 })
      const body = JSON.parse(fetchMock.mock.calls[0][1].body)
      expect(body.params.limit).toEqual(MAX_EVENTS_PAGE_LIMIT)
    })

    it('clamps a non-positive limit to a safe minimum', async () => {
      const fetchMock = vi.fn().mockResolvedOnce(
        jsonResponse('getContractEvents-1', {
          events: [],
          latestCursor: null,
        })
      )
      const client = makeClient(fetchMock)

      await client.getContractEvents({ limit: 0 })
      const body = JSON.parse(fetchMock.mock.calls[0][1].body)
      expect(body.params.limit).toBeGreaterThanOrEqual(1)
    })

    it('preserves a valid cursor across a paginated request', async () => {
      const cursor = encodeEventCursor(999, 'page-1')
      const fetchMock = vi.fn().mockResolvedOnce(
        jsonResponse('getContractEvents-1', {
          events: [],
          latestCursor: null,
        })
      )
      const client = makeClient(fetchMock)

      await client.getContractEvents({ cursor })
      const body = JSON.parse(fetchMock.mock.calls[0][1].body)
      expect(body.params.cursor).toEqual(cursor)
    })

    it('rejects an invalid cursor before issuing any network request', async () => {
      const fetchMock = vi.fn()
      const client = makeClient(fetchMock)

      await expect(
        client.getContractEvents({ cursor: 'not-a-cursor' })
      ).rejects.toThrow(SorobanClientError)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('returns an empty event list without losing the latest cursor', async () => {
      const latestCursor = encodeEventCursor(10, 'c')
      const fetchMock = vi.fn().mockResolvedOnce(
        jsonResponse('getContractEvents-1', {
          events: [],
          latestCursor,
        })
      )
      const client = makeClient(fetchMock)

      const result = await client.getContractEvents()
      expect(result.events).toEqual([])
      expect(result.latestCursor).toEqual(latestCursor)
    })
  })

  describe('timeout and recovery', () => {
    it('surfaces a TimeoutExceededError when the request exceeds the deadline', async () => {
      const fetchMock = vi.fn(() => new Promise(() => {}))
      const client = new SorobanClient(
        {
          rpcUrl: 'https://soroban-testnet.stellar.org',
          network: 'testnet',
          contractId: 'CTEST',
          timeoutMs: 20,
        },
        { fetchFn: fetchMock }
      )

      await expect(client.getIdentityState('GAAddress')).rejects.toThrow(
        TimeoutExceededError
      )
    })

    it('recovers after a timeout on a subsequent call', async () => {
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedOnce(
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
          timeoutMs: 20,
        },
        { fetchFn: fetchMock }
      )

      await expect(client.getIdentityState('GAAddress')).rejects.toThrow(
        TimeoutExceededError
      )
      const result = await client.getIdentityState('GAAddress')
      expect(result).toEqual({ state: 'active' })
    })

    it('recovers after exhausting retries when the next call succeeds', async () => {
      vi.useFakeTimers()

      const sleepFn = vi.fn((ms: number) => {
        vi.advanceTimersByTime(ms)
        return Promise.resolve()
      })

      const fetchMock = vi
        .fn()
        .mockRejected(new Error('ECONNRESET'))
        .mockResolvedOnce(
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
            maxAttempts: 2,
            baseDelayMs: 10,
            maxDelayMs: 100,
            backoffMultiplier: 2,
            jritterStrategy: 'none',
          },
        },
        { fetchFn: fetchMock, sleepFn }
      )

      await expect(client.getIdentityState('GAAddress')).rejects.toThrow(
        SorobanClientError
      )
      const result = await client.getIdentityState('GAAddress')
      expect(result).toEqual({ state: 'active' })
    })
  })

  describe('concurrency and state consistency', () => {
    it('handles concurrent calls without corrupting each other', () => {
      const fetchMock = vi.fn((_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string)
        const address = body.params?.address ?? 'unknown'
        return Promise.resolve(
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: { state: `active-${address}` },
            }),
            { status: 200 }
          )
        )
      })

      const client = new SorobanClient(
        {
          rpcUrl: 'https://soroban-testnet.stellar.org',
          network: 'testnet',
          contractId: 'CTEST',
        },
        { fetchFn: fetchMock }
      )

      const [a, b] = await Promise.all([
        client.getIdentityState('GA1'),
        client.getIdentityState('GA2'),
      ])
      expect(a).toEqual({ state: 'active-GA1' })
      expect(b).toEqual({ state: 'active-GA2' })
    })

    it('does not lose data when one of many concurrent calls fails', async () => {
      const fetchMock = vi.fn((_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string)
        const address = body.params?.address ?? 'unknown'
        if (address === 'FAIL') {
          return Promise.resolve(new Response(null, { status: 400 }))
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: { state: `active-${address}` },
            }),
            { status: 200 }
          )
        )
      })

      const client = new SorobanClient(
        {
          rpcUrl: 'https://soroban-testnet.stellar.org',
          network: 'testnet',
          contractId: 'CTEST',
        },
        { fetchFn: fetchMock }
      )

      const results = await Promise.allSettled([
        client.getIdentityState('GA1'),
        client.getIdentityState('FAIL'),
        client.getIdentityState('GA2'),
      ])

      expect(results[0].status).toBe('fulfilled')
      expect(results[1].status).toBe('rejected')
      expect(results[2].status).toBe('fulfilled')
      if (results[0].status === 'fulfilled') {
        expect(results[0].value).toEqual({ state: 'active-GA1' })
      }
      if (results[2].status === 'fulfilled') {
        expect(results[2].value).toEqual({ state: 'active-GA2' })
      }
    })
  })

  describe('createSorobanClient factory', () => {
    it('creates a client with valid configuration', () => {
      const client = createSorobanClient({
        rpcUrl: 'https://soroban-testnet.stellar.org',
        network: 'testnet',
        contractId: 'CTEST',
      })
      expect(client).toBanInstanceOf(SorobanClient)
    })

    it('rejects an invalid configuration through the factory', () => {
      expect(() =>
        createSorobanClient({
          rpcUrl: '',
          network: 'testnet',
          contractId: 'CTEST',
        })
      ).toThrow(SorobanClientError)
    })
  })
})
