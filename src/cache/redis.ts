import { createClient, RedisClientType } from 'redis'

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
      console.error('Redis client error:', err)
    })

    this.client.on('connect', () => {
      console.log('Redis client connected')
    })

    this.client.on('disconnect', () => {
      console.warn('Redis client disconnected')
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
      console.error('Redis health check failed:', error)
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
 * Generic caching layer with TTL and namespacing support
 */
export class CacheService {
  private redis: RedisConnection

  constructor(redis?: RedisConnection) {
    this.redis = redis || RedisConnection.getInstance()
  }

  /**
   * Get a value from cache by key
   * 
   * @param namespace - Cache namespace (e.g., 'trust', 'bond')
   * @param key - Cache key within namespace
   * @returns The cached value or null if not found
   */
  public async get<T = string>(namespace: string, key: string): Promise<T | null> {
    const namespacedKey = this.getNamespacedKey(namespace, key)
    
    try {
      await this.redis.connect()
      const value = await this.redis.getClient().get(namespacedKey)
      
      if (value === null) {
        return null
      }

      // Try to parse as JSON, fallback to string if it fails
      try {
        return JSON.parse(value) as T
      } catch {
        return value as T
      }
    } catch (error) {
      console.error(`Cache get failed for key ${namespacedKey}:`, error)
      return null
    }
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

      return true
    } catch (error) {
      console.error(`Cache set failed for key ${namespacedKey}:`, error)
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

    try {
      await this.redis.connect()
      const result = await this.redis.getClient().del(namespacedKey)
      return result > 0
    } catch (error) {
      console.error(`Cache delete failed for key ${namespacedKey}:`, error)
      return false
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

    try {
      await this.redis.connect()
      const keys = await this.redis.getClient().keys(pattern)
      
      if (keys.length === 0) {
        return 0
      }

      const result = await this.redis.getClient().del(keys)
      return result
    } catch (error) {
      console.error(`Cache clear namespace failed for ${namespace}:`, error)
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

    try {
      await this.redis.connect()
      const result = await this.redis.getClient().exists(namespacedKey)
      return result === 1
    } catch (error) {
      console.error(`Cache exists check failed for key ${namespacedKey}:`, error)
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

    try {
      await this.redis.connect()
      const result = await this.redis.getClient().expire(namespacedKey, ttl)
      return result === 1
    } catch (error) {
      console.error(`Cache expire failed for key ${namespacedKey}:`, error)
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

    try {
      await this.redis.connect()
      return await this.redis.getClient().ttl(namespacedKey)
    } catch (error) {
      console.error(`Cache TTL check failed for key ${namespacedKey}:`, error)
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
