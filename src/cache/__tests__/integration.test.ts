/**
 * Integration tests for cache invalidation
 * 
 * These tests demonstrate end-to-end cache invalidation behavior
 * in realistic scenarios with concurrent operations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cache } from '../redis.js'
import { invalidateCache, createCacheKey } from '../invalidation.js'

// Mock Redis for integration tests
vi.mock('../redis.js', () => {
  const store = new Map<string, { value: any; ttl?: number; setAt: number }>()
  
  return {
    cache: {
      get: vi.fn(async (namespace: string, key: string) => {
        const fullKey = `${namespace}:${key}`
        const entry = store.get(fullKey)
        if (!entry) return null
        
        // Check TTL expiration
        if (entry.ttl) {
          const elapsed = Date.now() - entry.setAt
          if (elapsed > entry.ttl * 1000) {
            store.delete(fullKey)
            return null
          }
        }
        
        return entry.value
      }),
      
      set: vi.fn(async (namespace: string, key: string, value: any, ttl?: number) => {
        const fullKey = `${namespace}:${key}`
        store.set(fullKey, { value, ttl, setAt: Date.now() })
        return true
      }),
      
      delete: vi.fn(async (namespace: string, key: string) => {
        const fullKey = `${namespace}:${key}`
        const existed = store.has(fullKey)
        store.delete(fullKey)
        return existed
      }),
      
      clearNamespace: vi.fn(async (pattern: string) => {
        let count = 0
        for (const key of store.keys()) {
          if (key.startsWith(pattern.replace('*', ''))) {
            store.delete(key)
            count++
          }
        }
        return count
      }),
      
      // Test helper to inspect store
      _getStore: () => store,
      _clearStore: () => store.clear()
    }
  }
})

describe('Cache Invalidation Integration', () => {
  beforeEach(() => {
    ;(cache as any)._clearStore()
    vi.clearAllMocks()
  })

  afterEach(() => {
    ;(cache as any)._clearStore()
  })

  describe('Read-After-Write Consistency', () => {
    it('should return fresh data after update with invalidation', async () => {
      const namespace = 'bond'
      const key = createCacheKey('id', 1)
      
      // Initial data
      const initialBond = { id: 1, status: 'active', amount: '1000' }
      await cache.set(namespace, key, initialBond, 300)
      
      // Verify cached
      let cached = await cache.get(namespace, key)
      expect(cached).toEqual(initialBond)
      
      // Simulate update
      const updatedBond = { id: 1, status: 'released', amount: '1000' }
      await invalidateCache(namespace, key, updatedBond)
      
      // Should return null (cache cleared)
      cached = await cache.get(namespace, key)
      expect(cached).toBeNull()
      
      // Re-cache with fresh data
      await cache.set(namespace, key, updatedBond, 300)
      
      // Should return fresh data
      cached = await cache.get(namespace, key)
      expect(cached).toEqual(updatedBond)
    })

    it('should handle concurrent updates correctly', async () => {
      const namespace = 'settlement'
      const key = 'tx123'
      
      // Initial state
      const settlement1 = { hash: 'tx123', status: 'pending', amount: '100' }
      await cache.set(namespace, key, settlement1, 300)
      
      // Simulate concurrent update 1
      const settlement2 = { hash: 'tx123', status: 'processing', amount: '100' }
      await invalidateCache(namespace, key, settlement2)
      await cache.set(namespace, key, settlement2, 300)
      
      // Simulate concurrent update 2
      const settlement3 = { hash: 'tx123', status: 'completed', amount: '100' }
      await invalidateCache(namespace, key, settlement3)
      await cache.set(namespace, key, settlement3, 300)
      
      // Final read should have latest data
      const cached = await cache.get(namespace, key)
      expect(cached).toEqual(settlement3)
      expect(cached.status).toBe('completed')
    })
  })

  describe('Multi-Key Invalidation', () => {
    it('should invalidate all related caches on update', async () => {
      const namespace = 'attestation'
      const attestation = {
        id: 1,
        bondId: 10,
        subjectAddress: '0x123',
        score: 85
      }
      
      // Cache in multiple locations
      await cache.set(namespace, createCacheKey('id', 1), attestation, 300)
      await cache.set(namespace, createCacheKey('subject', '0x123'), [attestation], 300)
      await cache.set(namespace, createCacheKey('bond', 10), [attestation], 300)
      
      // Verify all cached
      expect(await cache.get(namespace, createCacheKey('id', 1))).toEqual(attestation)
      expect(await cache.get(namespace, createCacheKey('subject', '0x123'))).toEqual([attestation])
      expect(await cache.get(namespace, createCacheKey('bond', 10))).toEqual([attestation])
      
      // Update score
      const updated = { ...attestation, score: 95 }
      
      // Invalidate all related caches
      await Promise.all([
        invalidateCache(namespace, createCacheKey('id', 1), updated),
        invalidateCache(namespace, createCacheKey('subject', '0x123')),
        invalidateCache(namespace, createCacheKey('bond', 10))
      ])
      
      // All should be cleared
      expect(await cache.get(namespace, createCacheKey('id', 1))).toBeNull()
      expect(await cache.get(namespace, createCacheKey('subject', '0x123'))).toBeNull()
      expect(await cache.get(namespace, createCacheKey('bond', 10))).toBeNull()
    })
  })

  describe('TTL Behavior', () => {
    it('should respect TTL for cached data', async () => {
      const namespace = 'report'
      const key = 'job-123'
      const job = { id: 'job-123', status: 'running' }
      
      // Cache with 1 second TTL
      await cache.set(namespace, key, job, 1)
      
      // Should be cached immediately
      let cached = await cache.get(namespace, key)
      expect(cached).toEqual(job)
      
      // Wait for TTL to expire
      await new Promise(resolve => setTimeout(resolve, 1100))
      
      // Should be expired
      cached = await cache.get(namespace, key)
      expect(cached).toBeNull()
    })

    it('should use different TTLs for different states', async () => {
      const namespace = 'report'
      
      // Active job - short TTL
      const activeJob = { id: 'job-1', status: 'running' }
      await cache.set(namespace, 'job-1', activeJob, 60)
      
      // Completed job - longer TTL
      const completedJob = { id: 'job-2', status: 'completed' }
      await cache.set(namespace, 'job-2', completedJob, 300)
      
      // Both should be cached
      expect(await cache.get(namespace, 'job-1')).toEqual(activeJob)
      expect(await cache.get(namespace, 'job-2')).toEqual(completedJob)
    })
  })

  describe('Cache Key Consistency', () => {
    it('should create consistent cache keys', () => {
      expect(createCacheKey('user', 123)).toBe('user:123')
      expect(createCacheKey('bond', 'id', 456)).toBe('bond:id:456')
      expect(createCacheKey('attestation', 'subject', '0xabc')).toBe('attestation:subject:0xabc')
    })

    it('should use consistent keys across operations', async () => {
      const namespace = 'bond'
      const id = 42
      const key = createCacheKey('id', id)
      
      const bond = { id, status: 'active' }
      
      // Set with key
      await cache.set(namespace, key, bond, 300)
      
      // Get with same key
      const cached = await cache.get(namespace, key)
      expect(cached).toEqual(bond)
      
      // Delete with same key
      const deleted = await cache.delete(namespace, key)
      expect(deleted).toBe(true)
      
      // Should be gone
      const afterDelete = await cache.get(namespace, key)
      expect(afterDelete).toBeNull()
    })
  })

  describe('Error Scenarios', () => {
    it('should handle missing cache entries gracefully', async () => {
      const result = await cache.get('nonexistent', 'key')
      expect(result).toBeNull()
    })

    it('should handle invalidation of non-existent keys', async () => {
      const result = await invalidateCache('nonexistent', 'key')
      expect(result).toBe(false)
    })

    it('should continue on partial invalidation failure', async () => {
      const namespace = 'test'
      
      // Cache some data
      await cache.set(namespace, 'key1', { data: 1 }, 300)
      await cache.set(namespace, 'key2', { data: 2 }, 300)
      
      // Invalidate multiple (one exists, one doesn't)
      await Promise.all([
        invalidateCache(namespace, 'key1'),
        invalidateCache(namespace, 'key-nonexistent'),
        invalidateCache(namespace, 'key2')
      ])
      
      // Existing keys should be cleared
      expect(await cache.get(namespace, 'key1')).toBeNull()
      expect(await cache.get(namespace, 'key2')).toBeNull()
    })
  })
})
