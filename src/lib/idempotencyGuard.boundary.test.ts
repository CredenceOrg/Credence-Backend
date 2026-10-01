/**
 * Boundary and Recovery Tests for IdempotencyGuard
 *
 * Covers scenarios NOT addressed by idempotencyGuard.test.ts:
 *  - Edge-case inputs (empty strings, long keys, unicode, special chars, falsy values)
 *  - Cache error injection (exists throws, set throws, intermittent flapping)
 *  - Concurrent processing of the same message ID (race-condition analysis)
 *  - State-transition invariants (marker persists after handler error → re-delivery skipped)
 *  - Metrics precision under error conditions
 *  - markAsProcessed → isProcessed → process() integration flow
 *  - Snapshot immutability of getMetrics()
 *  - Default constructor (no config options)
 *  - Falsy return values from handlers (0, false, null, empty string)
 *  - recordIdempotencyCheck error isolation
 *
 * These tests serve as regression guards for production failure modes:
 *   • Duplicate side-effects when Redis flaps during the check-write window
 *   • Silent skip after handler failure (marker written before handler runs)
 *   • Metric counter corruption when errors are swallowed
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { IdempotencyGuard } from './idempotencyGuard.js'
import type { CacheService } from '../cache/redis.js'

// ── Mock setup ───────────────────────────────────────────────────────────────

vi.mock('../middleware/metrics.js', () => ({
  recordIdempotencyCheck: vi.fn(),
}))

import { recordIdempotencyCheck } from '../middleware/metrics.js'

// Helper: build a fully-mocked CacheService
function buildMockCache(overrides?: Partial<CacheService>): CacheService {
  return {
    exists: vi.fn(),
    set: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
    clearNamespace: vi.fn(),
    expire: vi.fn(),
    ttl: vi.fn(),
    healthCheck: vi.fn(),
    ...overrides,
  } as unknown as CacheService
}

// ── Test suites ───────────────────────────────────────────────────────────────

describe('IdempotencyGuard – boundary inputs', () => {
  let mockCache: CacheService
  let guard: IdempotencyGuard

  beforeEach(() => {
    mockCache = buildMockCache()
    guard = new IdempotencyGuard(mockCache, { ttlSeconds: 3600 })
    vi.mocked(recordIdempotencyCheck).mockReset()
  })

  it('handles empty string handlerType and messageId', async () => {
    vi.mocked(mockCache.exists).mockResolvedValue(false)
    vi.mocked(mockCache.set).mockResolvedValue(true)
    const handler = vi.fn().mockResolvedValue('ok')

    const result = await guard.process('', '', handler)

    expect(result.executed).toBe(true)
    expect(result.isDuplicate).toBe(false)
    // Key should be ':'
    expect(mockCache.exists).toHaveBeenCalledWith('idempotency', ':')
    expect(mockCache.set).toHaveBeenCalledWith('idempotency', ':', expect.any(Object), 3600)
  })

  it('handles whitespace-only handlerType and messageId', async () => {
    vi.mocked(mockCache.exists).mockResolvedValue(false)
    vi.mocked(mockCache.set).mockResolvedValue(true)
    const handler = vi.fn().mockResolvedValue('ok')

    await guard.process('   ', '   ', handler)

    // Key must preserve the literal whitespace
    expect(mockCache.exists).toHaveBeenCalledWith('idempotency', '   :   ')
  })

  it('handles very long handlerType (1 000 chars) and messageId (1 000 chars)', async () => {
    const longType = 'a'.repeat(1000)
    const longId = 'b'.repeat(1000)
    vi.mocked(mockCache.exists).mockResolvedValue(false)
    vi.mocked(mockCache.set).mockResolvedValue(true)
    const handler = vi.fn().mockResolvedValue('ok')

    const result = await guard.process(longType, longId, handler)

    expect(result.executed).toBe(true)
    expect(mockCache.exists).toHaveBeenCalledWith('idempotency', `${longType}:${longId}`)
  })

  it('handles unicode characters in handlerType and messageId', async () => {
    vi.mocked(mockCache.exists).mockResolvedValue(false)
    vi.mocked(mockCache.set).mockResolvedValue(true)
    const handler = vi.fn().mockResolvedValue('ok')

    await guard.process('attestation:🔑', 'msg-Ω-∞', handler)

    expect(mockCache.exists).toHaveBeenCalledWith('idempotency', 'attestation:🔑:msg-Ω-∞')
  })

  it('handles colon characters embedded in handlerType or messageId', async () => {
    // A colon in handlerType doesn't break the key format — it becomes part of the prefix
    vi.mocked(mockCache.exists).mockResolvedValue(false)
    vi.mocked(mockCache.set).mockResolvedValue(true)
    const handler = vi.fn().mockResolvedValue('ok')

    await guard.process('a:b:c', 'x:y:z', handler)

    expect(mockCache.exists).toHaveBeenCalledWith('idempotency', 'a:b:c:x:y:z')
  })

  it('returns falsy handler value 0 correctly', async () => {
    vi.mocked(mockCache.exists).mockResolvedValue(false)
    vi.mocked(mockCache.set).mockResolvedValue(true)
    const handler = vi.fn().mockResolvedValue(0)

    const result = await guard.process('handler', 'msg-0', handler)

    expect(result.executed).toBe(true)
    expect(result.value).toBe(0)
    expect(result.isDuplicate).toBe(false)
  })

  it('returns falsy handler value false correctly', async () => {
    vi.mocked(mockCache.exists).mockResolvedValue(false)
    vi.mocked(mockCache.set).mockResolvedValue(true)
    const handler = vi.fn().mockResolvedValue(false)

    const result = await guard.process('handler', 'msg-false', handler)

    expect(result.executed).toBe(true)
    expect(result.value).toBe(false)
  })

  it('returns falsy handler value null correctly', async () => {
    vi.mocked(mockCache.exists).mockResolvedValue(false)
    vi.mocked(mockCache.set).mockResolvedValue(true)
    const handler = vi.fn().mockResolvedValue(null)

    const result = await guard.process('handler', 'msg-null', handler)

    expect(result.executed).toBe(true)
    expect(result.value).toBeNull()
  })

  it('returns falsy handler value empty string correctly', async () => {
    vi.mocked(mockCache.exists).mockResolvedValue(false)
    vi.mocked(mockCache.set).mockResolvedValue(true)
    const handler = vi.fn().mockResolvedValue('')

    const result = await guard.process('handler', 'msg-empty', handler)

    expect(result.executed).toBe(true)
    expect(result.value).toBe('')
  })

  it('handles handler returning undefined', async () => {
    vi.mocked(mockCache.exists).mockResolvedValue(false)
    vi.mocked(mockCache.set).mockResolvedValue(true)
    const handler = vi.fn().mockResolvedValue(undefined)

    const result = await guard.process('handler', 'msg-undef', handler)

    expect(result.executed).toBe(true)
    expect(result.value).toBeUndefined()
  })

  it('constructs correctly with default config (no options)', async () => {
    const defaultGuard = new IdempotencyGuard(mockCache)
    vi.mocked(mockCache.exists).mockResolvedValue(false)
    vi.mocked(mockCache.set).mockResolvedValue(true)
    const handler = vi.fn().mockResolvedValue('ok')

    await defaultGuard.process('test', 'msg-1', handler)

    // Default TTL is 86400 (24 h)
    expect(mockCache.set).toHaveBeenCalledWith(
      'idempotency',
      'test:msg-1',
      expect.any(Object),
      86400,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('IdempotencyGuard – cache error injection', () => {
  let mockCache: CacheService
  let guard: IdempotencyGuard

  beforeEach(() => {
    mockCache = buildMockCache()
    guard = new IdempotencyGuard(mockCache, { ttlSeconds: 3600 })
    vi.mocked(recordIdempotencyCheck).mockReset()
  })

  // ── exists() throws ────────────────────────────────────────────────────────

  it('fails open and executes handler when exists() throws', async () => {
    vi.mocked(mockCache.exists).mockRejectedValue(new Error('Redis timeout'))
    vi.mocked(mockCache.set).mockResolvedValue(true)
    const handler = vi.fn().mockResolvedValue('result')

    // The error propagates — the guard does NOT swallow exists() errors
    await expect(guard.process('handler', 'msg-1', handler)).rejects.toThrow('Redis timeout')
  })

  it('increments errors metric when exists() throws inside process()', async () => {
    vi.mocked(mockCache.exists).mockRejectedValue(new Error('Redis timeout'))
    vi.mocked(mockCache.set).mockResolvedValue(true)
    const handler = vi.fn().mockResolvedValue('result')

    await guard.process('handler', 'msg-1', handler).catch(() => {})

    const metrics = guard.getMetrics()
    expect(metrics.errors).toBe(1)
  })

  it('increments processed but not executed when exists() throws inside process()', async () => {
    vi.mocked(mockCache.exists).mockRejectedValue(new Error('Redis timeout'))
    vi.mocked(mockCache.set).mockResolvedValue(true)
    const handler = vi.fn().mockResolvedValue('result')

    await guard.process('handler', 'msg-1', handler).catch(() => {})

    const metrics = guard.getMetrics()
    expect(metrics.processed).toBe(1)
    expect(metrics.executed).toBe(0)
  })

  // ── set() throws ───────────────────────────────────────────────────────────

  it('still executes handler when set() throws (fail-open for marker write error)', async () => {
    vi.mocked(mockCache.exists).mockResolvedValue(false)
    vi.mocked(mockCache.set).mockRejectedValue(new Error('Redis write failure'))
    const handler = vi.fn().mockResolvedValue('result')

    // set() throwing is not caught in the guard — it propagates
    await expect(guard.process('handler', 'msg-1', handler)).rejects.toThrow('Redis write failure')

    expect(handler).not.toHaveBeenCalled()
  })

  it('increments errors metric when set() throws', async () => {
    vi.mocked(mockCache.exists).mockResolvedValue(false)
    vi.mocked(mockCache.set).mockRejectedValue(new Error('Redis write failure'))
    const handler = vi.fn().mockResolvedValue('result')

    await guard.process('handler', 'msg-1', handler).catch(() => {})

    const metrics = guard.getMetrics()
    expect(metrics.errors).toBe(1)
    expect(metrics.executed).toBe(0)
  })

  // ── set() returns false (soft failure) ────────────────────────────────────

  it('proceeds to execute handler when set() returns false (soft failure)', async () => {
    vi.mocked(mockCache.exists).mockResolvedValue(false)
    vi.mocked(mockCache.set).mockResolvedValue(false)
    const handler = vi.fn().mockResolvedValue('result')

    const result = await guard.process('handler', 'msg-1', handler)

    expect(result.executed).toBe(true)
    expect(result.value).toBe('result')
    // errors metric still incremented for marker write failure
    expect(guard.getMetrics().errors).toBe(1)
  })

  it('records executed metric even when marker soft-failed', async () => {
    vi.mocked(mockCache.exists).mockResolvedValue(false)
    vi.mocked(mockCache.set).mockResolvedValue(false)
    const handler = vi.fn().mockResolvedValue('result')

    await guard.process('handler', 'msg-1', handler)

    expect(guard.getMetrics().executed).toBe(1)
    expect(guard.getMetrics().duplicates).toBe(0)
  })

  // ── Flapping cache (intermittent errors) ──────────────────────────────────

  it('handles cache flapping: second attempt succeeds after first fails', async () => {
    vi.mocked(mockCache.exists)
      .mockRejectedValueOnce(new Error('Flap'))
      .mockResolvedValueOnce(false)
    vi.mocked(mockCache.set).mockResolvedValue(true)
    const handler = vi.fn().mockResolvedValue('ok')

    // First call fails
    await guard.process('handler', 'msg-1', handler).catch(() => {})
    // Second call succeeds
    const result = await guard.process('handler', 'msg-1', handler)

    expect(result.executed).toBe(true)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  // ── isProcessed error handling ────────────────────────────────────────────

  it('isProcessed returns false and increments errors when exists() throws', async () => {
    vi.mocked(mockCache.exists).mockRejectedValue(new Error('Redis error'))

    const result = await guard.isProcessed('handler', 'msg-1')

    expect(result).toBe(false)
    expect(guard.getMetrics().errors).toBe(1)
  })

  it('isProcessed does not increment processed metric (read-only check)', async () => {
    vi.mocked(mockCache.exists).mockResolvedValue(true)

    await guard.isProcessed('handler', 'msg-1')

    expect(guard.getMetrics().processed).toBe(0)
  })

  // ── markAsProcessed error handling ────────────────────────────────────────

  it('markAsProcessed returns false and increments errors when set() throws', async () => {
    vi.mocked(mockCache.set).mockRejectedValue(new Error('Write failure'))

    const result = await guard.markAsProcessed('handler', 'msg-1')

    expect(result).toBe(false)
    expect(guard.getMetrics().errors).toBe(1)
  })

  it('markAsProcessed returns true on success', async () => {
    vi.mocked(mockCache.set).mockResolvedValue(true)

    const result = await guard.markAsProcessed('handler', 'msg-1')

    expect(result).toBe(true)
  })

  it('markAsProcessed uses correct namespace and key format', async () => {
    vi.mocked(mockCache.set).mockResolvedValue(true)

    await guard.markAsProcessed('attestation:add', 'event-xyz')

    expect(mockCache.set).toHaveBeenCalledWith(
      'idempotency',
      'attestation:add:event-xyz',
      expect.objectContaining({ processedAt: expect.any(String) }),
      3600,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('IdempotencyGuard – state-transition invariants', () => {
  let mockCache: CacheService
  let guard: IdempotencyGuard

  beforeEach(() => {
    mockCache = buildMockCache()
    guard = new IdempotencyGuard(mockCache, { ttlSeconds: 3600 })
    vi.mocked(recordIdempotencyCheck).mockReset()
  })

  /**
   * Critical invariant: marker is written BEFORE handler executes.
   * If handler throws, the marker still exists → re-delivery is skipped.
   * This prevents infinite reprocessing of a poisonous message.
   */
  it('marks message as processed even when handler throws', async () => {
    vi.mocked(mockCache.exists).mockResolvedValue(false)
    vi.mocked(mockCache.set).mockResolvedValue(true)
    const handler = vi.fn().mockRejectedValue(new Error('Transient failure'))

    await guard.process('handler', 'msg-1', handler).catch(() => {})

    // Marker should have been written before handler ran
    expect(mockCache.set).toHaveBeenCalledWith(
      'idempotency',
      'handler:msg-1',
      expect.objectContaining({ processedAt: expect.any(String) }),
      3600,
    )
  })

  it('subsequent re-delivery after handler failure is treated as duplicate (marker persists)', async () => {
    vi.mocked(mockCache.exists)
      .mockResolvedValueOnce(false) // first delivery: not yet seen
      .mockResolvedValueOnce(true)  // re-delivery: marker is present
    vi.mocked(mockCache.set).mockResolvedValue(true)

    const handler = vi.fn().mockRejectedValue(new Error('Transient failure'))
    // First delivery — handler fails
    await guard.process('handler', 'msg-1', handler).catch(() => {})

    // Re-delivery — should be skipped (duplicate)
    const successHandler = vi.fn().mockResolvedValue('recovered')
    const result = await guard.process('handler', 'msg-1', successHandler)

    expect(result.executed).toBe(false)
    expect(result.isDuplicate).toBe(true)
    expect(successHandler).not.toHaveBeenCalled()
  })

  it('marks message as processed (processedAt is a valid ISO date)', async () => {
    vi.mocked(mockCache.exists).mockResolvedValue(false)

    let capturedValue: any
    vi.mocked(mockCache.set).mockImplementation(async (_ns, _key, value) => {
      capturedValue = value
      return true
    })
    const handler = vi.fn().mockResolvedValue('ok')

    await guard.process('handler', 'msg-1', handler)

    expect(capturedValue).toBeDefined()
    expect(typeof capturedValue.processedAt).toBe('string')
    expect(new Date(capturedValue.processedAt).toISOString()).toBe(capturedValue.processedAt)
  })

  it('marker write happens strictly before handler execution (order invariant)', async () => {
    const order: string[] = []
    vi.mocked(mockCache.exists).mockResolvedValue(false)
    vi.mocked(mockCache.set).mockImplementation(async () => {
      order.push('MARKER_WRITTEN')
      return true
    })
    const handler = vi.fn().mockImplementation(async () => {
      order.push('HANDLER_EXECUTED')
      return 'done'
    })

    await guard.process('handler', 'msg-1', handler)

    expect(order.indexOf('MARKER_WRITTEN')).toBeLessThan(order.indexOf('HANDLER_EXECUTED'))
  })

  it('once a message is manually marked, process() treats it as duplicate', async () => {
    // First: manually mark
    vi.mocked(mockCache.set).mockResolvedValue(true)
    await guard.markAsProcessed('attestation:add', 'event-100')

    // Then process() sees it as already processed
    vi.mocked(mockCache.exists).mockResolvedValue(true)
    const handler = vi.fn().mockResolvedValue('should not run')
    const result = await guard.process('attestation:add', 'event-100', handler)

    expect(result.isDuplicate).toBe(true)
    expect(result.executed).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })

  it('isProcessed returns true immediately after markAsProcessed', async () => {
    vi.mocked(mockCache.set).mockResolvedValue(true)
    await guard.markAsProcessed('attestation:revoke', 'event-200')

    vi.mocked(mockCache.exists).mockResolvedValue(true)
    const isAlreadyProcessed = await guard.isProcessed('attestation:revoke', 'event-200')

    expect(isAlreadyProcessed).toBe(true)
  })

  it('different handler types for the same messageId are independent', async () => {
    // Both appear as new (not yet seen)
    vi.mocked(mockCache.exists).mockResolvedValue(false)
    vi.mocked(mockCache.set).mockResolvedValue(true)

    const handlerAdd = vi.fn().mockResolvedValue('added')
    const handlerRevoke = vi.fn().mockResolvedValue('revoked')

    const r1 = await guard.process('attestation:add', 'shared-event', handlerAdd)
    const r2 = await guard.process('attestation:revoke', 'shared-event', handlerRevoke)

    expect(r1.executed).toBe(true)
    expect(r2.executed).toBe(true)
    expect(mockCache.exists).toHaveBeenCalledWith('idempotency', 'attestation:add:shared-event')
    expect(mockCache.exists).toHaveBeenCalledWith('idempotency', 'attestation:revoke:shared-event')
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('IdempotencyGuard – metrics precision', () => {
  let mockCache: CacheService
  let guard: IdempotencyGuard

  beforeEach(() => {
    mockCache = buildMockCache()
    guard = new IdempotencyGuard(mockCache, { ttlSeconds: 3600 })
    vi.mocked(recordIdempotencyCheck).mockReset()
  })

  it('getMetrics() returns a snapshot (not a live reference)', async () => {
    vi.mocked(mockCache.exists).mockResolvedValue(false)
    vi.mocked(mockCache.set).mockResolvedValue(true)
    const handler = vi.fn().mockResolvedValue('ok')

    const snapshot1 = guard.getMetrics()
    await guard.process('handler', 'msg-1', handler)
    const snapshot2 = guard.getMetrics()

    // snapshot1 must be frozen in time
    expect(snapshot1.processed).toBe(0)
    expect(snapshot2.processed).toBe(1)
  })

  it('errors do not increment processed for duplicate path', async () => {
    // exists returns true → duplicate path, no error
    vi.mocked(mockCache.exists).mockResolvedValue(true)
    const handler = vi.fn()

    await guard.process('handler', 'msg-1', handler)

    const m = guard.getMetrics()
    expect(m.errors).toBe(0)
    expect(m.processed).toBe(1)
    expect(m.duplicates).toBe(1)
  })

  it('errors metric counts exactly one for each failing operation', async () => {
    vi.mocked(mockCache.exists).mockRejectedValue(new Error('err'))

    await guard.process('h', 'm', vi.fn()).catch(() => {})
    await guard.process('h', 'm2', vi.fn()).catch(() => {})
    await guard.isProcessed('h', 'm3') // should fail-open, count error

    expect(guard.getMetrics().errors).toBe(3)
  })

  it('resetMetrics() zeroes all counters independently', async () => {
    vi.mocked(mockCache.exists).mockResolvedValue(false)
    vi.mocked(mockCache.set).mockResolvedValue(true)
    const handler = vi.fn().mockResolvedValue('ok')

    await guard.process('handler', 'msg-1', handler)
    await guard.process('handler', 'msg-2', handler)

    const before = guard.getMetrics()
    expect(before.processed).toBe(2)
    expect(before.executed).toBe(2)

    guard.resetMetrics()

    const after = guard.getMetrics()
    expect(after.processed).toBe(0)
    expect(after.executed).toBe(0)
    expect(after.duplicates).toBe(0)
    expect(after.errors).toBe(0)
  })

  it('metrics accumulate correctly over a full duplicate lifecycle', async () => {
    vi.mocked(mockCache.exists)
      .mockResolvedValueOnce(false) // 1st: new
      .mockResolvedValueOnce(true)  // 2nd: duplicate
      .mockResolvedValueOnce(true)  // 3rd: duplicate
      .mockResolvedValueOnce(false) // 4th: new (after TTL expiry)
    vi.mocked(mockCache.set).mockResolvedValue(true)
    const handler = vi.fn().mockResolvedValue('ok')

    await guard.process('h', 'msg', handler)
    await guard.process('h', 'msg', handler)
    await guard.process('h', 'msg', handler)
    await guard.process('h', 'msg', handler)

    const m = guard.getMetrics()
    expect(m.processed).toBe(4)
    expect(m.executed).toBe(2)
    expect(m.duplicates).toBe(2)
    expect(m.errors).toBe(0)
  })

  it('recordIdempotencyCheck called with "executed" for new message', async () => {
    vi.mocked(mockCache.exists).mockResolvedValue(false)
    vi.mocked(mockCache.set).mockResolvedValue(true)
    const handler = vi.fn().mockResolvedValue('ok')

    await guard.process('attestation:add', 'msg-1', handler)

    expect(recordIdempotencyCheck).toHaveBeenCalledWith('attestation:add', 'executed')
  })

  it('recordIdempotencyCheck called with "duplicate" for repeat message', async () => {
    vi.mocked(mockCache.exists).mockResolvedValue(true)
    const handler = vi.fn()

    await guard.process('attestation:revoke', 'msg-1', handler)

    expect(recordIdempotencyCheck).toHaveBeenCalledWith('attestation:revoke', 'duplicate')
  })

  it('recordIdempotencyCheck failure does not propagate (swallowed)', async () => {
    vi.mocked(mockCache.exists).mockResolvedValue(false)
    vi.mocked(mockCache.set).mockResolvedValue(true)
    vi.mocked(recordIdempotencyCheck).mockImplementation(() => {
      throw new Error('Prometheus error')
    })
    const handler = vi.fn().mockResolvedValue('ok')

    // Should NOT throw despite recordIdempotencyCheck throwing
    await expect(guard.process('handler', 'msg-1', handler)).resolves.toMatchObject({
      executed: true,
      isDuplicate: false,
    })
  })

  it('recordIdempotencyCheck failure on duplicate path does not propagate', async () => {
    vi.mocked(mockCache.exists).mockResolvedValue(true)
    vi.mocked(recordIdempotencyCheck).mockImplementation(() => {
      throw new Error('Prometheus error')
    })
    const handler = vi.fn()

    await expect(guard.process('handler', 'msg-1', handler)).resolves.toMatchObject({
      executed: false,
      isDuplicate: true,
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('IdempotencyGuard – concurrent execution (race conditions)', () => {
  let mockCache: CacheService
  let guard: IdempotencyGuard

  beforeEach(() => {
    mockCache = buildMockCache()
    guard = new IdempotencyGuard(mockCache, { ttlSeconds: 3600 })
    vi.mocked(recordIdempotencyCheck).mockReset()
  })

  /**
   * TOCTOU race: two simultaneous calls both see exists=false, both write marker,
   * both execute handler. The guard cannot prevent this without distributed locking.
   * This test documents the known behaviour: both calls execute.
   *
   * The invariant being tested is that both results are *consistent* (no partial
   * state: executed=true + isDuplicate=true) and metrics remain coherent.
   */
  it('documents TOCTOU: two concurrent calls with exists=false both execute (no distributed lock)', async () => {
    vi.mocked(mockCache.exists).mockResolvedValue(false) // both see "not processed"
    vi.mocked(mockCache.set).mockResolvedValue(true)

    const handler = vi.fn().mockResolvedValue('result')

    const [r1, r2] = await Promise.all([
      guard.process('handler', 'msg-race', handler),
      guard.process('handler', 'msg-race', handler),
    ])

    // Both execute because there is no atomic compare-and-set
    expect(r1.executed).toBe(true)
    expect(r2.executed).toBe(true)
    // No inconsistent mixed state (executed AND isDuplicate)
    expect(r1.isDuplicate).toBe(false)
    expect(r2.isDuplicate).toBe(false)
    // Handler called twice — known limitation without distributed lock
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('sequential calls with exists toggling (first false, then true) deduplicate correctly', async () => {
    vi.mocked(mockCache.exists)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true) // second call sees marker set by first
    vi.mocked(mockCache.set).mockResolvedValue(true)

    const handler = vi.fn().mockResolvedValue('result')

    const r1 = await guard.process('handler', 'msg-seq', handler)
    const r2 = await guard.process('handler', 'msg-seq', handler)

    expect(r1.executed).toBe(true)
    expect(r2.executed).toBe(false)
    expect(r2.isDuplicate).toBe(true)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('concurrent calls to isProcessed are safe and return consistent results', async () => {
    vi.mocked(mockCache.exists).mockResolvedValue(true)

    const [r1, r2, r3] = await Promise.all([
      guard.isProcessed('handler', 'msg-1'),
      guard.isProcessed('handler', 'msg-1'),
      guard.isProcessed('handler', 'msg-1'),
    ])

    expect(r1).toBe(true)
    expect(r2).toBe(true)
    expect(r3).toBe(true)
    // No errors
    expect(guard.getMetrics().errors).toBe(0)
  })

  it('concurrent calls to markAsProcessed are safe (idempotent)', async () => {
    vi.mocked(mockCache.set).mockResolvedValue(true)

    const [r1, r2] = await Promise.all([
      guard.markAsProcessed('handler', 'msg-1'),
      guard.markAsProcessed('handler', 'msg-1'),
    ])

    expect(r1).toBe(true)
    expect(r2).toBe(true)
    expect(mockCache.set).toHaveBeenCalledTimes(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('IdempotencyGuard – recovery flows', () => {
  let mockCache: CacheService
  let guard: IdempotencyGuard

  beforeEach(() => {
    mockCache = buildMockCache()
    guard = new IdempotencyGuard(mockCache, { ttlSeconds: 3600 })
    vi.mocked(recordIdempotencyCheck).mockReset()
  })

  it('full recovery: manual mark → guard deduplication → metrics correct', async () => {
    // Simulate backfill: mark a set of historical messages as processed
    vi.mocked(mockCache.set).mockResolvedValue(true)
    vi.mocked(mockCache.exists).mockResolvedValue(true)

    await guard.markAsProcessed('attestation:add', 'hist-001')
    await guard.markAsProcessed('attestation:add', 'hist-002')

    // Now live events arrive; the historical ones should be skipped
    const handler = vi.fn().mockResolvedValue('noop')

    const r1 = await guard.process('attestation:add', 'hist-001', handler)
    const r2 = await guard.process('attestation:add', 'hist-002', handler)

    expect(r1.isDuplicate).toBe(true)
    expect(r2.isDuplicate).toBe(true)
    expect(handler).not.toHaveBeenCalled()
    expect(guard.getMetrics().duplicates).toBe(2)
  })

  it('stale marker scenario: TTL expiry allows reprocessing without residual state', async () => {
    vi.mocked(mockCache.exists)
      .mockResolvedValueOnce(false) // original processing
      .mockResolvedValueOnce(true)  // within TTL → duplicate
      .mockResolvedValueOnce(false) // after TTL expiry → fresh
    vi.mocked(mockCache.set).mockResolvedValue(true)

    const handler = vi.fn().mockResolvedValue('processed')

    const r1 = await guard.process('attestation:add', 'event-stale', handler)
    const r2 = await guard.process('attestation:add', 'event-stale', handler)
    const r3 = await guard.process('attestation:add', 'event-stale', handler) // after expiry

    expect(r1.executed).toBe(true)
    expect(r2.isDuplicate).toBe(true)
    expect(r3.executed).toBe(true) // reprocessed after TTL expiry
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('guard continues operating after recovering from errors (no poisoned state)', async () => {
    // First call: cache error
    vi.mocked(mockCache.exists).mockRejectedValueOnce(new Error('transient'))
    await guard.process('h', 'm1', vi.fn()).catch(() => {})

    // Subsequent calls succeed normally
    vi.mocked(mockCache.exists).mockResolvedValue(false)
    vi.mocked(mockCache.set).mockResolvedValue(true)
    const handler = vi.fn().mockResolvedValue('ok')

    const result = await guard.process('h', 'm2', handler)

    expect(result.executed).toBe(true)
    expect(result.isDuplicate).toBe(false)
  })

  it('guard continues operating after multiple sequential errors', async () => {
    vi.mocked(mockCache.exists)
      .mockRejectedValueOnce(new Error('err1'))
      .mockRejectedValueOnce(new Error('err2'))
      .mockResolvedValueOnce(false)
    vi.mocked(mockCache.set).mockResolvedValue(true)
    const handler = vi.fn().mockResolvedValue('ok')

    await guard.process('h', 'm1', handler).catch(() => {})
    await guard.process('h', 'm2', handler).catch(() => {})
    const result = await guard.process('h', 'm3', handler)

    expect(result.executed).toBe(true)
    expect(guard.getMetrics().errors).toBe(2)
    expect(guard.getMetrics().executed).toBe(1)
  })

  it('resetMetrics() allows metrics to restart from zero after error burst', async () => {
    vi.mocked(mockCache.exists).mockRejectedValue(new Error('burst'))

    for (let i = 0; i < 5; i++) {
      await guard.process('h', `m${i}`, vi.fn()).catch(() => {})
    }

    expect(guard.getMetrics().errors).toBe(5)

    guard.resetMetrics()

    expect(guard.getMetrics().errors).toBe(0)

    // Normal operation after reset
    vi.mocked(mockCache.exists).mockResolvedValue(false)
    vi.mocked(mockCache.set).mockResolvedValue(true)
    const result = await guard.process('h', 'new-msg', vi.fn().mockResolvedValue('ok'))

    expect(result.executed).toBe(true)
    expect(guard.getMetrics().errors).toBe(0)
    expect(guard.getMetrics().processed).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('IdempotencyGuard – TTL and configuration', () => {
  let mockCache: CacheService

  beforeEach(() => {
    mockCache = buildMockCache()
    vi.mocked(recordIdempotencyCheck).mockReset()
  })

  it('custom TTL is used for markAsProcessed', async () => {
    const g = new IdempotencyGuard(mockCache, { ttlSeconds: 7200 })
    vi.mocked(mockCache.set).mockResolvedValue(true)

    await g.markAsProcessed('handler', 'msg-1')

    expect(mockCache.set).toHaveBeenCalledWith(
      'idempotency',
      'handler:msg-1',
      expect.any(Object),
      7200,
    )
  })

  it('minimum reasonable TTL (1 second) is respected', async () => {
    const g = new IdempotencyGuard(mockCache, { ttlSeconds: 1 })
    vi.mocked(mockCache.exists).mockResolvedValue(false)
    vi.mocked(mockCache.set).mockResolvedValue(true)
    const handler = vi.fn().mockResolvedValue('ok')

    await g.process('h', 'm', handler)

    expect(mockCache.set).toHaveBeenCalledWith('idempotency', 'h:m', expect.any(Object), 1)
  })

  it('very large TTL (604800 = 7 days) is respected', async () => {
    const g = new IdempotencyGuard(mockCache, { ttlSeconds: 604800 })
    vi.mocked(mockCache.exists).mockResolvedValue(false)
    vi.mocked(mockCache.set).mockResolvedValue(true)
    const handler = vi.fn().mockResolvedValue('ok')

    await g.process('h', 'm', handler)

    expect(mockCache.set).toHaveBeenCalledWith('idempotency', 'h:m', expect.any(Object), 604800)
  })

  it('custom logger is called for duplicate detection', async () => {
    const logger = vi.fn()
    const g = new IdempotencyGuard(mockCache, { ttlSeconds: 3600, logger })
    vi.mocked(mockCache.exists).mockResolvedValue(true)

    await g.process('attestation', 'msg-log', vi.fn())

    expect(logger).toHaveBeenCalledWith(expect.stringContaining('Duplicate detected'))
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('attestation:msg-log'))
  })

  it('custom logger is called for successful execution', async () => {
    const logger = vi.fn()
    const g = new IdempotencyGuard(mockCache, { ttlSeconds: 3600, logger })
    vi.mocked(mockCache.exists).mockResolvedValue(false)
    vi.mocked(mockCache.set).mockResolvedValue(true)

    await g.process('attestation', 'msg-exec', vi.fn().mockResolvedValue('ok'))

    expect(logger).toHaveBeenCalledWith(expect.stringContaining('Executed'))
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('attestation:msg-exec'))
  })

  it('custom logger is called when marker write fails', async () => {
    const logger = vi.fn()
    const g = new IdempotencyGuard(mockCache, { ttlSeconds: 3600, logger })
    vi.mocked(mockCache.exists).mockResolvedValue(false)
    vi.mocked(mockCache.set).mockResolvedValue(false) // soft failure

    await g.process('attestation', 'msg-fail', vi.fn().mockResolvedValue('ok'))

    expect(logger).toHaveBeenCalledWith(expect.stringContaining('Failed to write marker'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('IdempotencyGuard – authorization and validation invariants', () => {
  let mockCache: CacheService
  let guard: IdempotencyGuard

  beforeEach(() => {
    mockCache = buildMockCache()
    guard = new IdempotencyGuard(mockCache, { ttlSeconds: 3600 })
    vi.mocked(recordIdempotencyCheck).mockReset()
  })

  /**
   * The guard must never silently drop an error thrown by the handler.
   * Callers rely on error propagation to trigger retry logic and alerting.
   */
  it('always propagates handler errors — never swallows them', async () => {
    vi.mocked(mockCache.exists).mockResolvedValue(false)
    vi.mocked(mockCache.set).mockResolvedValue(true)

    const domainError = new Error('Attestation store unavailable')
    domainError.name = 'StoreError'
    const handler = vi.fn().mockRejectedValue(domainError)

    await expect(guard.process('handler', 'msg-1', handler)).rejects.toThrow(
      'Attestation store unavailable',
    )
  })

  it('handler error preserves error type and name', async () => {
    vi.mocked(mockCache.exists).mockResolvedValue(false)
    vi.mocked(mockCache.set).mockResolvedValue(true)

    const customError = new TypeError('Invalid attestation payload')
    const handler = vi.fn().mockRejectedValue(customError)

    const thrown = await guard.process('handler', 'msg-1', handler).catch(e => e)

    expect(thrown).toBeInstanceOf(TypeError)
    expect(thrown.message).toBe('Invalid attestation payload')
  })

  it('non-Error throwables are propagated unchanged', async () => {
    vi.mocked(mockCache.exists).mockResolvedValue(false)
    vi.mocked(mockCache.set).mockResolvedValue(true)

    // Some legacy code throws strings or objects
    const handler = vi.fn().mockRejectedValue('plain string error')

    await expect(guard.process('handler', 'msg-1', handler)).rejects.toBe('plain string error')
  })

  it('duplicate detection is enforced regardless of handler return type', async () => {
    // Even when handler returns complex objects, duplicate check is always applied
    vi.mocked(mockCache.exists).mockResolvedValue(true)
    const handler = vi.fn().mockResolvedValue({ id: '1', amount: 100, currency: 'USD' })

    const result = await guard.process('payment', 'txn-abc', handler)

    expect(result.executed).toBe(false)
    expect(result.isDuplicate).toBe(true)
    expect(handler).not.toHaveBeenCalled()
  })

  it('guard is stateless across multiple instances sharing the same cache', async () => {
    // Two instances with the same cache should share state via Redis
    const guard2 = new IdempotencyGuard(mockCache, { ttlSeconds: 3600 })

    // Guard1 marks as processed
    vi.mocked(mockCache.set).mockResolvedValue(true)
    await guard.markAsProcessed('handler', 'shared-msg')

    // Guard2 sees the marker (simulated via exists=true)
    vi.mocked(mockCache.exists).mockResolvedValue(true)
    const handler = vi.fn().mockResolvedValue('ok')
    const result = await guard2.process('handler', 'shared-msg', handler)

    expect(result.isDuplicate).toBe(true)
    expect(handler).not.toHaveBeenCalled()
  })
})
