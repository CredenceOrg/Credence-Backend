import { createHash } from 'crypto'
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
 *   soroban_state_cache_errors_total { network, contract, op }
 *   soroban_state_cache_invalidations_total { network, contract }
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

export const sorobanStateCacheErrorsTotal = new client.Counter({
  name: 'soroban_state_cache_errors_total',
  help: 'Total number of Soroban identity-state cache backend errors',
  labelNames: ['network', 'contract', 'op'] as const,
})

export const sorobanStateCacheInvalidationsTotal = new client.Counter({
  name: 'soroban_state_cache_invalidations_total',
  help: 'Total number of Soroban identity-state cache invalidations',
  labelNames: ['network', 'contract'] as const,
})

// ── Cache namespace used in Redis keys ────────────────────────────────────────

const REDIS_NAMESPACE = 'soroban_state'

// ── SorobanStateCache ─────────────────────────────────────────────────────────

export interface SorobanStateCacheOptions {
  /** TTL in milliseconds. 0 disables all caching. */
  ttlMs: number
  /** Maximum number of entries in the L1 LRU cache. Default: 500. */
  maxL1Entries?: number
  /** Override the Redis/CacheService instance (mainly for tests). */
  cacheService?: CacheService
  /** Optional clock injection for deterministic TTL tests. */
  now?: () => number
}

export class SorobanStateCache {
  private readonly ttlMs: number
  private readonly l1: LRUCache<string, any>
  private readonly redis: CacheService
  /** Whether caching is disabled (ttlMs === 0). */
  public readonly disabled: boolean
  /** Monotonic counter used to detect concurrent set/get races. */
  private readonly now: () => number

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

    this.now = options.now ?? (() => Date.now())
  }

  /**
   * Build a deterministic cache key from the three identifying dimensions.
   */
  public buildKey(network: string, contractId: string, address: string): string {
    // Normalise to lower-case so "GXXX" and "gxxx" are the same key.
    // Hash the address to keep key length bounded and avoid leaking raw
    // addresses into Redis key listings / logs.
    const addrHash = createHash('sha256')
      .update(address.toLowerCase())
      .digest('hex')
      .slice(0, 32)
    return `${network}:${contractId}:${addrHash}`
  }

  /**
   * Returns true when the given value is a cacheable (non-null, defined)
   * payload. Error responses and nulls must never be cached.
   */
  private isCacheable(value: unknown): boolean {
    return value !== null && value !== undefined
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

    // Guard against non-string inputs which would corrupt the key space.
    if (typeof network !== 'string' || typeof contractId !== 'string' || typeof address !== 'string') {
      sorobanStateCacheMissesTotal.inc({ network: String(network), contract: String(contractId) })
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
      sorobanStateCacheErrorsTotal.inc({ ...labels, op: 'get' })
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

    // Never cache null/undefined — those represent "not found" or errors.
    if (!this.isCacheable(value)) {
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
      sorobanStateCacheErrorsTotal.inc({ network, contract: contractId, op: 'set' })
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
    const key = this.buildKey(network, contractId, address)
    this.l1.delete(key)
    sorobanStateCacheInvalidationsTotal.inc({ network, contract: contractId })
    try {
      await this.redis.delete(REDIS_NAMESPACE, key)
    } catch (err) {
      sorobanStateCacheErrorsTotal.inc({ network, contract: contractId, op: 'delete' })
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
