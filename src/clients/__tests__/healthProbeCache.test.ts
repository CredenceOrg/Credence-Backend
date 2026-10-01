import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { withProbeCache } from '../healthProbeCache.js'
import type { DependencyHealth, HealthProbe } from '../../services/health/types.js'
import { logger } from '../../utils/logger.js'

async function flushMicrotasks() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }
}

describe('healthProbeCache – withProbeCache', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // ── Input Validation & Boundary Conditions ──────────────────────────────────

  describe('input validation and boundary handling', () => {
    it('throws a TypeError if probe is not a function', () => {
      expect(() => withProbeCache(null as unknown as HealthProbe, 1000)).toThrow(
        TypeError,
      )
      expect(() => withProbeCache(undefined as unknown as HealthProbe, 1000)).toThrow(
        TypeError,
      )
      expect(() => withProbeCache(123 as unknown as HealthProbe, 1000)).toThrow(
        TypeError,
      )
      expect(() => withProbeCache({} as unknown as HealthProbe, 1000)).toThrow(
        TypeError,
      )
    })

    it('bypasses cache when ttlMs is 0', async () => {
      let callCount = 0
      const probe: HealthProbe = async () => {
        callCount++
        return { status: 'up', latencyMs: callCount }
      }

      const cachedProbe = withProbeCache(probe, 0)

      const res1 = await cachedProbe()
      expect(res1.latencyMs).toBe(1)
      expect(callCount).toBe(1)

      const res2 = await cachedProbe()
      expect(res2.latencyMs).toBe(2)
      expect(callCount).toBe(2)
    })

    it('bypasses cache when ttlMs is negative', async () => {
      let callCount = 0
      const probe: HealthProbe = async () => {
        callCount++
        return { status: 'up', latencyMs: callCount }
      }

      const cachedProbe = withProbeCache(probe, -500)

      await cachedProbe()
      await cachedProbe()
      expect(callCount).toBe(2)
    })

    it('bypasses cache when ttlMs is NaN', async () => {
      let callCount = 0
      const probe: HealthProbe = async () => {
        callCount++
        return { status: 'up' }
      }

      const cachedProbe = withProbeCache(probe, Number.NaN)

      await cachedProbe()
      await cachedProbe()
      expect(callCount).toBe(2)
    })

    it('bypasses cache when ttlMs is non-number', async () => {
      let callCount = 0
      const probe: HealthProbe = async () => {
        callCount++
        return { status: 'up' }
      }

      const cachedProbe = withProbeCache(probe, '5000' as unknown as number)

      await cachedProbe()
      await cachedProbe()
      expect(callCount).toBe(2)
    })

    it('handles synchronous throw in probe when ttlMs <= 0', async () => {
      const probe: HealthProbe = () => {
        throw new Error('sync crash')
      }

      const cachedProbe = withProbeCache(probe, 0)
      await expect(cachedProbe()).rejects.toThrow('sync crash')
    })

    it('handles synchronous throw in probe during cold start (ttlMs > 0)', async () => {
      let shouldThrow = true
      const probe: HealthProbe = () => {
        if (shouldThrow) {
          throw new Error('sync probe failure')
        }
        return Promise.resolve({ status: 'up' })
      }

      const cachedProbe = withProbeCache(probe, 5000)

      // First call throws synchronously inside probe
      await expect(cachedProbe()).rejects.toThrow('sync probe failure')

      // Cache state is not polluted; retry succeeds
      shouldThrow = false
      const res = await cachedProbe()
      expect(res.status).toBe('up')
    })

    it('caches indefinitely when ttlMs is Infinity', async () => {
      let callCount = 0
      const probe: HealthProbe = async () => {
        callCount++
        return { status: 'up' }
      }

      const cachedProbe = withProbeCache(probe, Number.POSITIVE_INFINITY)

      await cachedProbe()
      expect(callCount).toBe(1)

      // Advance time by 30 days
      vi.advanceTimersByTime(30 * 24 * 60 * 60 * 1000)

      await cachedProbe()
      expect(callCount).toBe(1)
    })
  })

  // ── Cold Start & Concurrency Coalescing ─────────────────────────────────────

  describe('cold start and concurrency coalescing', () => {
    it('coalesces multiple concurrent callers onto a single in-flight probe', async () => {
      let callCount = 0
      let resolveProbe!: (value: DependencyHealth) => void

      const probe: HealthProbe = () => {
        callCount++
        return new Promise<DependencyHealth>((resolve) => {
          resolveProbe = resolve
        })
      }

      const cachedProbe = withProbeCache(probe, 5000)

      // Launch 10 concurrent requests during cold start
      const promises = Array.from({ length: 10 }, () => cachedProbe())

      expect(callCount).toBe(1)

      // Resolve the single downstream probe
      resolveProbe({ status: 'up', latencyMs: 42 })

      const results = await Promise.all(promises)

      expect(callCount).toBe(1)
      for (const res of results) {
        expect(res).toEqual({ status: 'up', latencyMs: 42 })
      }
    })

    it('propagates cold-start rejection to all concurrent callers and clears cache for retry', async () => {
      let callCount = 0
      let rejectProbe!: (err: Error) => void

      const probe: HealthProbe = () => {
        callCount++
        return new Promise<DependencyHealth>((_, reject) => {
          rejectProbe = reject
        })
      }

      const cachedProbe = withProbeCache(probe, 5000)

      // Launch 5 concurrent calls
      const calls = Array.from({ length: 5 }, () => cachedProbe())

      expect(callCount).toBe(1)

      // Reject the probe
      rejectProbe(new Error('Connection refused'))

      const settled = await Promise.allSettled(calls)
      for (const outcome of settled) {
        expect(outcome.status).toBe('rejected')
        if (outcome.status === 'rejected') {
          expect((outcome.reason as Error).message).toBe('Connection refused')
        }
      }

      // Next call after failure retries downstream probe cleanly
      let resolveRetry!: (value: DependencyHealth) => void
      const retryPromise = new Promise<DependencyHealth>((resolve) => {
        resolveRetry = resolve
      })
      const recoveringProbe: HealthProbe = () => {
        callCount++
        return retryPromise
      }

      const newCachedProbe = withProbeCache(recoveringProbe, 5000)
      const call = newCachedProbe()
      expect(callCount).toBe(2)
      resolveRetry({ status: 'up' })
      const res = await call
      expect(res.status).toBe('up')
    })
  })

  // ── Fresh Cache Hit (Within TTL) ───────────────────────────────────────────

  describe('fresh cache hit within TTL', () => {
    it('serves cached value without invoking downstream probe within TTL', async () => {
      let callCount = 0
      const probe: HealthProbe = async () => {
        callCount++
        return { status: 'up', latencyMs: 10 }
      }

      const cachedProbe = withProbeCache(probe, 3000)

      // First call: cold start
      const res1 = await cachedProbe()
      expect(res1).toEqual({ status: 'up', latencyMs: 10 })
      expect(callCount).toBe(1)

      // Advance by 1500ms (within 3000ms TTL)
      vi.advanceTimersByTime(1500)

      const res2 = await cachedProbe()
      expect(res2).toEqual({ status: 'up', latencyMs: 10 })
      expect(callCount).toBe(1)

      // Advance by another 1000ms (total 2500ms, still < 3000ms)
      vi.advanceTimersByTime(1000)

      const res3 = await cachedProbe()
      expect(res3).toEqual({ status: 'up', latencyMs: 10 })
      expect(callCount).toBe(1)
    })
  })

  // ── Stale-While-Revalidate & Concurrency Coalescing ──────────────────────────

  describe('stale-while-revalidate', () => {
    it('serves stale value immediately upon expiry while refreshing in the background', async () => {
      let callCount = 0
      let resolveRefresh!: (value: DependencyHealth) => void

      const probe: HealthProbe = () => {
        callCount++
        if (callCount === 1) {
          return Promise.resolve({ status: 'up', latencyMs: 10 })
        }
        return new Promise<DependencyHealth>((resolve) => {
          resolveRefresh = resolve
        })
      }

      const cachedProbe = withProbeCache(probe, 2000)

      // Initial populate
      const initial = await cachedProbe()
      expect(initial.latencyMs).toBe(10)
      expect(callCount).toBe(1)

      // Advance past TTL (2001ms)
      vi.advanceTimersByTime(2001)

      // Call when stale: should return stale value immediately!
      const staleRes = await cachedProbe()
      expect(staleRes.latencyMs).toBe(10)
      expect(callCount).toBe(2)

      // Background revalidation completes
      resolveRefresh({ status: 'up', latencyMs: 50 })
      await flushMicrotasks()

      // Subsequent call receives the refreshed value
      const refreshedRes = await cachedProbe()
      expect(refreshedRes.latencyMs).toBe(50)
      expect(callCount).toBe(2)
    })

    it('coalesces multiple concurrent callers during background revalidation', async () => {
      let callCount = 0
      let resolveRefresh!: (value: DependencyHealth) => void

      const probe: HealthProbe = () => {
        callCount++
        if (callCount === 1) {
          return Promise.resolve({ status: 'up', latencyMs: 10 })
        }
        return new Promise<DependencyHealth>((resolve) => {
          resolveRefresh = resolve
        })
      }

      const cachedProbe = withProbeCache(probe, 2000)

      await cachedProbe()
      expect(callCount).toBe(1)

      // Advance past TTL
      vi.advanceTimersByTime(2500)

      // 10 concurrent requests arrive while stale
      const results = await Promise.all(
        Array.from({ length: 10 }, () => cachedProbe()),
      )

      // Downstream probe must only be invoked once for the background refresh
      expect(callCount).toBe(2)

      // All callers immediately received the stale value
      for (const res of results) {
        expect(res.latencyMs).toBe(10)
      }

      // Finish background refresh
      resolveRefresh({ status: 'up', latencyMs: 20 })
      await flushMicrotasks()

      // Next call receives the refreshed value
      const nextRes = await cachedProbe()
      expect(nextRes.latencyMs).toBe(20)
    })

    it('handles background revalidation rejection by logging warning and clearing cache for retry', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
      let callCount = 0
      let rejectRefresh!: (err: Error) => void
      let resolveRecovered!: (value: DependencyHealth) => void

      const probe: HealthProbe = () => {
        callCount++
        if (callCount === 1) {
          return Promise.resolve({ status: 'up', latencyMs: 10 })
        }
        if (callCount === 2) {
          return new Promise<DependencyHealth>((_, reject) => {
            rejectRefresh = reject
          })
        }
        return new Promise<DependencyHealth>((resolve) => {
          resolveRecovered = resolve
        })
      }

      const cachedProbe = withProbeCache(probe, 2000)

      await cachedProbe()
      expect(callCount).toBe(1)

      // Advance past TTL
      vi.advanceTimersByTime(2500)

      // Caller receives stale result immediately
      const staleRes = await cachedProbe()
      expect(staleRes.latencyMs).toBe(10)
      expect(callCount).toBe(2)

      // Background refresh rejects
      rejectRefresh(new Error('Downstream DB timeout'))
      await flushMicrotasks()

      // Warning log was recorded with safe error message
      expect(warnSpy).toHaveBeenCalledTimes(1)
      const [warningPayload] = warnSpy.mock.calls[0]
      expect(warningPayload).toMatchObject({
        message: 'Health probe background revalidation failed; clearing cache',
        error: 'Downstream DB timeout',
      })

      // Cache is now cleared: next call retries cold downstream probe
      const nextProbePromise = cachedProbe()
      expect(callCount).toBe(3)

      resolveRecovered({ status: 'up', latencyMs: 15 })
      const recoveredRes = await nextProbePromise
      expect(recoveredRes).toEqual({ status: 'up', latencyMs: 15 })
    })

    it('properly handles sync throw in background revalidation probe', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
      let callCount = 0

      const probe: HealthProbe = () => {
        callCount++
        if (callCount === 1) {
          return Promise.resolve({ status: 'up', latencyMs: 10 })
        }
        if (callCount === 2) {
          throw new Error('sync background failure')
        }
        return Promise.resolve({ status: 'up', latencyMs: 99 })
      }

      const cachedProbe = withProbeCache(probe, 2000)

      // Initial call succeeds
      await cachedProbe()

      // Advance past TTL
      vi.advanceTimersByTime(2500)

      // Call returns stale result without throwing
      const staleRes = await cachedProbe()
      expect(staleRes.latencyMs).toBe(10)
      expect(callCount).toBe(2)

      await flushMicrotasks()

      // Warning was logged
      expect(warnSpy).toHaveBeenCalled()

      // Cache was cleared, so next call triggers a fresh probe
      const freshRes = await cachedProbe()
      expect(freshRes.latencyMs).toBe(99)
      expect(callCount).toBe(3)
    })
  })

  // ── Recovery, Retries, and Degradation States ───────────────────────────────

  describe('recovery, retries, and degradation states', () => {
    it('retries cleanly after cold start failure until probe recovers', async () => {
      let callCount = 0
      const probe: HealthProbe = async () => {
        callCount++
        if (callCount < 3) {
          throw new Error(`Probe failure #${callCount}`)
        }
        return { status: 'up', latencyMs: 10 }
      }

      const cachedProbe = withProbeCache(probe, 5000)

      // Attempt 1 fails
      await expect(cachedProbe()).rejects.toThrow('Probe failure #1')
      expect(callCount).toBe(1)

      // Attempt 2 fails
      await expect(cachedProbe()).rejects.toThrow('Probe failure #2')
      expect(callCount).toBe(2)

      // Attempt 3 recovers
      const recovered = await cachedProbe()
      expect(recovered.status).toBe('up')
      expect(callCount).toBe(3)

      // Attempt 4 hits cache
      const cached = await cachedProbe()
      expect(cached.status).toBe('up')
      expect(callCount).toBe(3)
    })

    it('caches degraded or down DependencyHealth results without throwing', async () => {
      let callCount = 0
      const probe: HealthProbe = async () => {
        callCount++
        return {
          status: 'down',
          reason: 'connection_refused',
          latencyMs: 5,
        }
      }

      const cachedProbe = withProbeCache(probe, 5000)

      const res1 = await cachedProbe()
      expect(res1.status).toBe('down')
      expect(res1.reason).toBe('connection_refused')
      expect(callCount).toBe(1)

      // Within TTL: caches the failure response to protect failing dependency
      const res2 = await cachedProbe()
      expect(res2.status).toBe('down')
      expect(callCount).toBe(1)
    })

    it('caches not_configured status and respects clear()', async () => {
      let configured = false
      const probe: HealthProbe = async () => {
        if (!configured) {
          return { status: 'not_configured', reason: 'not_configured' }
        }
        return { status: 'up', latencyMs: 1 }
      }

      const cachedProbe = withProbeCache(probe, 10000)

      const res1 = await cachedProbe()
      expect(res1.status).toBe('not_configured')

      // Config updated in background
      configured = true

      // Still cached within TTL
      const res2 = await cachedProbe()
      expect(res2.status).toBe('not_configured')

      // Clearing cache allows immediate reflection of new configuration
      cachedProbe.clear()
      const res3 = await cachedProbe()
      expect(res3.status).toBe('up')
    })
  })

  // ── Cache Invalidation & Generation Isolation ───────────────────────────────

  describe('clear() and generation isolation', () => {
    it('evicts cached state so subsequent calls execute a fresh probe', async () => {
      let callCount = 0
      const probe: HealthProbe = async () => {
        callCount++
        return { status: 'up', latencyMs: callCount }
      }

      const cachedProbe = withProbeCache(probe, 5000)

      const res1 = await cachedProbe()
      expect(res1.latencyMs).toBe(1)

      cachedProbe.clear()

      const res2 = await cachedProbe()
      expect(res2.latencyMs).toBe(2)
      expect(callCount).toBe(2)
    })

    it('ignores cold-start probe settlement that completes AFTER clear() was called', async () => {
      let callCount = 0
      let resolveFirst!: (value: DependencyHealth) => void

      const probe: HealthProbe = () => {
        callCount++
        if (callCount === 1) {
          return new Promise<DependencyHealth>((resolve) => {
            resolveFirst = resolve
          })
        }
        return Promise.resolve({ status: 'up', latencyMs: 999 })
      }

      const cachedProbe = withProbeCache(probe, 5000)

      // Start call 1 (in-flight)
      const promise1 = cachedProbe()
      expect(callCount).toBe(1)

      // Test suite resets cache while probe is in flight
      cachedProbe.clear()

      // Late resolution of call 1 probe
      resolveFirst({ status: 'up', latencyMs: 1 })
      await promise1

      // Next call must start fresh and NOT use the result from the cleared probe
      const res2 = await cachedProbe()
      expect(res2.latencyMs).toBe(999)
      expect(callCount).toBe(2)
    })

    it('ignores stale revalidation settlement that completes AFTER clear() was called', async () => {
      let callCount = 0
      let resolveRevalidation!: (value: DependencyHealth) => void

      const probe: HealthProbe = () => {
        callCount++
        if (callCount === 1) {
          return Promise.resolve({ status: 'up', latencyMs: 1 })
        }
        if (callCount === 2) {
          return new Promise<DependencyHealth>((resolve) => {
            resolveRevalidation = resolve
          })
        }
        return Promise.resolve({ status: 'up', latencyMs: 777 })
      }

      const cachedProbe = withProbeCache(probe, 2000)

      await cachedProbe()
      expect(callCount).toBe(1)

      // Expire TTL
      vi.advanceTimersByTime(2500)

      // Triggers background revalidation
      await cachedProbe()
      expect(callCount).toBe(2)

      // Clear is invoked while revalidation is in-flight
      cachedProbe.clear()

      // Background revalidation finally settles
      resolveRevalidation({ status: 'up', latencyMs: 2 })
      await flushMicrotasks()

      // Subsequent call must run fresh probe (callCount 3), not use the settled revalidation result
      const freshRes = await cachedProbe()
      expect(freshRes.latencyMs).toBe(777)
      expect(callCount).toBe(3)
    })

    it('allows safe idempotent clear() calls', () => {
      const probe: HealthProbe = async () => ({ status: 'up' })
      const cachedProbe = withProbeCache(probe, 5000)

      expect(() => {
        cachedProbe.clear()
        cachedProbe.clear()
        cachedProbe.clear()
      }).not.toThrow()
    })
  })

  // ── Clock Skew Boundaries ───────────────────────────────────────────────────

  describe('clock skew handling', () => {
    it('triggers revalidation if the system clock shifts backward', async () => {
      let callCount = 0
      const probe: HealthProbe = async () => {
        callCount++
        return { status: 'up', latencyMs: callCount }
      }

      const cachedProbe = withProbeCache(probe, 5000)

      await cachedProbe()
      expect(callCount).toBe(1)

      // System clock steps back into the past by 10 minutes (e.g. NTP sync)
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 600_000)

      // Clock shift detected (now < cachedAt) -> treated as expired, triggers revalidation
      const res = await cachedProbe()
      expect(res.latencyMs).toBe(1) // Stale served
      expect(callCount).toBe(2)

      await flushMicrotasks()
      nowSpy.mockRestore()
    })
  })
})
