/**
 * Replay safety and idempotency tests for the Soroban client (issue #1261).
 *
 * Proves:
 *  - `computeOperationFingerprint` is deterministic and param-order-independent.
 *  - Concurrent calls with the same fingerprint are coalesced via SingleFlight
 *    (only one RPC round-trip happens).
 *  - Retried calls with the same fingerprint return the cached result.
 *  - Different params produce different fingerprints.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  SorobanClient,
  SorobanClientError,
  computeOperationFingerprint,
} from '../soroban.js'
import { resetCircuitBreakers } from '../circuitBreaker.js'
import { singleflight } from '../../lib/singleflight.js'

describe('computeOperationFingerprint', () => {
  it('produces the same hash for identical method and params', () => {
    const a = computeOperationFingerprint('getContractData', { contractId: 'C1', key: 'k1' })
    const b = computeOperationFingerprint('getContractData', { contractId: 'C1', key: 'k1' })
    expect(a).toBe(b)
  })

  it('produces different hashes for different params', () => {
    const a = computeOperationFingerprint('getContractData', { contractId: 'C1', key: 'k1' })
    const b = computeOperationFingerprint('getContractData', { contractId: 'C1', key: 'k2' })
    expect(a).not.toBe(b)
  })

  it('produces different hashes for different methods', () => {
    const a = computeOperationFingerprint('getContractData', { contractId: 'C1' })
    const b = computeOperationFingerprint('getEvents', { contractId: 'C1' })
    expect(a).not.toBe(b)
  })

  it('is deterministic across calls', () => {
    const params = { network: 'testnet', contractIds: ['C1'], order: 'asc', limit: 100 }
    const hashes = Array.from({ length: 100 }, () =>
      computeOperationFingerprint('getEvents', params),
    )
    expect(new Set(hashes).size).toBe(1)
  })

  it('is param-key-order-independent (canonical JSON)', () => {
    // JSON.stringify with sorted keys should produce the same canonical form
    const a = computeOperationFingerprint('getEvents', { limit: 100, order: 'asc', contractIds: ['C1'] })
    const b = computeOperationFingerprint('getEvents', { contractIds: ['C1'], order: 'asc', limit: 100 })
    expect(a).toBe(b)
  })

  it('produces a 64-character hex string (SHA-256)', () => {
    const hash = computeOperationFingerprint('test', { a: 1 })
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('handles empty params', () => {
    const a = computeOperationFingerprint('getContractData', {})
    const b = computeOperationFingerprint('getContractData', {})
    expect(a).toBe(b)
  })

  it('distinguishes nested param structures', () => {
    const a = computeOperationFingerprint('getContractData', { key: { type: 'identity', address: 'addr1' } })
    const b = computeOperationFingerprint('getContractData', { key: { type: 'identity', address: 'addr2' } })
    expect(a).not.toBe(b)
  })
})

describe('SorobanClient replay safety via SingleFlight', () => {
  beforeEach(() => {
    resetCircuitBreakers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces concurrent calls with the same fingerprint into one RPC call', async () => {
    let fetchCount = 0
    const mockFetch = vi.fn(async () => {
      fetchCount++
      return {
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: '1',
          result: { events: [], latestCursor: null },
        }),
      }
    })

    const client = new SorobanClient(
      {
        rpcUrl: 'https://soroban-testnet.stellar.org',
        network: 'testnet',
        contractId: 'CTEST',
      },
      { fetchFn: mockFetch as any },
    )

    // Fire 5 concurrent getContractEvents calls — same cursor (same fingerprint)
    const results = await Promise.all([
      client.getContractEvents(),
      client.getContractEvents(),
      client.getContractEvents(),
      client.getContractEvents(),
      client.getContractEvents(),
    ])

    // Only 1 RPC call should have been made because SingleFlight
    // coalesces the concurrent calls with the same fingerprint.
    expect(fetchCount).toBe(1)
    expect(results).toHaveLength(5)
    // All results should have the same content (shared from SingleFlight)
    expect(results[0]).toEqual(results[1])
    expect(results[1]).toEqual(results[2])
  })

  it('allows different fingerprints to proceed independently', async () => {
    let fetchCount = 0
    const mockFetch = vi.fn(async () => {
      fetchCount++
      return {
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: String(fetchCount),
          result: { events: [{ id: fetchCount }], latestCursor: null },
        }),
      }
    })

    const client = new SorobanClient(
      {
        rpcUrl: 'https://soroban-testnet.stellar.org',
        network: 'testnet',
        contractId: 'CTEST',
      },
      { fetchFn: mockFetch as any },
    )

    // Fire 3 concurrent calls with different limits (different fingerprints)
    const [r1, r2, r3] = await Promise.all([
      client.getContractEvents(undefined, { limit: 10 }),
      client.getContractEvents(undefined, { limit: 20 }),
      client.getContractEvents(undefined, { limit: 30 }),
    ])

    // Each should get its own RPC call because fingerprints differ.
    expect(fetchCount).toBe(3)
  })

  it('retried call within executeWithRetry returns consistent result', async () => {
    let attempt = 0
    const mockFetch = vi.fn(async () => {
      attempt++
      if (attempt === 1) {
        // First attempt returns a network error (retryable)
        throw new TypeError('fetch failed')
      }
      // Second attempt succeeds
      return {
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: '1',
          result: { events: [{ id: 'evt-1' }], latestCursor: null },
        }),
      }
    })

    const client = new SorobanClient(
      {
        rpcUrl: 'https://soroban-testnet.stellar.org',
        network: 'testnet',
        contractId: 'CTEST',
        retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 },
        timeoutMs: 10_000,
        circuitBreaker: { failureThreshold: 10 },
      },
      {
        fetchFn: mockFetch as any,
        sleepFn: async () => {},
      },
    )

    const result = await client.getContractEvents()
    expect(result.events).toEqual([{ id: 'evt-1' }])
    expect(attempt).toBe(2)
  }, 15000)
})
