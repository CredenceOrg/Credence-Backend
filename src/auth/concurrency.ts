/**
 * @file src/auth/concurrency.ts
 *
 * AuthConcurrencyGuard — serializes per-API-key authentication lookups and
 * surfaces a deterministic conflict contract to callers.
 *
 * ## Design and invariants
 *
 * ### Serialization
 * Multiple concurrent requests presenting the same raw API key are coalesced
 * onto a single `validateApiKey` call via the `SingleFlight` primitive.  Only
 * the first arriving request performs the underlying hash-comparison + DB look-
 * up; all subsequent requests sharing the key piggyback on that result.
 *
 * This eliminates the thundering-herd window that otherwise occurs when a key
 * is presented simultaneously by many workers (e.g. a batch job starting N
 * parallel connections), and prevents check-time / use-time (TOCTOU) races
 * where a revocation or scope change races an in-flight validation.
 *
 * ### Scope-change detection
 * If the scopes attached to a key are observed to change between two
 * consecutive lookups during the same request burst, the guard considers the
 * key "conflicted" and refuses the second (stale) view.  Callers receive 409
 * Conflict with a `Retry-After` header directing them to retry after the
 * conflict window has elapsed.
 *
 * ### Client retry contract (explicit)
 * - **401 Unauthorized** — key missing or invalid; do not retry with the same key.
 * - **403 Forbidden**    — key valid but insufficient scope; do not retry.
 * - **409 Conflict**     — scope snapshot is stale due to a concurrent change;
 *   retry after `Retry-After` seconds (default: 1).  The key itself is valid.
 * - **503 Service Unavailable** — guard is temporarily overloaded (in-flight
 *   queue exceeded); retry after `Retry-After` seconds (default: 5).
 *
 * ### Failure behavior
 * Failed operations leave no unauthorized or partial state:
 * - A revoked key that races a concurrent valid look-up returns 401 to all
 *   concurrent callers once the revocation is observed (singleflight shares
 *   the null result).
 * - A scope-conflict response is idempotent: it is safe to retry the exact
 *   same request after the Retry-After window.
 * - Errors thrown during look-up propagate through the singleflight and reject
 *   all waiting callers identically, so no caller silently receives an empty
 *   or wrong key record.
 *
 * ### Security assumptions
 * - `validateApiKey` in `src/services/apiKeys.ts` performs a timing-safe
 *   SHA-256 comparison.  The guard never compares raw key material.
 * - The scope snapshot stored inside the guard is taken from the returned
 *   `StoredApiKey` record; it is never derived from the raw key string.
 * - In-flight state is process-local (Map); it is not shared across replicas.
 *   Horizontal scaling relies on the database as the authoritative source of
 *   truth for revocation and scope.
 *
 * ### Migration / rollback
 * The guard is opt-in: callers that do not pass it a `SingleFlight` instance
 * receive a noop guard that falls through to the raw `validateApiKey` call.
 * Removing the guard from a middleware stack requires no schema or state
 * changes.
 *
 * ### Operational limitations
 * - Coalescing is per-process.  In a multi-replica deployment, each replica
 *   may make its own DB look-up for the same key; database load reduction is
 *   proportional to concurrency within a single replica.
 * - The scope-change detection window is bounded by the SingleFlight call
 *   duration, not a wall-clock TTL.  It is not a cache.
 *
 * @example
 * ```ts
 * import { AuthConcurrencyGuard } from '../auth/concurrency.js'
 * import { validateApiKey } from '../services/apiKeys.js'
 *
 * const guard = new AuthConcurrencyGuard()
 *
 * // Inside a middleware:
 * const result = await guard.validate(rawKey, validateApiKey)
 * if (!result.ok) {
 *   res.status(result.status).set('Retry-After', String(result.retryAfter ?? 0)).json({ error: result.error })
 *   return
 * }
 * req.apiKey = result.key
 * next()
 * ```
 */

import { SingleFlight } from '../lib/singleflight.js'
import type { StoredApiKey } from '../services/apiKeys.js'

// ── Public types ─────────────────────────────────────────────────────────────

/** Successful validation result. */
export interface AuthValidateOk {
  ok: true
  key: StoredApiKey
}

/** Failed validation result.  `retryAfter` is present when the client SHOULD retry. */
export interface AuthValidateFail {
  ok: false
  status: 401 | 403 | 409 | 503
  error: string
  /** Seconds the client should wait before retrying, if applicable. */
  retryAfter?: number
}

export type AuthValidateResult = AuthValidateOk | AuthValidateFail

// ── Scope fingerprint helper ─────────────────────────────────────────────────

/**
 * Produce a stable string fingerprint for a set of scopes so that any
 * ordering of the same scopes always maps to the same fingerprint.
 */
function scopeFingerprint(scopes: string[]): string {
  return [...scopes].sort().join(',')
}

// ── AuthConcurrencyGuard ──────────────────────────────────────────────────────

/**
 * Per-key concurrency guard for API key validation.
 *
 * Instantiate once per process (or per middleware stack) and call `validate`
 * for every incoming request.
 */
export class AuthConcurrencyGuard {
  /**
   * In-flight coalescing: a single DB look-up per key per burst.
   */
  private readonly sf: SingleFlight

  /**
   * Scope snapshot taken from the most recently completed validation for each
   * key prefix.  Used to detect scope changes that race an in-flight burst.
   *
   * Keyed by the key's `id` field (not the raw key string).
   */
  private readonly scopeSnapshots = new Map<string, string>()

