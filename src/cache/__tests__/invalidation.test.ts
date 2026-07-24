/**
 * Tests for cache invalidation utilities
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { 
  invalidateCache, 
  invalidateMultiple, 
  createCacheKey 
} from '../invalidation.js'
import { cache } from '../redis.js'
import * as metrics from '../../middleware/metrics.js'

vi.mock('../redis.js', () => ({
  cache: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    clearNamespace: vi.fn()
  }
}))

vi.mock('../../middleware/metrics.js', () => ({
  recordStaleCacheRead: vi.fn()
}))

describe('Cache Invalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('invalidateCache', () => {
    it('should delete cache entry', async () => {
      vi.mocked(cache.delete).mockResolvedValue(true)

      const result = await invalidateCache('test', 'key1')

      expect(cache.delete).toHaveBeenCalledWith('test', 'key1')
      expect(result).toBe(true)
    })

    it('should verify cache was cleared when verify option is true', async () => {
      vi.mocked(cache.delete).mockResolvedValue(true)
      vi.mocked(cache.get).mockResolvedValue(null)

      const freshData = { id: 1, status: 'completed' }
      await invalidateCache('test', 'key1', freshData, { verify: true })

      expect(cache.delete).toHaveBeenCalledWith('test', 'key1')
      expect(cache.get).toHaveBeenCalledWith('test', 'key1')
      expect(metrics.recordStaleCacheRead).not.toHaveBeenCalled()
    })

    it('should detect stale cache when verification finds different data', async () => {
      vi.mocked(cache.delete).mockResolvedValue(true)
      const staleData = { id: 1, status: 'pending' }
      vi.mocked(cache.get).mockResolvedValue(staleData)

      const freshData = { id: 1, status: 'completed' }
      await invalidateCache('test', 'key1', freshData, { verify: true })

      expect(metrics.recordStaleCacheRead).toHaveBeenCalledWith('test')
    })

    it('should use custom verification function when provided', async () => {
      vi.mocked(cache.delete).mockResolvedValue(true)
      const staleData = { id: 1, status: 'pending', amount: '100' }
      vi.mocked(cache.get).mockResolvedValue(staleData)

      const freshData = { id: 1, status: 'completed', amount: '100' }
      const verifyFn = vi.fn((cached: any, fresh: any) => cached.status !== fresh.status)

      await invalidateCache('test', 'key1', freshData, { verify: true, verifyFn })

      expect(verifyFn).toHaveBeenCalledWith(staleData, freshData)
      expect(metrics.recordStaleCacheRead).toHaveBeenCalledWith('test')
    })

    it('should not verify when verify option is false', async () => {
      vi.mocked(cache.delete).mockResolvedValue(true)

      const freshData = { id: 1, status: 'completed' }
      await invalidateCache('test', 'key1', freshData, { verify: false })

      expect(cache.delete).toHaveBeenCalledWith('test', 'key1')
      expect(cache.get).not.toHaveBeenCalled()
    })
  })

  describe('invalidateMultiple', () => {
    it('should invalidate multiple cache keys', async () => {
      vi.mocked(cache.delete).mockResolvedValue(true)

      const count = await invalidateMultiple('test', ['key1', 'key2', 'key3'])

      expect(cache.delete).toHaveBeenCalledTimes(3)
      expect(cache.delete).toHaveBeenCalledWith('test', 'key1')
      expect(cache.delete).toHaveBeenCalledWith('test', 'key2')
      expect(cache.delete).toHaveBeenCalledWith('test', 'key3')
      expect(count).toBe(3)
    })

    it('should count only successful deletions', async () => {
      vi.mocked(cache.delete)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)

      const count = await invalidateMultiple('test', ['key1', 'key2', 'key3'])

      expect(count).toBe(2)
    })

    it('should handle empty key array', async () => {
      const count = await invalidateMultiple('test', [])

      expect(cache.delete).not.toHaveBeenCalled()
      expect(count).toBe(0)
    })
  })

  describe('createCacheKey', () => {
    it('should create cache key from multiple parts', () => {
      const key = createCacheKey('user', 123, 'profile')
      expect(key).toBe('user:123:profile')
    })

    it('should handle single part', () => {
      const key = createCacheKey('simple')
      expect(key).toBe('simple')
    })

    it('should handle numeric parts', () => {
      const key = createCacheKey(1, 2, 3)
      expect(key).toBe('1:2:3')
    })
  })
})
