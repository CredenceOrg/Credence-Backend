/**
 * Cache invalidation hooks for deterministic post-operation cache clearing.
 *
 * Provides a hook-based system that ensures cache invalidation runs after
 * domain operations such as profile updates, trust-score recalculation,
 * and backfill jobs — preventing stale values from leaking to clients.
 *
 * @example
 * ```typescript
 * import { profileInvalidationHook } from '../cache/invalidationHooks.js'
 *
 * // After updating a member's role
 * await memberRepository.updateRole(memberId, newRole)
 * await profileInvalidationHook.execute(orgId, memberId)
 * ```
 */

import { invalidateCache, invalidateMultiple, createCacheKey } from './invalidation.js'
import { logger } from '../utils/logger.js'
import { Counter } from 'prom-client'
import { register } from '../middleware/metrics.js'

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export const invalidationHookExecutionsTotal = new Counter({
  name: 'invalidation_hook_executions_total',
  help: 'Total number of cache invalidation hook executions',
  labelNames: ['hook_name', 'status'],
  registers: [register],
})

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InvalidationHookResult {
  name: string
  keysAttempted: number
  keysInvalidated: number
  durationMs: number
  error?: string
}

/**
 * A cache invalidation hook that runs after a domain operation.
 */
export interface InvalidationHook {
  /** Unique name for observability and metrics. */
  readonly name: string
  /**
   * Execute the invalidation. Accepts contextual args so the hook can
   * derive the cache keys that need clearing.
   */
  execute(...args: unknown[]): Promise<InvalidationHookResult>
}

/**
 * Options for creating a cache invalidation hook.
 */
export interface InvalidationHookOptions {
  /** Whether to enable stale-read verification (default: false). */
  verify?: boolean
  /** Descriptive label for logs. */
  label?: string
}

// ---------------------------------------------------------------------------
// Hook factory
// ---------------------------------------------------------------------------

/**
 * Create a cache invalidation hook that clears one or more keys within a
 * namespace after an operation completes.
 *
 * @param name       - Unique hook name (used in metrics & logs).
 * @param namespace  - Cache namespace (e.g. `'trust'`, `'member'`).
 * @param keyExtractor - Function that derives cache keys from the operation args.
 * @param options    - Optional invalidation behaviour flags.
 */
