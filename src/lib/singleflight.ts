/**
 * SingleFlight — coalesces concurrent async calls for the same key so that only
 * one underlying operation runs at a time.  All callers waiting on the same key
 * share a single result (or error).
 *
 * This is the classic "cache stampede" prevention pattern, also known as
 * request coalescing or thundering-herd protection.
 *
 * @example
 * ```ts
 * import { singleflight } from './lib/singleflight.js'
 *
 * const result = await singleflight.do('my-key', async () => {
 *   return await expensiveFetch()
 * })
 * ```
 */

interface PendingCall<T> {
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

export class SingleFlight {
  /** In-flight calls keyed by the user-supplied deduplication key. */
  private readonly inFlight = new Map<string, PendingCall<unknown>[]>()

  /**
   * Execute `fn` under the SingleFlight guarantee: if another call with the
   * same `key` is already in-flight, this call will wait for that result
   * instead of running `fn` again.
   *
   * After `fn` settles (success or failure) the key is evicted so a subsequent
   * call with the same key will attempt a fresh `fn` invocation.
   */
  async do<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key)
    if (existing) {
      // Another call is already in-flight for this key — piggyback on it.
      return new Promise<T>((resolve, reject) => {
        // We push untyped callbacks into the same array; they are drained
        // below with a cast that is guaranteed to match the call-site type.
        existing.push({ resolve, reject } as PendingCall<unknown>)
      })
    }

    // First caller — start tracking.
    const waiters: PendingCall<unknown>[] = []
    this.inFlight.set(key, waiters)

    try {
      const result = await fn()

      // Resolve every waiter with the same value.
      for (const w of waiters) {
        w.resolve(result as unknown)
      }

      return result
    } catch (error) {
      // Reject every waiter with the same error.
      for (const w of waiters) {
        w.reject(error)
      }
      throw error
    } finally {
      // Always clean up so future calls start fresh.
      this.inFlight.delete(key)
    }
  }

  /**
   * Returns `true` if a call for `key` is currently in-flight.
   * Useful for diagnostics and metrics.
   */
  has(key: string): boolean {
    return this.inFlight.has(key)
  }

  /**
   * Returns the number of distinct keys currently being fetched.
   * Useful for diagnostics and metrics.
   */
  get size(): number {
    return this.inFlight.size
  }
}

/** Global singleton — import this wherever stampede protection is needed. */
export const singleflight = new SingleFlight()
