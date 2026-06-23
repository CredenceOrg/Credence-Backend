/**
 * Generation-keyed cache invalidation for analytics summary responses.
 *
 * Rather than enumerating and deleting every cached summary key on each
 * refresh (keys vary by tenant and query string), every cache key embeds a
 * monotonically increasing "generation" token. Bumping the generation makes
 * all previously cached keys unreachable, so the next read misses and
 * repopulates under the new generation. This is an O(1) invalidation that
 * avoids cache-key enumeration.
 *
 * The counter is process-local. In a multi-replica deployment each replica
 * keeps its own generation; entries written by other replicas under an older
 * generation simply age out via their TTL. For coordinated cross-replica
 * invalidation, back this token with a shared store (e.g. Redis INCR).
 */

let generation = 0

/**
 * Return the current analytics cache generation token. Embed this in cache
 * keys so a generation bump transparently invalidates older entries.
 */
export function getAnalyticsCacheGeneration(): number {
  return generation
}

/**
 * Advance the analytics cache generation, invalidating all previously cached
 * summary responses. Call this whenever the underlying analytics data is
 * refreshed (e.g. from the analytics refresh worker).
 *
 * @returns The new generation token.
 */
export function bumpAnalyticsCacheGeneration(): number {
  generation += 1
  return generation
}

/**
 * Reset the generation counter to its initial value. Intended for tests that
 * need a deterministic starting generation.
 *
 * @internal
 */
export function _resetAnalyticsCacheGeneration(): void {
  generation = 0
}
