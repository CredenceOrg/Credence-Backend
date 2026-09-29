import type { DependencyHealth, HealthProbe } from '../services/health/types.js'

/**
 * Optional in-process cache wrapper for any {@link HealthProbe}.
 *
 * High-frequency monitors (Kubernetes, load-balancer health checks,
 * uptime dashboards) often scrape `/api/health` every few seconds.  A
 * naive probe runs DB / Redis / circuit-breaker queries each time,
 * which is wasteful when the state is stable.
 *
 * `withProbeCache`:
 *  • serves a cached `DependencyHealth` for `ttlMs` milliseconds,
 *  • **coalesces concurrent calls** while a probe is in flight so a
 *    thundering herd only triggers one downstream query,
 *  • is a no-op wrapper when `ttlMs` is `0` (caller wants fresh data).
 *
 * On TTL expiry the wrapper serves the stale value while kicking off a
 * fresh probe in the background (stale-while-revalidate).  If the fresh
 * probe rejects, the cache is cleared so the next call retries.
 *
 * Tests can clear the cache between runs by calling the returned
 * `clear()` to avoid state leakage across suites.
 */
export function withProbeCache(probe: HealthProbe, ttlMs: number): HealthProbe & { clear: () => void } {
  let cachedPromise: Promise<DependencyHealth> | null = null
  let cachedAt = 0

  const wrapped: HealthProbe & { clear: () => void } = async () => {
    if (ttlMs <= 0) return probe()

    const now = Date.now()
    if (cachedPromise && now - cachedAt < ttlMs) {
      return cachedPromise
    }

    if (!cachedPromise) {
      // Cold start — coalesce concurrent callers onto a single probe.
      cachedPromise = probe()
      // Discard the returned promise; the .then handlers below update the
      // shared `cachedPromise` / `cachedAt` for subsequent callers.
      cachedPromise.then(
        (result) => {
          cachedPromise = Promise.resolve(result)
          cachedAt = Date.now()
        },
        () => {
          // Don't cache the rejection — clear so the next call retries.
          cachedPromise = null
          cachedAt = 0
        },
      )
      return cachedPromise
    }

    // Stale-while-revalidate: serve the stale value, refresh in background.
    const stale = cachedPromise
    const fresh = probe()
    fresh.then(
      (result) => {
        cachedPromise = Promise.resolve(result)
        cachedAt = Date.now()
      },
      () => {
        // Don't cache the rejection — clear so the next call retries.
        cachedPromise = null
        cachedAt = 0
      },
    )
    return stale
  }

  wrapped.clear = () => {
    cachedPromise = null
    cachedAt = 0
  }

  return wrapped
}