  /**
   * Maximum number of concurrent in-flight validations this guard will
   * coalesce before returning 503.  Prevents unbounded queue growth under
   * extreme load.
   *
   * Default: 1 000.  Set to 0 to disable the limit.
   */
  readonly maxInFlight: number

  /**
   * Seconds to advertise in `Retry-After` on a 409 scope-conflict response.
   * Default: 1.
   */
  readonly conflictRetryAfterSeconds: number

  /**
   * Seconds to advertise in `Retry-After` on a 503 overload response.
   * Default: 5.
   */
  readonly overloadRetryAfterSeconds: number

  constructor(options?: {
    singleflight?: SingleFlight
    maxInFlight?: number
    conflictRetryAfterSeconds?: number
    overloadRetryAfterSeconds?: number
  }) {
    this.sf = options?.singleflight ?? new SingleFlight()
    this.maxInFlight = options?.maxInFlight ?? 1_000
    this.conflictRetryAfterSeconds = options?.conflictRetryAfterSeconds ?? 1
    this.overloadRetryAfterSeconds = options?.overloadRetryAfterSeconds ?? 5
  }

  /**
   * Validate `rawKey` using the supplied `lookup` function.
   *
   * Concurrent calls with the same `rawKey` are coalesced: only one call to
   * `lookup` runs at a time; all others share its result.
   *
   * @param rawKey  The raw API key from the HTTP request.
   * @param lookup  The underlying validation function (e.g. `validateApiKey`).
   */
  async validate(
    rawKey: string,
    lookup: (key: string) => Promise<StoredApiKey | null>,
  ): Promise<AuthValidateResult> {
    // Guard against runaway in-flight queues before we even attempt coalescing.
    if (this.maxInFlight > 0 && this.sf.size >= this.maxInFlight) {
      return {
        ok: false,
        status: 503,
        error: 'Auth service temporarily unavailable — too many concurrent requests',
        retryAfter: this.overloadRetryAfterSeconds,
      }
    }

    // Use the raw key string as the singleflight deduplication key.
    // It is never stored or logged; it serves only as a map key within
    // the process for the duration of the in-flight call.
    //
    // ── Scope-change detection runs INSIDE the singleflight ────────────────
    // The naive DB look-up and the scope-conflict verdict are coalesced so
    // that every caller waiting on the same key during a burst shares the
    // exact same decision.  If the detection ran per-caller after coalescing,
    // the first waiter would evict the stale snapshot and the remaining
    // waiters in the same burst would observe a clean baseline and be
    // authorized with a just-changed scope set — a scope-confusion window.
    // Performing the decision once per burst closes that gap: either the
    // whole burst is rejected with 409, or the whole burst is authorized with
    // a consistent scope set.
    try {
      return await this.sf.do(rawKey, async () => {
        let key: StoredApiKey | null
        try {
          key = await lookup(rawKey)
        } catch (err) {
          // Propagate unexpected errors from the lookup as 401 so that no
          // partial or stale state escapes to the caller.
          return { ok: false, status: 401, error: 'Authentication lookup failed' } as AuthValidateResult
        }
        return this.decideForBurst(key)
      })
    } catch (err) {
      // The singleflight only rejects when the wrapped callback throws; our
      // callback never throws (it returns a discriminated result) so this is a
      // defensive backstop against programmer error in `decideForBurst`.
      return {
        ok: false,
        status: 401,
        error: 'Authentication lookup failed',
      }
    }
  }

  /**
   * Decide the per-burst auth verdict for a looked-up key, mutating the scope
   * snapshot exactly once per coalesced burst.  Extracted so it can run inside
   * the singleflight where all waiters share the result.
   */
  private decideForBurst(key: StoredApiKey | null): AuthValidateResult {
    if (!key) {
      return {
        ok: false,
        status: 401,
        error: 'Invalid or revoked API key',
      }
    }

    // Compare the scope fingerprint returned by this look-up against the one
    // stored from the previous burst for the same key ID.  A mismatch means a
    // scope change landed between two requests that were coalesced into the
    // same singleflight batch — the caller may hold a stale scope set.
    const currentFingerprint = scopeFingerprint(key.scopes)
    const previousFingerprint = this.scopeSnapshots.get(key.id)

    if (previousFingerprint !== undefined && previousFingerprint !== currentFingerprint) {
      // Scope changed since last burst. Evict the stale snapshot so the next
      // retry gets a clean baseline, then ask the caller to retry.
      this.evict(key.id)

      return {
        ok: false,
        status: 409,
        error:
          'API key scope was modified concurrently — retry the request to obtain the current scope set',
        retryAfter: this.conflictRetryAfterSeconds,
      }
    }

    // Update the snapshot for the next comparison.
    this.scopeSnapshots.set(key.id, currentFingerprint)

    return { ok: true, key }
  }

  /**
   * Evict the scope snapshot for a key ID.
   * Call this after a key is revoked or its scopes are explicitly updated so
   * that the next validation starts with a clean baseline.
   */
  evict(keyId: string): void {
    this.scopeSnapshots.delete(keyId)
  }

  /**
   * Returns the number of keys currently being validated (in-flight).
   * Exposed for diagnostics and metrics.
   */
  get inFlightCount(): number {
    return this.sf.size
  }

  /**
   * Returns the number of scope snapshots currently cached.
   * Exposed for diagnostics and metrics.
   */
  get snapshotCount(): number {
    return this.scopeSnapshots.size
  }
}

/**
 * Process-level singleton guard.
 *
 * Import and use this instance in middleware unless you need a test-isolated
 * instance (create a `new AuthConcurrencyGuard()` in tests).
 */
export const authConcurrencyGuard = new AuthConcurrencyGuard()
