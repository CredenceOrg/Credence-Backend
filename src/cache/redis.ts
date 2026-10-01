import { createClient, RedisClientType } from 'redis'
import { LRUCache } from 'lru-cache'
import { executeCacheOperation, createMetricsAdapter } from '../lib/timeoutExecutor.js'
import { createDefaultMetricsCollector } from '../observability/timeoutMetrics.js'
import { logger } from '../utils/logger.js'
import { singleflight } from '../lib/singleflight.js'
import { recordCacheHit, recordCacheMiss, isObjectStale } from '../utils/cacheContext.js'
import { recordRedisKeySize } from '../middleware/metrics.js'

export type RedisClient = RedisClientType

/**
 * Redis connection manager for Credence Backend
 * 
 * Provides a singleton Redis client with connection health monitoring
 * and graceful shutdown handling.
 */
export class RedisConnection {
  private static instance: RedisConnection
  private client: RedisClient
  private connectionPromise: Promise<void> | null = null

  private constructor() {
    this.client = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      socket: {
        connectTimeout: 5000,
      },
    })

    this.client.on('error', () => {
      logger.error('Redis client error')
    })

    this.client.on('connect', () => {
      logger.info('Redis client connected')
    })

    this.client.on('disconnect', () => {
      logger.warn('Redis client disconnected')
    })
  }

  /**
   * Get the singleton Redis connection instance
   */
  public static getInstance(): RedisConnection {
    if (!RedisConnection.instance) {
      RedisConnection.instance = new RedisConnection()
    }
    return RedisConnection.instance
  }

  /**
   * Connect to Redis (idempotent)
   */
  public async connect(): Promise<void> {
    // Redis marks the socket open before connect() settles. All callers must
    // share that pending attempt rather than treating an open socket as ready.
    if (this.connectionPromise) {
      return this.connectionPromise
    }
    if (this.client.isOpen) {
      return
    }

    try {
      this.connectionPromise = this.client.connect().then(() => {})
      await this.connectionPromise
    } finally {
      this.connectionPromise = null
    }
  }

  /**
   * Get the Redis client (auto-connects if needed)
   */
  public getClient(): RedisClient {
    return this.client
  }

  /**
   * Check if Redis is connected and healthy
   */
  public async isHealthy(): Promise<boolean> {
    try {
      if (!this.client.isOpen) {
        return false
      }

      await this.client.ping()
      return true
    } catch (error) {
      logger.error('Redis health check failed')
      return false
    }
  }

  /**
   * Gracefully disconnect from Redis
   */
  public async disconnect(): Promise<void> {
    if (this.client.isOpen) {
      await this.client.quit()
    }
  }

  /**
   * Force close the Redis connection
   */
  public async forceClose(): Promise<void> {
    if (this.client.isOpen) {
      await this.client.disconnect()
    }
  }
}

/**
 * Generic caching layer with L1 (in-memory LRU) and L2 (Redis) support
 */
export class CacheService {
  private redis: RedisConnection
  private metrics = createMetricsAdapter(createDefaultMetricsCollector())
  private l1Cache: LRUCache<string, any>
  // A bounded generation fence prevents a delayed read/write from repopulating
  // L1 after a mutation. It intentionally spans namespaces to avoid a growing
  // per-key tombstone map; Redis remains authoritative when a fill is skipped.
  private l1Generation = 0

  constructor(redis?: RedisConnection) {
    this.redis = redis || RedisConnection.getInstance()
    this.l1Cache = new LRUCache({
      max: 1000,
      ttl: 60000, // 1 minute default TTL for L1
      ttlAutopurge: true
    })
  }

  /**
   * Get a value from cache by key (checks L1 first, then L2)
   * 
   * @param namespace - Cache namespace (e.g., 'trust', 'bond')
   * @param key - Cache key within namespace
   * @returns The cached value or null if not found
   */
  public async get<T = string>(namespace: string, key: string): Promise<T | null> {
    const namespacedKey = this.getNamespacedKey(namespace, key)
    
    // Check L1 cache first
    const l1Value = this.l1Cache.get(namespacedKey)
    if (l1Value !== undefined) {
      if (l1Value === null) {
        recordCacheMiss()
      } else {
        recordCacheHit(isObjectStale(l1Value))
      }
      return l1Value as T
    }
    
    return executeCacheOperation(
      'cache.get',
      async () => {
        const generation = this.l1Generation
        await this.redis.connect()
        const value = await this.redis.getClient().get(namespacedKey)
        
        if (value === null) {
          recordCacheMiss()
          return null
        }

        // Try to parse as JSON, fallback to string if it fails
        let parsedValue: T
        try {
          parsedValue = JSON.parse(value) as T
        } catch {
          parsedValue = value as T
        }

        // Store in L1
        if (generation === this.l1Generation) {
          this.l1Cache.set(namespacedKey, parsedValue)
        }
        if (parsedValue === null) recordCacheMiss()
        else recordCacheHit(isObjectStale(parsedValue))
        return parsedValue
      },
      { metrics: this.metrics }
    ).catch(error => {
      // The timeout executor cannot cancel the underlying Redis promise. Fence
      // its late completion so a timed-out read cannot refill L1 afterward.
      this.invalidateL1(namespacedKey)
      logger.error('Cache get failed')
      recordCacheMiss()
      return null
    })
  }

