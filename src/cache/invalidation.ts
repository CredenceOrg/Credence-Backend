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
import { ValidationError, ServiceUnavailableError } from '../lib/errors.js'
import { transactionContextStorage, runPostCommit, runRollback } from '../db/transaction.js'

/**
 * Compute a deterministic, stable hash for comparing cached values.
 * Produces identical output for structurally equal objects regardless of
 * property insertion order, so it is safe to use for stale-read detection.
 */
function computeStableHash(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as object).sort())
}

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
  
  const context = transactionContextStorage.getStore()
  if (context) {
    runPostCommit(async () => {
      await cache.delete(namespace, key)
      const bus = getInvalidationBus()
      await bus.publish({
        type: 'invalidate',
        namespace,
        key
      })
      if (verify && freshData) {
        const staleCheck = await cache.get(namespace, key)
        if (staleCheck) {
          const isStale = verifyFn 
            ? verifyFn(staleCheck, freshData)
            : JSON.stringify(staleCheck) !== JSON.stringify(freshData)
          if (isStale) {
            recordStaleCacheRead(namespace)
            console.warn(`Stale cache detected for ${namespace}:${key}`)
          }
        }
      }
    })
    runRollback(async () => {
      logger.debug(`Cache invalidation for ${namespace}:${key} rolled back — cache retains valid data`)
    })
    return true
  }

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
        : computeStableHash(staleCheck) !== computeStableHash(freshData)
      
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
  const context = transactionContextStorage.getStore()
  if (context) {
    runPostCommit(async () => {
      await Promise.all(
        keys.map(async (key) => {
          await cache.delete(namespace, key)
        })
      )
      const bus = getInvalidationBus()
      await bus.publish({
        type: 'invalidate_multiple',
        namespace,
        keys
      })
    })
    runRollback(async () => {
      logger.debug(`Batch cache invalidation for ${namespace} rolled back (${keys.length} keys) — cache retains valid data`)
    })
    return keys.length
  }

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
  const context = transactionContextStorage.getStore()
  if (context) {
    runPostCommit(async () => {
      await cache.clearNamespace(`${namespace}:${pattern}`)
      const bus = getInvalidationBus()
      await bus.publish({
        type: 'invalidate_pattern',
        namespace,
        pattern
      })
    })
    runRollback(async () => {
      logger.debug(`Pattern cache invalidation for ${namespace}:${pattern} rolled back — cache retains valid data`)
    })
    return 0
  }

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
export function createCacheKey(...parts: (string | number | Record<string, string | number>)[]): string {
  return parts
    .map(p => {
      if (typeof p === 'object' && p !== null) {
        return Object.keys(p)
          .sort()
          .map(k => `${k}=${JSON.stringify(p[k])}`)
          .join('&')
      }
      return String(p)
    })
    .join(':')
}

/**
 * Tenant IDs are UUIDs throughout the schema (see
 * src/migrations/007_add_tenant_id_and_rls.ts). Restricting invalidation to
 * this shape also stops a caller-supplied tenantId from smuggling Redis KEYS
 * glob characters (e.g. `*`) into the invalidation pattern, which could
 * otherwise wipe far more than the intended tenant's entries.
 */
const TENANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isValidTenantId(tenantId: unknown): tenantId is string {
  return typeof tenantId === 'string' && TENANT_ID_PATTERN.test(tenantId)
}

export interface TenantCacheInvalidationResult {
  tenantId: string
  keysCleared: number
}

/**
 * Invalidate every cache entry scoped to a tenant, without requiring a
 * service restart. Tenant-scoped cache entries are stored under a namespace
 * equal to the tenant's ID (e.g. `cache.set(tenantId, key, value)`), so this
 * clears the tenant's entire Redis + L1 footprint in one call.
 *
 * Only key counts are ever logged or returned — never cached values — so
 * this is safe to call from support tooling without risking a leak of
 * tenant data into logs.
 *
 * @param tenantId - Tenant identifier (UUID)
 * @returns The tenant ID and number of keys cleared (0 if the tenant had no cached entries)
 * @throws {ValidationError} If tenantId is missing or not a valid UUID
 * @throws {ServiceUnavailableError} If the cache backend cannot be reached
 */
export async function invalidateTenantCache(
  tenantId: unknown
): Promise<TenantCacheInvalidationResult> {
  if (!isValidTenantId(tenantId)) {
    throw new ValidationError('tenantId must be a valid UUID')
  }

  const health = await cache.healthCheck()
  if (!health.healthy) {
    logger.error(`Tenant cache invalidation aborted: cache backend unavailable for tenant ${tenantId}`)
    throw new ServiceUnavailableError('Cache backend is unavailable; tenant cache was not invalidated')
  }

  const keysCleared = await cache.clearNamespace(tenantId)

  logger.info({
    message: 'Tenant cache invalidated',
    tenantId,
    keysCleared
  })

  return { tenantId, keysCleared }
}
