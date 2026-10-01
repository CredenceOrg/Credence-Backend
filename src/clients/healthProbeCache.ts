import type { DependencyHealth, HealthProbe } from '../services/health/types.js'
import { logger } from '../utils/logger.js'

/**
 * Optional in-process cache wrapper for any {@link HealthProbe}.
 *
 * High-frequency monitors (Kubernetes, load-balancer health checks,
 * uptime dashboards) often scrape `/api/health` every few seconds. A
 * naive probe runs DB / Redis / circuit-breaker queries each time,
 * which is wasteful when the state is stable.
 *
 * `withProbeCache`:
 *  • serves a cached `DependencyHealth` for `ttlMs` milliseconds,
 *  • **coalesces concurrent calls** while a probe is in flight so a
 *    thundering herd only triggers one downstream query,
 *  • is a no-op wrapper when `ttlMs` is `0` or non-positive (caller wants fresh data).
 *
 * On TTL expiry the wrapper serves the stale value while kicking off a
 * fresh probe in the background (stale-while-revalidate). If the fresh
 * probe rejects, the cache is cleared so the next call retries.
 *
 * Invariants enforced:
 *  1. Cold-start coalescence: Concurrent callers while cold start is in flight
 *     share the same promise and trigger exactly one downstream probe.
 *  2. Revalidation coalescence: Concurrent callers while background revalidation
 *     is in flight all receive the stale value and trigger exactly one background probe.
 *  3. Retry safety: Probe rejections are never cached. Failures immediately clear
 *     in-flight state so subsequent callers can retry cleanly.
 *  4. Generation isolation: Invoking `clear()` invalidates any active in-flight
 *     probes so late resolutions do not resurrect cleared cache state.
 *  5. Error isolation: Background revalidation failures are logged as safe warnings
 *     and cannot cause unhandled promise rejections.
 *
 * Tests can clear the cache between runs by calling the returned
 * `clear()` to avoid state leakage across suites.
 */
export function withProbeCache(
  probe: HealthProbe,
  ttlMs: number,
): HealthProbe & { clear: () => void } {
  if (typeof probe !== 'function') {
    throw new TypeError('Expected probe to be a function')
  }

  let cachedPromise: Promise<DependencyHealth> | null = null
  let cachedAt = 0
  let inFlightPromise: Promise<DependencyHealth> | null = null
  let generation = 0

  const wrapped = (() => {
    // If TTL is 0 or non-positive / non-numeric, bypass cache entirely
    if (typeof ttlMs !== 'number' || Number.isNaN(ttlMs) || ttlMs <= 0) {
      try {
        return Promise.resolve(probe())
      } catch (err) {
        return Promise.reject(err)
      }
    }

    const now = Date.now()

    // 1. Fresh cache hit: cached value exists and TTL has not expired.
    // Also guard against clock stepping backward.
    if (cachedPromise && now - cachedAt < ttlMs && now >= cachedAt) {
      return cachedPromise
    }

    // 2. Cold start (or after eviction/clear): no cached value yet.
    if (!cachedPromise) {
      // Coalesce concurrent callers during cold start
      if (inFlightPromise) {
        return inFlightPromise
      }

      const currentGen = generation
      let p: Promise<DependencyHealth>
      try {
        p = Promise.resolve(probe())
      } catch (err) {
        p = Promise.reject(err)
      }

      inFlightPromise = p
      p.then(
        (result) => {
          if (currentGen === generation) {
            cachedPromise = Promise.resolve(result)
            cachedAt = Date.now()
            inFlightPromise = null
          }
        },
        () => {
          if (currentGen === generation) {
            // Don't cache the rejection — clear so the next call retries
            cachedPromise = null
            cachedAt = 0
            inFlightPromise = null
          }
        },
      )

      return p
    }

    // 3. Stale-while-revalidate: serve the stale value, refresh in background.
    const stale = cachedPromise

    // Coalesce background revalidation so thundering herd does not spawn duplicate probes
    if (!inFlightPromise) {
      const currentGen = generation
      let fresh: Promise<DependencyHealth>
      try {
        fresh = Promise.resolve(probe())
      } catch (err) {
        fresh = Promise.reject(err)
      }

      inFlightPromise = fresh
      fresh.then(
        (result) => {
          if (currentGen === generation) {
            cachedPromise = Promise.resolve(result)
            cachedAt = Date.now()
            inFlightPromise = null
          }
        },
        (err) => {
          if (currentGen === generation) {
            logger.warn({
              message: 'Health probe background revalidation failed; clearing cache',
              error: err instanceof Error ? err.message : String(err),
            })
            // Don't cache the rejection — clear so the next call retries
            cachedPromise = null
            cachedAt = 0
            inFlightPromise = null
          }
        },
      )
    }

    return stale
  }) as HealthProbe & { clear: () => void }

  wrapped.clear = () => {
    cachedPromise = null
    cachedAt = 0
    inFlightPromise = null
    generation++
  }

  return wrapped
}