  /**
   * Set a value in cache with optional TTL
   * 
   * @param namespace - Cache namespace (e.g., 'trust', 'bond')
   * @param key - Cache key within namespace
   * @param value - Value to cache (will be JSON serialized)
   * @param ttl - Positive safe-integer seconds; omit for a persistent Redis key
   * @returns True if set successfully, false on error
   */
  public async set<T = string>(
    namespace: string, 
    key: string, 
    value: T, 
    ttl?: number
  ): Promise<boolean> {
    const namespacedKey = this.getNamespacedKey(namespace, key)
    try {
      if (ttl !== undefined && (!Number.isSafeInteger(ttl) || ttl <= 0)) {
        logger.error('Cache set rejected: invalid TTL')
        return false
      }
      const serializedValue = typeof value === 'string' ? value : JSON.stringify(value)
      if (serializedValue === undefined) {
        logger.error('Cache set rejected: value is not serializable')
        return false
      }
      recordRedisKeySize(namespace, Buffer.byteLength(serializedValue, 'utf8'))
      this.invalidateL1(namespacedKey)
      const generation = this.l1Generation
      await this.redis.connect()
      const client = this.redis.getClient()

      if (ttl) {
        await client.setEx(namespacedKey, ttl, serializedValue)
      } else {
        await client.set(namespacedKey, serializedValue)
      }

      const canPopulate = generation === this.l1Generation
      this.invalidateL1(namespacedKey)
      // A concurrent mutation can complete out of order; conservatively leave
      // L1 empty so the next read observes Redis rather than a delayed reply.
      if (canPopulate) {
        if (ttl) {
          this.l1Cache.set(namespacedKey, value, { ttl: ttl * 1000 })
        } else {
          this.l1Cache.set(namespacedKey, value)
        }
      }

      return true
    } catch (error) {
      this.invalidateL1(namespacedKey)
      logger.error('Cache set failed')
      return false
    }
  }

  /**
   * Delete a value from cache
   * 
   * @param namespace - Cache namespace (e.g., 'trust', 'bond')
   * @param key - Cache key within namespace
   * @returns True if deleted successfully, false on error
   */
  public async delete(namespace: string, key: string): Promise<boolean> {
    const namespacedKey = this.getNamespacedKey(namespace, key)

    // Delete from L1
    this.invalidateL1(namespacedKey)

    try {
      await this.redis.connect()
      const result = await this.redis.getClient().del(namespacedKey)
      return result > 0
    } catch (error) {
      logger.error('Cache delete failed')
      return false
    } finally {
      this.invalidateL1(namespacedKey)
    }
  }

  /**
   * Clear all keys matching a pattern in L1 cache
   * 
   * @param pattern - Pattern to match (e.g., 'identity:*')
   */
  public clearL1Pattern(pattern: string): void {
    this.l1Generation++
    const keysToDelete: string[] = []
    for (const key of this.l1Cache.keys()) {
      if (key.startsWith(pattern.replace('*', ''))) {
        keysToDelete.push(key)
      }
    }
    for (const key of keysToDelete) {
      this.l1Cache.delete(key)
    }
  }

  /**
   * Clear all keys in a namespace.
   *
   * @param namespace - Cache namespace to clear
   * @param options - Whether backend errors should be propagated
   * @returns Number of keys deleted
   */
  public async clearNamespace(
    namespace: string,
    options: { throwOnError?: boolean } = {}
  ): Promise<number> {
    const pattern = this.getNamespacedKey(namespace, '*')

    // Clear from L1
    this.clearL1Pattern(pattern)

    try {
      await this.redis.connect()
      const keys = await this.redis.getClient().keys(pattern)
      
      if (keys.length === 0) {
        return 0
      }

      const result = await this.redis.getClient().del(keys)
      return result
    } catch (error) {
      logger.error(`Cache clear namespace failed for ${namespace}:`, error)
      if (options.throwOnError) {
        throw error
      }
      return 0
    } finally {
      this.clearL1Pattern(pattern)
    }
  }

