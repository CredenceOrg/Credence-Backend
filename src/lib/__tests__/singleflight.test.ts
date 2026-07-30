/**
 * Tests for SingleFlight stampede guard.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SingleFlight } from '../singleflight.js'

describe('SingleFlight', () => {
  let sf: SingleFlight

  beforeEach(() => {
    sf = new SingleFlight()
  })

  it('executes the function when no concurrent call exists', async () => {
    const fn = vi.fn().mockResolvedValue('result')
    const out = await sf.do('key', fn)
    expect(out).toBe('result')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent calls for the same key into a single origin call', async () => {
    let callCount = 0
    const fn = vi.fn().mockImplementation(
      () =>
        new Promise<string>((resolve) =>
          setTimeout(() => {
            callCount++
            resolve('shared')
          }, 50),
        ),
    )

    const [r1, r2, r3] = await Promise.all([
      sf.do('same-key', fn),
      sf.do('same-key', fn),
      sf.do('same-key', fn),
    ])

    expect(r1).toBe('shared')
    expect(r2).toBe('shared')
    expect(r3).toBe('shared')
    // Only one actual call to fn despite three concurrent requests.
    expect(callCount).toBe(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('propagates errors to all waiters', async () => {
    const error = new Error('boom')
    const fn = vi.fn().mockRejectedValue(error)

    const results = await Promise.allSettled([
      sf.do('fail-key', fn),
      sf.do('fail-key', fn),
      sf.do('fail-key', fn),
    ])

    for (const r of results) {
      expect(r.status).toBe('rejected')
      if (r.status === 'rejected') {
        expect(r.reason).toBe(error)
      }
    }
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('allows a fresh call after a previous one completes', async () => {
    const fn = vi.fn().mockResolvedValue('first')
    await sf.do('seq', fn)
    expect(fn).toHaveBeenCalledTimes(1)

    // Second call after completion should run fn again.
    fn.mockResolvedValue('second')
    const out = await sf.do('seq', fn)
    expect(out).toBe('second')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('allows a fresh call after a previous one errors', async () => {
    const fn = vi.fn()
    fn.mockRejectedValueOnce(new Error('ephemeral'))
    fn.mockResolvedValueOnce('recovered')

    await expect(sf.do('retry', fn)).rejects.toThrow('ephemeral')
    expect(fn).toHaveBeenCalledTimes(1)

    // Next call should attempt the origin again.
    const out = await sf.do('retry', fn)
    expect(out).toBe('recovered')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('does not coalesce calls for different keys', async () => {
    const fn1 = vi.fn().mockResolvedValue('a')
    const fn2 = vi.fn().mockResolvedValue('b')

    const [r1, r2] = await Promise.all([
      sf.do('key-a', fn1),
      sf.do('key-b', fn2),
    ])

    expect(r1).toBe('a')
    expect(r2).toBe('b')
    expect(fn1).toHaveBeenCalledTimes(1)
    expect(fn2).toHaveBeenCalledTimes(1)
  })

  it('reports has() and size() correctly', () => {
    expect(sf.has('absent')).toBe(false)
    expect(sf.size).toBe(0)

    // Start a long-running call and check in-flight state.
    sf.do('long', () => new Promise(() => {})) // never settles
    expect(sf.has('long')).toBe(true)
    expect(sf.size).toBe(1)
  })
})

describe('getOrFetch stampede guard pattern', () => {
  /**
   * Standalone test of the getOrFetch pattern without Redis dependency.
   * Uses SingleFlight + a plain Map as a stand-in for the cache layer.
   */
  const store = new Map<string, any>()

  // Simulates the getOrFetch pattern used in CacheService.
  async function getOrFetch<T>(
    key: string,
    fetchFn: () => Promise<T>,
  ): Promise<T> {
    // Fast path — cache hit.
    if (store.has(key)) return store.get(key)

    return sf.do(`getorfetch:${key}`, async () => {
      // Double-check cache after acquiring singleflight slot.
      if (store.has(key)) return store.get(key)

      const fresh = await fetchFn()
      store.set(key, fresh)
      return fresh
    })
  }

  let sf: SingleFlight

  beforeEach(() => {
    store.clear()
    sf = new SingleFlight()
  })

  it('fetches from origin on cache miss and caches the result', async () => {
    const fetchFn = vi.fn().mockResolvedValue('computed')

    const result = await getOrFetch('my-key', fetchFn)

    expect(result).toBe('computed')
    expect(fetchFn).toHaveBeenCalledTimes(1)
    // Result should be cached.
    expect(store.get('my-key')).toBe('computed')
  })

  it('returns cached value on cache hit without calling origin', async () => {
    store.set('hit', 'stale')
    const fetchFn = vi.fn().mockResolvedValue('fresh')

    const result = await getOrFetch('hit', fetchFn)

    expect(result).toBe('stale')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('deduplicates concurrent cache misses', async () => {
    let callCount = 0
    const fetchFn = vi.fn().mockImplementation(
      () =>
        new Promise<string>((resolve) =>
          setTimeout(() => {
            callCount++
            resolve('shared')
          }, 50),
        ),
    )

    const [r1, r2] = await Promise.all([
      getOrFetch('concurrent-key', fetchFn),
      getOrFetch('concurrent-key', fetchFn),
    ])

    expect(r1).toBe('shared')
    expect(r2).toBe('shared')
    expect(callCount).toBe(1)
  })

  it('allows a fresh fetch after a previous one completes', async () => {
    const fetchFn = vi.fn()
    fetchFn.mockResolvedValueOnce('first')
    fetchFn.mockResolvedValueOnce('second')

    const first = await getOrFetch('seq', fetchFn)
    expect(first).toBe('first')

    const second = await getOrFetch('seq', fetchFn)
    // Should use cached value, not fetch again.
    expect(second).toBe('first')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})
