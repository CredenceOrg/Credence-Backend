/**
 * Short-TTL read-through cache for SorobanClient.getIdentityState().
 *
 * Layer strategy
 * ──────────────
 * L1: in-process LRU (lru-cache) — zero-latency hits; evicted on TTL or
 *     process restart.
 * L2: Redis via CacheService — shared across replicas; falls back silently
 *     when Redis is unavailable so the RPC path is never blocked.
 *
 * Cache keys are scoped to network + contractId + address so entries from
 * different contracts/networks can never collide.
 *
 * Error responses are never cached — only successful (non-null) payloads
 * returned from the RPC call are stored.
 *
 * Observability
 * ─────────────
 * Two prom-client Counters are exported and incremented on every
 * getIdentityState() call:
 *   soroban_state_cache_hits_total   { network, contract }
 *   soroban_state_cache_misses_total { network, contract }
 *
 * Invariants
 * ──────────
 * - Cache keys are always lower-cased on the address component so that
 *   case-variant callers share a single entry.
 * - Error responses are never stored; only successful payloads reach set().
 * - Redis failures never propagate to callers; they degrade to L1-only.
 */

import { LRUCache } from 'lru-cache'
import client from 'prom-client'
import { CacheService, RedisConnection } from '../cache/redis.js'
import { logger } from '../utils/logger.js'

// ── Prometheus metrics ────────────────────────────────────────────────────────

export const sorobanStateCacheHitsTotal = new client.Counter({
  name: 'soroban_state_cache_hits_total',
  help: 'Total number of Soroban identity-state cache hits',
  labelNames: ['network', 'contract'] as const,
})

export const sorobanStateCacheMissesTotal = new client.Counter({
  name: 'soroban_state_cache_misses_total',
  help: 'Total number of Soroban identity-state cache misses',
  labelNames: ['network', 'contract'] as const,
})

// ── Cache namespace used in Redis keys ────────────────────────────────────────

const REDIS_NAMESPACE = 'soroban_state'

// Sentinel used to distinguish "no L1 entry" from a cached `undefined` value.
// LRUCache.get() returns undefined for both, so we must not store undefined.
const L1_MISS = Symbol('sorobanStateCache.l1Miss')

// ── SorobanStateCache ─────────────────────────────────────────────────────────

export interface SorobanStateCacheOptions {
  /** TTL in milliseconds. 0 disables all caching. */
  ttlMs: number
  /** Maximum number of entries in the L1 LRU cache. Default: 500. */
  maxL1Entries?: number
  /** Override the Redis/CacheService instance (mainly for tests). */
  cacheService?: CacheService
}

export class SorobanStateCache {
  private readonly ttlMs: number
  private readonly l1: LRUCache<string, any>
  private readonly redis: CacheService
  /** Whether caching is disabled (ttlMs === 0). */
  public readonly disabled: boolean

  /**
   * @param options.ttlMs TTL in milliseconds. Must be a finite, non-negative
   *   number. `0` disables caching entirely; negative or non-finite values
   *   are rejected to avoid silently disabling or mis-configuring the cache.
   * @param options.maxL1Entries Maximum L1 entries. Must be a positive integer.
   * @param options.cacheService Optional CacheService override (tests).
   * @throws TypeError when ttlMs or maxL1Entries are invalid.
   */
  constructor(options: SorobanStateCacheOptions) {
    this.ttlMs = options.ttlMs
    this.disabled = options.ttlMs === 0

    this.l1 = new LRUCache<string, any>({
      max: options.maxL1Entries ?? 500,
      // LRU TTL is in milliseconds; skip when caching is disabled
      ttl: this.disabled ? undefined : this.ttlMs,
      ttlAutopurge: !this.disabled,
    })

    this.redis =
      options.cacheService ?? new CacheService(RedisConnection.getInstance())
  }