  /**
   * Check if a key exists in cache
   * 
   * @param namespace - Cache namespace (e.g., 'trust', 'bond')
   * @param key - Cache key within namespace
   * @returns True if key exists, false otherwise
   */
  public async exists(namespace: string, key: string): Promise<boolean> {
    const namespacedKey = this.getNamespacedKey(namespace, key)

    // Check L1
    if (this.l1Cache.has(namespacedKey)) {
      return true
    }

    try {
      await this.redis.connect()
      const result = await this.redis.getClient().exists(namespacedKey)
      return result === 1
    } catch (error) {
      logger.error('Cache exists check failed')
      return false
    }
  }

  /**
   * Set TTL for an existing key
   * 
   * @param namespace - Cache namespace (e.g., 'trust', 'bond')
   * @param key - Cache key within namespace
   * @param ttl - Time to live in seconds
   * @returns True if TTL was set successfully
   */
  public async expire(namespace: string, key: string, ttl: number): Promise<boolean> {
    const namespacedKey = this.getNamespacedKey(namespace, key)

    if (!Number.isSafeInteger(ttl)) {
      logger.error('Cache expire rejected: invalid TTL')
      return false
    }
    // Never extend local lifetime before Redis confirms EXPIRE. Eviction also
    // handles zero/negative TTL (Redis deletes immediately) and failed updates.
    this.invalidateL1(namespacedKey)

    try {
      await this.redis.connect()
      const result = await this.redis.getClient().expire(namespacedKey, ttl)
      return result === 1
    } catch (error) {
      logger.error('Cache expire failed')
      return false
    } finally {
      this.invalidateL1(namespacedKey)
    }
  }

  /**
   * Get remaining TTL for a key
   * 
   * @param namespace - Cache namespace (e.g., 'trust', 'bond')
   * @param key - Cache key within namespace
   * @returns Remaining TTL in seconds, or -1 if key exists but has no expiry, -2 if key doesn't exist
   */
  public async ttl(namespace: string, key: string): Promise<number> {
    const namespacedKey = this.getNamespacedKey(namespace, key)

    // L1's default eviction lifetime is not the Redis key's TTL. Query Redis
    // so persistent keys retain -1 and deleted/expired keys retain -2.

    try {
      await this.redis.connect()
      return await this.redis.getClient().ttl(namespacedKey)
    } catch (error) {
      logger.error('Cache TTL check failed')
      return -2
    }
  }

  /**
   * Health check for Redis connection
   */
  public async healthCheck(): Promise<{ healthy: boolean; error?: string }> {
    try {
      const healthy = await this.redis.isHealthy()
      return { healthy }
    } catch (error) {
      return { 
        healthy: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }
    }
  }

  /**
   * Get a value from cache or fetch it from origin — with cache-stampede
   * protection via SingleFlight deduplication.
   *
   * When multiple concurrent callers request the same (namespace, key) and a
   * cache miss occurs, only **one** origin call is made.  All other callers
   * transparently wait for the same result.
   *
   * The origin fetch is double-checked: after acquiring the singleflight slot
   * the method re-checks the cache in case another call already populated it,
   * avoiding redundant origin calls on the tail-end of a race.
   *
   * @param namespace - Cache namespace (e.g., 'settlement', 'attestation')
   * @param key       - Cache key within namespace
   * @param fetchFn   - Origin fetch function, called on cache miss
   * @param ttl       - Time to live in seconds for the cached value
   * @returns The cached or freshly-fetched value
   */
  async getOrFetch<T>(
    namespace: string,
    key: string,
    fetchFn: () => Promise<T>,
    ttl: number,
  ): Promise<T> {
    // Fast path — L1 / L2 hit.
    const cached = await this.get<T>(namespace, key)
    if (cached !== null) return cached

    // SingleFlight key scoped to the (namespace, key) pair.
    const sfKey = `cache:${namespace}:${key}`

    return singleflight.do<T>(sfKey, async () => {
      // Double-check cache after acquiring the singleflight slot.
      const rechecked = await this.get<T>(namespace, key)
      if (rechecked !== null) return rechecked

      const fresh = await fetchFn()
      // Fire-and-forget the cache set — a failure here should not bubble up
      // to callers (the value is still returned).
      this.set(namespace, key, fresh, ttl).catch(() => {
        logger.error(
          'getOrFetch: failed to cache value',
        )
      })
      return fresh
    })
  }

  /**
   * Create a namespaced key
   */
  private getNamespacedKey(namespace: string, key: string): string {
    return `${namespace}:${key}`
  }

  private invalidateL1(key: string): void {
    this.l1Generation++
    this.l1Cache.delete(key)
  }
}

// Export singleton instances for convenience
export const redisConnection = RedisConnection.getInstance()
export const cache = new CacheService(redisConnection)
