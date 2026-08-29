import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cache } from '../redis.js'

describe('CacheService getOrFetch (Singleflight integration)', () => {
  beforeEach(async () => {
    await cache.clearNamespace('test_ns')
  })

  it('Two concurrent callers get one origin call and identical results (happy path)', async () => {
    let callCount = 0
    const fetchFn = vi.fn().mockImplementation(async () => {
      callCount++
      // Delay to ensure concurrent calls overlap
      await new Promise(resolve => setTimeout(resolve, 50))
      return { data: 'test_data' }
    })

    const [r1, r2] = await Promise.all([
      cache.getOrFetch('test_ns', 'concurrent_key_happy', fetchFn, 300),
      cache.getOrFetch('test_ns', 'concurrent_key_happy', fetchFn, 300)
    ])

    // Both should receive the exact same object reference
    expect(r1).toEqual({ data: 'test_data' })
    expect(r2).toEqual({ data: 'test_data' })
    expect(r1).toBe(r2) 
    
    // Origin should only be called once
    expect(callCount).toBe(1)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('Two concurrent callers get one origin call and identical errors (sad path)', async () => {
    let callCount = 0
    const expectedError = new Error('Origin failed')
    const fetchFn = vi.fn().mockImplementation(async () => {
      callCount++
      await new Promise(resolve => setTimeout(resolve, 50))
      throw expectedError
    })

    const results = await Promise.allSettled([
      cache.getOrFetch('test_ns', 'concurrent_key_sad', fetchFn, 300),
      cache.getOrFetch('test_ns', 'concurrent_key_sad', fetchFn, 300)
    ])

    // Both should fail
    expect(results[0].status).toBe('rejected')
    expect(results[1].status).toBe('rejected')

    // Both should receive the exact same error
    if (results[0].status === 'rejected' && results[1].status === 'rejected') {
      expect(results[0].reason).toBe(expectedError)
      expect(results[1].reason).toBe(expectedError)
    }

    // Origin should only be called once
    expect(callCount).toBe(1)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})