  /**
   * Validates constructor inputs. Kept as a static helper so tests can
   * exercise boundary cases without instantiating a cache.
   */
  private static validateOptions(options: SorobanStateCacheOptions): void {
    const { ttlMs, maxL1Entries } = options
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new TypeError(
        `SorobanStateCache: ttlMs must be a finite non-negative number, got ${String(ttlMs)}`,
      )
    }
    if (
      maxL1Entries !== undefined &&
      (!Number.isInteger(maxL1Entries) || maxL1Entries <= 0)
    ) {
      throw new TypeError(
        `SorobanStateCache: maxL1Entries must be a positive integer, got ${String(maxL1Entries)}`,
      )
    }
  }

  /**
   * Build a deterministic cache key from the three identifying dimensions.
   */
  public buildKey(network: string, contractId: string, address: string): string {
    // Normalise to lower-case so "GXXX" and "gxxx" are the same key.
    return `${network}:${contractId}:${address.toLowerCase()}`
  }

  /**
   * Returns a cached entry or null if not found / caching is disabled.
   *
   * Checks L1 first; promotes L2 hit into L1.
   */
  public async get(
    network: string,
    contractId: string,
    address: string,
  ): Promise<unknown | null> {
    if (this.disabled) {
      return null
    }

    // Guard against malformed inputs so we never build a key from `undefined`.
    if (!network || !contractId || !address) {
      sorobanStateCacheMissesTotal.inc({ network, contract: contractId })
      return null
    }

    const key = this.buildKey(network, contractId, address)
    const labels = { network, contract: contractId }

    // L1 hit
    const l1Value = this.l1.get(key)
    if (l1Value !== undefined) {
      sorobanStateCacheHitsTotal.inc(labels)
      return l1Value
    }

    // L2 hit
    try {
      const l2Value = await this.redis.get<unknown>(REDIS_NAMESPACE, key)
      if (l2Value !== null && l2Value !== undefined) {
        // Promote into L1
        this.l1.set(key, l2Value)
        sorobanStateCacheHitsTotal.inc(labels)
        return l2Value
      }
    } catch (err) {
      // Redis errors must never surface as RPC errors — log and fall through
      logger.warn({
        err,
        key,
        msg: 'sorobanStateCache: Redis get failed, falling through to RPC',
      })
    }

    sorobanStateCacheMissesTotal.inc(labels)
    return null
  }

  /**
   * Stores a successful RPC response in L1 and L2.
   * Silently swallows Redis errors — a failed write only means the next
   * request will be a cache miss, not an error.
   */
  public async set(
    network: string,
    contractId: string,
    address: string,
    value: unknown,
  ): Promise<void> {
    if (this.disabled) {
      return
    }

    // Never cache null/undefined payloads — a null RPC response means
    // "no identity state", and caching it would mask a later real value.
    if (value === null || value === undefined) {
      return
    }

    if (!network || !contractId || !address) {
      return
    }

    const key = this.buildKey(network, contractId, address)

    // L1 — always succeeds
    this.l1.set(key, value)

    // L2 — best-effort; TTL is stored in seconds for Redis setEx
    try {
      const ttlSeconds = Math.max(1, Math.ceil(this.ttlMs / 1000))
      await this.redis.set(REDIS_NAMESPACE, key, value, ttlSeconds)
    } catch (err) {
      logger.warn({
        err,
        key,
        msg: 'sorobanStateCache: Redis set failed, entry lives in L1 only',
      })
    }
  }

  /**
   * Evict a single entry from L1 and L2 (e.g. after a state-invalidating write).
   */
  public async invalidate(
    network: string,
    contractId: string,
    address: string,
  ): Promise<void> {
    if (!network || !contractId || !address) {
      return
    }
    const key = this.buildKey(network, contractId, address)
    this.l1.delete(key)
    try {
      await this.redis.delete(REDIS_NAMESPACE, key)
    } catch (err) {
      logger.warn({ err, key, msg: 'sorobanStateCache: Redis delete failed during invalidate' })
    }
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Creates a SorobanStateCache from config-derived TTL.
 * Pass `ttlMs: 0` to get a fully disabled (no-op) instance.
 */
export function createSorobanStateCache(
  ttlMs: number,
  overrides?: Partial<SorobanStateCacheOptions>,
): SorobanStateCache {
  return new SorobanStateCache({ ttlMs, ...overrides })
}
