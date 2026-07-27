/**
 * Cache module exports
 */

export { cache, redisConnection, CacheService, RedisConnection } from './redis.js';
export { singleflight } from '../lib/singleflight.js';
export {
  invalidateCache,
  invalidateMultiple,
  invalidatePattern,
  withCacheInvalidation,
  createCacheKey,
  invalidateTenantCache,
  isValidTenantId,
  type InvalidationOptions,
  type TenantCacheInvalidationResult
} from './invalidation.js';
export {
  InvalidationBus,
  getInvalidationBus,
  resetInvalidationBus,
  type InvalidationEvent
} from './invalidationBus.js';
