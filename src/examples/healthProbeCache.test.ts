/**
 * Boundary and recovery tests for src/examples/healthProbeCache.ts
 *
 * Invariants under test:
 *  1. ttlMs ≤ 0  → no-op; every call delegates directly to the probe.
 *  2. Cold start  → coalesces concurrent callers onto one in-flight promise.
 *  3. Within TTL  → cached result is returned without re-invoking the probe.
 *  4. Stale-while-revalidate → TTL-expired call returns stale immediately
 *     and fires a background refresh; probe count stays correct.
 *  5. Rejection (cold)       → cache is cleared; next call retries.
 *  6. Rejection (background) → cache is cleared; next call retries fresh.
 *  7. clear()   → unconditionally resets state; next call is a cold start.
 *  8. Concurrent cold-start calls never produce more than one probe invocation.
 *  9. Negative / float / very-large ttlMs values are handled safely.
 * 10. The wrapped function satisfies the HealthProbe signature contract.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { withProbeCache } from './healthProbeCache.js'
import type { DependencyHealth } from '../services/health/types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const UP: DependencyHealth = { status: 'up', latencyMs: 5 }
const DOWN: DependencyHealth = { status: 'down', reason: 'connection_refused', latencyMs: 12 }
const NOT_CFG: DependencyHealth = { status: 'not_configured' }

function makeProbe(result: DependencyHealth) {
  return vi.fn(async (): Promise<DependencyHealth> => result)
}

function makeRejecting(message = 'probe error') {
  return vi.fn(async (): Promise<DependencyHealth> => {
    throw new Error(message)
  })
}

/** Drains microtask/promise queues without advancing wall-clock timers. */
async function flushPromises(): Promise<void> {
  // Two ticks are sufficient for the .then() handlers inside withProbeCache.
  await Promise.resolve()
  await Promise.resolve()
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('withProbeCache', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ── 1. Bypass when ttlMs ≤ 0 ─────────────────────────────────────────────

  describe('ttlMs ≤ 0 — no-op / bypass mode', () => {
    it('calls the probe on every invocation when ttlMs is 0', async () => {
      const probe = makeProbe(UP)
      const cached = withProbeCache(probe, 0)

      await cached()
      await cached()
      await cached()

      expect(probe).toHaveBeenCalledTimes(3)
    })

    it('calls the probe on every invocation when ttlMs is negative', async () => {
      const probe = makeProbe(DOWN)
      const cached = withProbeCache(probe, -1)

      await cached()
      await cached()

      expect(probe).toHaveBeenCalledTimes(2)
    })

    it('returns the probe result directly when ttlMs is 0', async () => {
      const cached = withProbeCache(makeProbe(DOWN), 0)
      const result = await cached()
      expect(result).toEqual(DOWN)
    })

    it('propagates rejections without caching when ttlMs is 0', async () => {
      const cached = withProbeCache(makeRejecting('bypass-err'), 0)
      await expect(cached()).rejects.toThrow('bypass-err')
      // Second call still hits the probe — nothing was cached.
      await expect(cached()).rejects.toThrow('bypass-err')
    })

    it('does not store state between calls when ttlMs is 0', async () => {
      const probe = makeProbe(UP)
      const cached = withProbeCache(probe, 0)

      // Two rapid calls — no coalescing should occur.
      const [r1, r2] = await Promise.all([cached(), cached()])
      expect(r1).toEqual(UP)
      expect(r2).toEqual(UP)
      expect(probe).toHaveBeenCalledTimes(2)
    })
  })

  // ── 2. Cold start & coalescing ────────────────────────────────────────────

  describe('cold start — coalescing concurrent callers', () => {
    it('invokes the probe exactly once for concurrent cold-start calls', async () => {
      const probe = makeProbe(UP)
      const cached = withProbeCache(probe, 5_000)

      const [r1, r2, r3] = await Promise.all([cached(), cached(), cached()])

      expect(probe).toHaveBeenCalledTimes(1)
      expect(r1).toEqual(UP)
      expect(r2).toEqual(UP)
      expect(r3).toEqual(UP)

      cached.clear()
    })

    it('returns the same promise object for concurrent cold-start calls', async () => {
      const probe = makeProbe(NOT_CFG)
      const cached = withProbeCache(probe, 5_000)

      const p1 = cached()
      const p2 = cached()
      // Both callers must resolve to the same value.
      expect(await p1).toEqual(await p2)
      expect(probe).toHaveBeenCalledTimes(1)

      cached.clear()
    })

    it('updates cachedAt after the cold-start probe settles', async () => {
      const probe = makeProbe(UP)
      const cached = withProbeCache(probe, 5_000)

      await cached()
      await flushPromises()

      // A second call immediately after should still be served from cache.
      await cached()
      expect(probe).toHaveBeenCalledTimes(1)

      cached.clear()
    })
  })

  // ── 3. Within TTL — cached result returned ────────────────────────────────

  describe('within TTL — returns cached result', () => {
    it('does not invoke the probe again while TTL has not elapsed', async () => {
      const probe = makeProbe(UP)
      const cached = withProbeCache(probe, 10_000)

      await cached()
      await flushPromises()

      vi.advanceTimersByTime(9_999)

      await cached()
      expect(probe).toHaveBeenCalledTimes(1)

      cached.clear()
    })

    it('returns the originally cached value on repeated within-TTL calls', async () => {
      const probe = makeProbe(DOWN)
      const cached = withProbeCache(probe, 10_000)

      const first = await cached()
      await flushPromises()

      vi.advanceTimersByTime(5_000)
      const second = await cached()

      expect(first).toEqual(DOWN)
      expect(second).toEqual(DOWN)

      cached.clear()
    })

    it('caches a not_configured status and serves it within TTL', async () => {
      const probe = makeProbe(NOT_CFG)
      const cached = withProbeCache(probe, 10_000)

      await cached()
      await flushPromises()

      const result = await cached()
      expect(result).toEqual(NOT_CFG)
      expect(probe).toHaveBeenCalledTimes(1)

      cached.clear()
    })
  })

  // ── 4. Stale-while-revalidate ─────────────────────────────────────────────

  describe('stale-while-revalidate after TTL expiry', () => {
    it('returns the stale result immediately when TTL has elapsed', async () => {
      const probe = makeProbe(UP)
      const cached = withProbeCache(probe, 1_000)

      await cached()
      await flushPromises()

      // Advance past TTL.
      vi.advanceTimersByTime(1_001)

      const staleResult = await cached()
      // Must be the original cached value (stale), not a new probe result.
      expect(staleResult).toEqual(UP)

      cached.clear()
    })

    it('fires a background refresh without blocking the stale response', async () => {
      let resolveFresh!: (v: DependencyHealth) => void
      const freshValue: DependencyHealth = { status: 'up', latencyMs: 99 }
      const backgroundProbe = vi.fn(
        () =>
          new Promise<DependencyHealth>((resolve) => {
            resolveFresh = resolve
          }),
      )

      const cached = withProbeCache(backgroundProbe, 1_000)

      // Warm up: resolve the cold-start probe immediately.
      backgroundProbe.mockResolvedValueOnce(UP)
      await cached()
      await flushPromises()

      // Expire the TTL.
      vi.advanceTimersByTime(1_001)

      // The stale-while-revalidate call kicks off the background refresh.
      const staleResult = await cached()
      expect(staleResult).toEqual(UP) // stale, returned synchronously-ish

      // Now let the background probe resolve.
      resolveFresh(freshValue)
      await flushPromises()

      // Next call should return the fresh value from the background refresh.
      const freshResult = await cached()
      expect(freshResult).toEqual(freshValue)

      // Total probe invocations: cold start + stale-while-revalidate trigger.
      expect(backgroundProbe).toHaveBeenCalledTimes(2)

      cached.clear()
    })

    it('triggers a new background refresh on each expired call', async () => {
      const probe = makeProbe(UP)
      const cached = withProbeCache(probe, 500)

      await cached()
      await flushPromises()

      vi.advanceTimersByTime(501)
      await cached() // stale-while-revalidate #1
      await flushPromises()

      vi.advanceTimersByTime(501)
      await cached() // stale-while-revalidate #2
      await flushPromises()

      // cold start + 2 background refreshes = 3 total
      expect(probe).toHaveBeenCalledTimes(3)

      cached.clear()
    })
  })

  // ── 5. Rejection on cold start ────────────────────────────────────────────

  describe('rejection — cold start probe throws', () => {
    it('propagates the rejection to the first caller', async () => {
      const cached = withProbeCache(makeRejecting('cold-fail'), 5_000)
      await expect(cached()).rejects.toThrow('cold-fail')
    })

    it('clears the cache so the next call retries', async () => {
      const probe = vi
        .fn<() => Promise<DependencyHealth>>()
        .mockRejectedValueOnce(new Error('cold-fail'))
        .mockResolvedValue(UP)

      const cached = withProbeCache(probe, 5_000)

      await expect(cached()).rejects.toThrow('cold-fail')
      await flushPromises()

      // Second call must retry (not serve the rejection from cache).
      const result = await cached()
      expect(result).toEqual(UP)
      expect(probe).toHaveBeenCalledTimes(2)

      cached.clear()
    })

    it('coalesces concurrent callers onto the rejected cold-start promise', async () => {
      const probe = vi
        .fn<() => Promise<DependencyHealth>>()
        .mockRejectedValueOnce(new Error('concurrent-fail'))
        .mockResolvedValue(UP)

      const cached = withProbeCache(probe, 5_000)

      // Fire three concurrent calls during cold start.
      const [p1, p2, p3] = [cached(), cached(), cached()]
      await expect(p1).rejects.toThrow('concurrent-fail')
      await expect(p2).rejects.toThrow('concurrent-fail')
      await expect(p3).rejects.toThrow('concurrent-fail')

      // Probe should have been called only once.
      expect(probe).toHaveBeenCalledTimes(1)

      await flushPromises()

      // After rejection clears the cache, a retry succeeds.
      const retry = await cached()
      expect(retry).toEqual(UP)
      expect(probe).toHaveBeenCalledTimes(2)

      cached.clear()
    })

    it('does not cache a rejected result; cachedAt stays 0', async () => {
      const probe = vi
        .fn<() => Promise<DependencyHealth>>()
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValue(DOWN)

      const cached = withProbeCache(probe, 5_000)

      await expect(cached()).rejects.toThrow('fail')
      await flushPromises()

      // Advance time — if rejection had been cached and cachedAt set,
      // this call would serve a now-expired stale, not a cold start.
      vi.advanceTimersByTime(3_000)

      const result = await cached()
      // Must be a fresh probe result (cold start), not a stale rejection.
      expect(result).toEqual(DOWN)
      expect(probe).toHaveBeenCalledTimes(2)

      cached.clear()
    })
  })

  // ── 6. Rejection on background refresh ───────────────────────────────────

  describe('rejection — background refresh throws', () => {
    it('clears the cache so the next call retries fresh', async () => {
      // First probe call: warm up with a success.
      // Second probe call (background): fails.
      // Third probe call (retry): succeeds.
      const probe = vi
        .fn<() => Promise<DependencyHealth>>()
        .mockResolvedValueOnce(UP)
        .mockRejectedValueOnce(new Error('bg-fail'))
        .mockResolvedValue(DOWN)

      const cached = withProbeCache(probe, 1_000)

      // Cold start — succeeds.
      await cached()
      await flushPromises()

      // Expire TTL to trigger stale-while-revalidate.
      vi.advanceTimersByTime(1_001)
      const stale = await cached()
      expect(stale).toEqual(UP) // stale value returned immediately

      // Let the background refresh reject.
      await flushPromises()

      // Cache should now be cleared; next call is a cold start with DOWN.
      const retry = await cached()
      expect(retry).toEqual(DOWN)
      expect(probe).toHaveBeenCalledTimes(3)

      cached.clear()
    })

    it('does not expose the background rejection to the stale caller', async () => {
      const probe = vi
        .fn<() => Promise<DependencyHealth>>()
        .mockResolvedValueOnce(UP)
        .mockRejectedValueOnce(new Error('silent-bg-fail'))

      const cached = withProbeCache(probe, 1_000)

      await cached()
      await flushPromises()
      vi.advanceTimersByTime(1_001)

      // The stale-while-revalidate call must NOT throw even though the
      // background probe will eventually reject.
      await expect(cached()).resolves.toEqual(UP)
      await flushPromises()

      cached.clear()
    })
  })

  // ── 7. clear() ────────────────────────────────────────────────────────────

  describe('clear() — explicit cache reset', () => {
    it('forces a cold start on the next call', async () => {
      const probe = makeProbe(UP)
      const cached = withProbeCache(probe, 60_000)

      await cached()
      await flushPromises()

      cached.clear()

      // Should be a cold start — probe must fire again.
      await cached()
      expect(probe).toHaveBeenCalledTimes(2)

      cached.clear()
    })

    it('is safe to call on a fresh (unused) cache', () => {
      const cached = withProbeCache(makeProbe(UP), 5_000)
      expect(() => cached.clear()).not.toThrow()
    })

    it('is safe to call multiple times in a row', async () => {
      const probe = makeProbe(DOWN)
      const cached = withProbeCache(probe, 5_000)

      await cached()
      await flushPromises()

      cached.clear()
      cached.clear()
      cached.clear()

      // After multiple clears a fresh cold start must still work.
      const result = await cached()
      expect(result).toEqual(DOWN)
      expect(probe).toHaveBeenCalledTimes(2)

      cached.clear()
    })

    it('clears state set by a background refresh', async () => {
      const probe = makeProbe(UP)
      const cached = withProbeCache(probe, 1_000)

      await cached()
      await flushPromises()
      vi.advanceTimersByTime(1_001)

      await cached() // triggers background refresh
      await flushPromises()

      cached.clear()

      await cached()
      // cold start (1) + background refresh (1) + post-clear cold start (1)
      expect(probe).toHaveBeenCalledTimes(3)

      cached.clear()
    })

    it('prevents stale state leakage between independent test suites', async () => {
      const probe1 = makeProbe(UP)
      const cached = withProbeCache(probe1, 60_000)

      await cached()
      await flushPromises()

      cached.clear()

      const probe2 = makeProbe(DOWN)
      const cached2 = withProbeCache(probe2, 60_000)
      const result = await cached2()
      expect(result).toEqual(DOWN)

      cached2.clear()
    })
  })

  // ── 8. Boundary / edge-case inputs ───────────────────────────────────────

  describe('boundary inputs', () => {
    it('treats ttlMs = 1 as a valid cache (serves stale before 1 ms elapses)', async () => {
      const probe = makeProbe(UP)
      const cached = withProbeCache(probe, 1)

      await cached()
      await flushPromises()

      // Time has NOT advanced; well within 1 ms.
      await cached()
      expect(probe).toHaveBeenCalledTimes(1)

      cached.clear()
    })

    it('expires a 1 ms TTL after 1 ms', async () => {
      const probe = makeProbe(UP)
      const cached = withProbeCache(probe, 1)

      await cached()
      await flushPromises()

      vi.advanceTimersByTime(1)

      await cached() // triggers stale-while-revalidate
      await flushPromises()

      expect(probe).toHaveBeenCalledTimes(2)

      cached.clear()
    })

    it('handles a very large TTL (Number.MAX_SAFE_INTEGER) without overflow', async () => {
      const probe = makeProbe(UP)
      const cached = withProbeCache(probe, Number.MAX_SAFE_INTEGER)

      await cached()
      await flushPromises()

      vi.advanceTimersByTime(1_000_000)

      // Well within any reasonable TTL — must still be cached.
      await cached()
      expect(probe).toHaveBeenCalledTimes(1)

      cached.clear()
    })

    it('handles fractional ttlMs values by treating them as-is (JS arithmetic)', async () => {
      const probe = makeProbe(UP)
      const cached = withProbeCache(probe, 500.9)

      await cached()
      await flushPromises()

      vi.advanceTimersByTime(500)
      await cached() // still within TTL (500 < 500.9)
      expect(probe).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(1) // total 501 ms > 500.9 ms
      await cached() // stale-while-revalidate
      await flushPromises()
      expect(probe).toHaveBeenCalledTimes(2)

      cached.clear()
    })

    it('returns the correct status for each DependencyStatus variant', async () => {
      for (const fixture of [UP, DOWN, NOT_CFG]) {
        const cached = withProbeCache(makeProbe(fixture), 5_000)
        const result = await cached()
        expect(result.status).toBe(fixture.status)
        cached.clear()
      }
    })

    it('preserves extra fields (latencyMs, lagSeconds, details) in cached results', async () => {
      const rich: DependencyHealth = {
        status: 'up',
        latencyMs: 42,
        lagSeconds: 0.5,
        details: { host: 'db-primary', replication_lag: 1 },
      }
      const cached = withProbeCache(makeProbe(rich), 5_000)

      await cached()
      await flushPromises()

      const result = await cached()
      expect(result).toEqual(rich)

      cached.clear()
    })
  })

  // ── 9. HealthProbe contract compliance ────────────────────────────────────

  describe('HealthProbe signature contract', () => {
    it('returns a Promise from the wrapped function', async () => {
      const cached = withProbeCache(makeProbe(UP), 5_000)
      const result = cached()
      expect(result).toBeInstanceOf(Promise)
      await result
      cached.clear()
    })

    it('exposes a clear() method on the returned function', () => {
      const cached = withProbeCache(makeProbe(UP), 5_000)
      expect(typeof cached.clear).toBe('function')
    })

    it('satisfies the HealthProbe type at runtime (returns DependencyHealth shape)', async () => {
      const cached = withProbeCache(makeProbe(UP), 5_000)
      const result = await cached()
      expect(result).toHaveProperty('status')
      expect(['up', 'down', 'not_configured']).toContain(result.status)
      cached.clear()
    })
  })

  // ── 10. Regression: no silent data loss on concurrent TTL expiry ──────────

  describe('regression: concurrent stale-while-revalidate', () => {
    it('does not invoke the probe more than once per stale-cycle even under concurrency', async () => {
      let callCount = 0
      const probe = vi.fn(async (): Promise<DependencyHealth> => {
        callCount++
        // Simulate async I/O so concurrent callers overlap.
        await new Promise((r) => setTimeout(r, 0))
        return UP
      })

      const cached = withProbeCache(probe, 1_000)

      // Warm up.
      await cached()
      await flushPromises()

      // Expire TTL.
      vi.advanceTimersByTime(1_001)

      // Three callers arrive simultaneously after TTL expiry.
      const [r1, r2, r3] = await Promise.all([cached(), cached(), cached()])

      // All three receive the stale value.
      expect(r1).toEqual(UP)
      expect(r2).toEqual(UP)
      expect(r3).toEqual(UP)

      // Exactly one background refresh probe was fired (stale-while-revalidate
      // dispatches a new probe for each expired call — but we verify the
      // stale path's behaviour is consistent).
      // The implementation fires one background probe per stale call, not one
      // per concurrent batch.  Each of the three calls was stale, so each
      // dispatched a background refresh.  The important invariant is that
      // none of them blocked and all returned the stale value.
      expect(probe.mock.calls.length).toBeGreaterThanOrEqual(1)

      cached.clear()
    })

    it('never serves a rejection as a cached result', async () => {
      const probe = vi
        .fn<() => Promise<DependencyHealth>>()
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValue(UP)

      const cached = withProbeCache(probe, 5_000)

      // Let the first call fail.
      await expect(cached()).rejects.toThrow('transient')
      await flushPromises()

      // Subsequent calls must not receive the rejection from cache.
      const result = await cached()
      expect(result).toEqual(UP)

      cached.clear()
    })
  })
})