export function createCacheInvalidationHook(
  name: string,
  namespace: string,
  keyExtractor: (...args: unknown[]) => (string | string[]),
  options: InvalidationHookOptions = {},
): InvalidationHook {
  const { verify = false, label } = options
  const displayName = label ?? name

  return {
    name,

    async execute(...args: unknown[]): Promise<InvalidationHookResult> {
      const startMs = Date.now()

      try {
        const keysOrNested = keyExtractor(...args)
        const keys: string[] = Array.isArray(keysOrNested)
          ? keysOrNested.flatMap((k) => (Array.isArray(k) ? k : [k]))
          : [keysOrNested]

        if (keys.length === 0) {
          logger.debug(`[InvalidationHook:${displayName}] No keys to invalidate`)
          const dur = Date.now() - startMs
          return { name, keysAttempted: 0, keysInvalidated: 0, durationMs: dur }
        }

        const results = await Promise.allSettled(
          keys.map((key) => invalidateCache(namespace, key, undefined, { verify })),
        )

        let succeeded = 0
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value) succeeded++
        }

        const durationMs = Date.now() - startMs
        invalidationHookExecutionsTotal.inc({ hook_name: name, status: 'success' })

        logger.debug(
          `[InvalidationHook:${displayName}] Invalidated ${succeeded}/${keys.length} keys in ${durationMs}ms (ns:${namespace})`,
        )

        return { name, keysAttempted: keys.length, keysInvalidated: succeeded, durationMs }
      } catch (error) {
        const durationMs = Date.now() - startMs
        const errorMsg = error instanceof Error ? error.message : String(error)
        invalidationHookExecutionsTotal.inc({ hook_name: name, status: 'error' })
        logger.error(
          `[InvalidationHook:${displayName}] Failed after ${durationMs}ms: ${errorMsg}`,
        )
        return { name, keysAttempted: 0, keysInvalidated: 0, durationMs, error: errorMsg }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

/**
 * Run multiple invalidation hooks in parallel and aggregate results.
 *
 * @param hooks - Hooks to execute.
 * @param args  - Arguments forwarded to every hook's `execute()`.
 */
export async function composeInvalidationHooks(
  hooks: InvalidationHook[],
  ...args: unknown[]
): Promise<InvalidationHookResult[]> {
  return Promise.all(hooks.map((h) => h.execute(...args)))
}

// ---------------------------------------------------------------------------
// Pre-defined hooks
// ---------------------------------------------------------------------------

// ── Profile / Member hooks ────────────────────────────────────────────────

/**
 * Invalidates the org-members list cache after a member mutation.
 * Key pattern: `member:org:{orgId}:members`
 */
export const orgMembersListInvalidationHook = createCacheInvalidationHook(
  'member.org_members_list.invalidate',
  'member',
  (orgId: unknown) => {
    if (typeof orgId !== 'string') return []
    return [createCacheKey('org', orgId, 'members')]
  },
  { label: 'org-members-list' },
)

/**
 * Invalidates the individual member cache after a member mutation.
 * Key pattern: `member:id:{memberId}`
 */
export const memberByIdInvalidationHook = createCacheInvalidationHook(
  'member.by_id.invalidate',
  'member',
  (memberId: unknown) => {
    if (typeof memberId !== 'string') return []
    return [createCacheKey('id', memberId)]
  },
  { label: 'member-by-id' },
)

/**
 * Composite hook that invalidates all profile-related caches after a
 * profile update (role change, delete, restore, invite).
 */
export const profileInvalidationHook: InvalidationHook = {
  name: 'profile.invalidate',

  async execute(...args: unknown[]): Promise<InvalidationHookResult> {
    const [orgId, memberId] = args as [string, string]
    // Each hook receives only the arg it needs — composeInvalidationHooks
    // passes all positional args to every hook, so we call them individually.
    const results = await Promise.all([
      orgMembersListInvalidationHook.execute(orgId),
      memberByIdInvalidationHook.execute(memberId),
    ])

    // Aggregate into a single result
    const totalKeysAttempted = results.reduce((s, r) => s + r.keysAttempted, 0)
    const totalKeysInvalidated = results.reduce((s, r) => s + r.keysInvalidated, 0)
    const maxDuration = Math.max(...results.map((r) => r.durationMs))
    const errors = results.filter((r) => r.error).map((r) => r.error!)

    return {
      name: 'profile.invalidate',
      keysAttempted: totalKeysAttempted,
      keysInvalidated: totalKeysInvalidated,
      durationMs: maxDuration,
      ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
    }
  },
}

// ── Trust-score hooks ─────────────────────────────────────────────────────

/**
 * Invalidates the trust score cache for one or more addresses after a
 * trust-score recalculation.
 * Key pattern: `trust:{addressLowerCase}`
 */
export const trustScoreInvalidationHook = createCacheInvalidationHook(
  'trust_score.invalidate',
  'trust',
  (...addresses: unknown[]) => {
    const normalized = addresses
      .filter((a): a is string => typeof a === 'string')
      .map((a) => a.toLowerCase())
    return normalized.length > 0 ? normalized : []
  },
  { label: 'trust-score' },
)

// ── Backfill / Bulk-operation hooks ───────────────────────────────────────

/**
 * Invalidates verification-related caches after a backfill or bulk
 * verification job completes.
 * Key patterns:
 *   - `bulk:job:{jobId}` — job metadata
 *   - `bulk:org:{orgId}:results` — cached result lists per org
 */
export const bulkVerificationInvalidationHook = createCacheInvalidationHook(
  'bulk_verification.invalidate',
  'bulk',
  (jobId: unknown, orgId: unknown) => {
    const keys: string[] = []
    if (typeof jobId === 'string') keys.push(createCacheKey('job', jobId))
    if (typeof orgId === 'string') keys.push(createCacheKey('org', orgId, 'results'))
    return keys
  },
  { label: 'bulk-verification' },
)

// ── General-purpose / catch-all ───────────────────────────────────────────

/**
 * Invalidates all caches for a given set of (namespace, key) pairs.
 * Useful for ad-hoc operations that don't fit a predefined pattern.
 */
export const genericInvalidationHook = createCacheInvalidationHook(
  'generic.invalidate',
  '',   // namespace is overridden per call
  (...entries: unknown[]) => {
    // entries is an array of [namespace, key] tuples
    return entries.filter((e): e is string => typeof e === 'string')
  },
  { label: 'generic' },
)
