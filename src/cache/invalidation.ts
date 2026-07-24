/**
 * Cache invalidation utilities for ensuring read-after-write consistency.
 * 
 * This module provides patterns for invalidating caches after database updates
 * to prevent stale reads in concurrent environments.
 */

import { cache, CacheService } from './redis.js'
import { recordStaleCacheRead } from '../middleware/metrics.js'
import { getInvalidationBus } from './invalidationBus.js'
import { logger } from '../utils/logger.js'

export interface InvalidationOptions {
  /**
   * Whether to verify the cache was actually cleared (stale-read detection)
   */
  verify?: boolean
  
  /**
   * Custom verification function to check if cached data is stale
   */
  verifyFn?: (cached: any, fresh: any) => boolean
}

/**
 * Invalidate a single cache key after a database update.
 * 
 * @param namespace - Cache namespace (e.g., 'bond', 'attestation')
 * @param key - Cache key within namespace
 * @param freshData - The updated data from the database (for verification)
 * @param options - Invalidation options
 * @returns True if invalidation succeeded
 */
export async function invalidateCache(
  namespace: string,
  key: string,
  freshData?: any,
  options: InvalidationOptions = {}
): Promise<boolean> {
  const { verify = false, verifyFn } = options
  
  // Delete the cache entry
  const deleted = await cache.delete(namespace, key)
  
  // Publish invalidation event
  const bus = getInvalidationBus()
  await bus.publish({
    type: 'invalidate',
    namespace,
    key
  })
  
  // Optionally verify the cache was cleared
  if (verify && freshData) {
    const staleCheck = await cache.get(namespace, key)
    
    if (staleCheck) {
      // Use custom verification function or default comparison
      const isStale = verifyFn 
        ? verifyFn(staleCheck, freshData)
        : JSON.stringify(staleCheck) !== JSON.stringify(freshData)
      
      if (isStale) {
        recordStaleCacheRead(namespace)
        logger.warn(`Stale cache detected for ${namespace}:${key}`)
      }
    }
  }
  
  return deleted
}

/**
 * Invalidate multiple cache keys in a namespace.
 * 
 * @param namespace - Cache namespace
 * @param keys - Array of cache keys to invalidate
 * @returns Number of keys successfully invalidated
 */
export async function invalidateMultiple(
  namespace: string,
  keys: string[]
): Promise<number> {
  let count = 0
  
  await Promise.all(
    keys.map(async (key) => {
      const deleted = await cache.delete(namespace, key)
      if (deleted) count++
    })
  )
  
  // Publish invalidation event
  const bus = getInvalidationBus()
  await bus.publish({
    type: 'invalidate_multiple',
    namespace,
    keys
  })
  
  return count
}

/**
 * Invalidate all keys matching a pattern in a namespace.
 * This is useful for invalidating related caches (e.g., all bonds for an identity).
 * 
 * @param namespace - Cache namespace
 * @param pattern - Pattern to match (e.g., 'identity:*')
 * @returns Number of keys invalidated
 */
export async function invalidatePattern(
  namespace: string,
  pattern: string
): Promise<number> {
  const count = await cache.clearNamespace(`${namespace}:${pattern}`)
  
  // Publish invalidation event
  const bus = getInvalidationBus()
  await bus.publish({
    type: 'invalidate_pattern',
    namespace,
    pattern
  })
  
  return count
}

/**
 * Decorator for repository methods that need cache invalidation.
 * Wraps a repository update method to automatically invalidate cache.
 * 
 * @param namespace - Cache namespace
 * @param keyExtractor - Function to extract cache key from method arguments
 * @param options - Invalidation options
 */
export function withCacheInvalidation<T extends (...args: any[]) => Promise<any>>(
  namespace: string,
  keyExtractor: (...args: Parameters<T>) => string | string[],
  options: InvalidationOptions = {}
) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value
    
    descriptor.value = async function (...args: Parameters<T>) {
      // Execute the original method
      const result = await originalMethod.apply(this, args)
      
      // Extract cache key(s) to invalidate
      const keys = keyExtractor(...args)
      const keyArray = Array.isArray(keys) ? keys : [keys]
      
      // Invalidate cache for each key
      await Promise.all(
        keyArray.map(key => invalidateCache(namespace, key, result, options))
      )
      
      return result
    }
    
    return descriptor
  }
}

/**
 * Helper to create a cache key from multiple parts.
 * 
 * @param parts - Parts to join into a cache key
 * @returns Cache key string
 */
export function createCacheKey(...parts: (string | number)[]): string {
  return parts.join(':')
}
