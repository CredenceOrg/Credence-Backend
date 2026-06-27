import { createClient, RedisClientType } from 'redis'
import { LRUCache } from 'lru-cache'
import { executeCacheOperation, createMetricsAdapter } from '../lib/timeoutExecutor.js'
import { createDefaultMetricsCollector } from '../observability/timeoutMetrics.js'
import { logger } from '../utils/logger.js'

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
  private isConnecting = false
  private connectionPromise: Promise<void> | null = null

  private constructor() {
    this.client = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      socket: {
        connectTimeout: 5000,
      },
    })

    this.client.on('error', (err: Error) => {
      logger.error('Redis client error:', err)
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
    if (this.client.isOpen) {
      return
    }

    if (this.isConnecting && this.connectionPromise) {
      return this.connectionPromise
    }

    this.isConnecting = true
    this.connectionPromise = this.client.connect().then(() => {})

    try {
      await this.connectionPromise
    } finally {
      this.isConnecting = false
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
      logger.error('Redis health check failed:', error)
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
      return l1Value as T
    }
    
    return executeCacheOperation(
      `cache.get.${namespace}.${key}`,
      async () => {
        await this.redis.connect()
        const value = await this.redis.getClient().get(namespacedKey)
        
        if (value === null) {
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
        this.l1Cache.set(namespacedKey, parsedValue)
        return parsedValue
      },
      { metrics: this.metrics }
    ).catch(error => {
      logger.error(`Cache get failed for key ${namespacedKey}:`, error)
      return null
    })
  }

  /**
   * Set a value in cache with optional TTL
   * 
   * @param namespace - Cache namespace (e.g., 'trust', 'bond')
   * @param key - Cache key within namespace
   * @param value - Value to cache (will be JSON serialized)
   * @param ttl - Time to live in seconds (optional)
   * @returns True if set successfully, false on error
   */
  public async set<T = string>(
    namespace: string, 
    key: string, 
    value: T, 
    ttl?: number
  ): Promise<boolean> {
    const namespacedKey = this.getNamespacedKey(namespace, key)
    const serializedValue = typeof value === 'string' ? value : JSON.stringify(value)

    try {
      await this.redis.connect()
      const client = this.redis.getClient()

      if (ttl) {
        await client.setEx(namespacedKey, ttl, serializedValue)
      } else {
        await client.set(namespacedKey, serializedValue)
      }

      // Store in L1 with same TTL if provided (convert to ms)
      if (ttl) {
        this.l1Cache.set(namespacedKey, value, { ttl: ttl * 1000 })
      } else {
        this.l1Cache.set(namespacedKey, value)
      }

      return true
    } catch (error) {
      logger.error(`Cache set failed for key ${namespacedKey}:`, error)
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
    this.l1Cache.delete(namespacedKey)

    try {
      await this.redis.connect()
      const result = await this.redis.getClient().del(namespacedKey)
      return result > 0
    } catch (error) {
      logger.error(`Cache delete failed for key ${namespacedKey}:`, error)
      return false
    }
  }

  /**
   * Clear all keys matching a pattern in L1 cache
   * 
   * @param pattern - Pattern to match (e.g., 'identity:*')
   */
  public clearL1Pattern(pattern: string): void {
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
   * Clear all keys in a namespace
   * 
   * @param namespace - Cache namespace to clear
   * @returns Number of keys deleted
   */
  public async clearNamespace(namespace: string): Promise<number> {
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
      return 0
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
      logger.error(`Cache exists check failed for key ${namespacedKey}:`, error)
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

    // Update L1 TTL
    if (this.l1Cache.has(namespacedKey)) {
      const value = this.l1Cache.get(namespacedKey)
      this.l1Cache.set(namespacedKey, value, { ttl: ttl * 1000 })
    }

    try {
      await this.redis.connect()
      const result = await this.redis.getClient().expire(namespacedKey, ttl)
      return result === 1
    } catch (error) {
      logger.error(`Cache expire failed for key ${namespacedKey}:`, error)
      return false
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

    // Check L1 TTL
    const l1Remaining = this.l1Cache.getRemainingTTL(namespacedKey)
    if (l1Remaining > 0) {
      return Math.floor(l1Remaining / 1000)
    }

    try {
      await this.redis.connect()
      return await this.redis.getClient().ttl(namespacedKey)
    } catch (error) {
      logger.error(`Cache TTL check failed for key ${namespacedKey}:`, error)
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
   * Create a namespaced key
   */
  private getNamespacedKey(namespace: string, key: string): string {
    return `${namespace}:${key}`
  }
}

// Export singleton instances for convenience
export const redisConnection = RedisConnection.getInstance()
export const cache = new CacheService(redisConnection)
