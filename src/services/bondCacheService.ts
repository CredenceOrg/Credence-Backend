/**
 * Cache-aware service for bond operations.
 * Ensures cache consistency after bond status and amount updates.
 */

import { BondsRepository, Bond, BondStatus } from '../db/repositories/bondsRepository.js'
import { cache } from '../cache/redis.js'
import { invalidateCache, createCacheKey } from '../cache/invalidation.js'

const BOND_CACHE_TTL = 300 // 5 minutes

export class BondCacheService {
  constructor(private readonly repository: BondsRepository) {}

  /**
   * Get bond by ID with caching.
   */
  async getBondById(id: number): Promise<Bond | null> {
    const cacheKey = createCacheKey('id', id)
    const cached = await cache.get<Bond>('bond', cacheKey)
    
    if (cached) {
      // Re-hydrate Date objects
      return {
        ...cached,
        startTime: new Date(cached.startTime),
        createdAt: new Date(cached.createdAt)
      }
    }
    
    const bond = await this.repository.findById(id)
    if (bond) {
      await cache.set('bond', cacheKey, bond, BOND_CACHE_TTL)
    }
    
    return bond
  }

  /**
   * Get bonds by identity address with caching.
   */
  async getBondsByIdentity(identityAddress: string): Promise<Bond[]> {
    const cacheKey = createCacheKey('identity', identityAddress)
    const cached = await cache.get<Bond[]>('bond', cacheKey)
    
    if (cached) {
      // Re-hydrate Date objects
      return cached.map(b => ({
        ...b,
        startTime: new Date(b.startTime),
        createdAt: new Date(b.createdAt)
      }))
    }
    
    const bonds = await this.repository.listByIdentity(identityAddress)
    if (bonds.length > 0) {
      await cache.set('bond', cacheKey, bonds, BOND_CACHE_TTL)
    }
    
    return bonds
  }

  /**
   * Update bond status with cache invalidation.
   */
  async updateStatus(id: number, status: BondStatus): Promise<Bond | null> {
    const bond = await this.repository.updateStatus(id, status)
    
    if (bond) {
      // Invalidate both ID-based and identity-based caches
      await Promise.all([
        invalidateCache('bond', createCacheKey('id', id), bond, { verify: true }),
        invalidateCache('bond', createCacheKey('identity', bond.identityAddress))
      ])
    }
    
    return bond
  }

  /**
   * Debit bond amount with cache invalidation.
   */
  async debit(id: number, amount: string): Promise<Bond> {
    const bond = await this.repository.debit(id, amount)
    
    // Invalidate both ID-based and identity-based caches
    await Promise.all([
      invalidateCache('bond', createCacheKey('id', id), bond, { verify: true }),
      invalidateCache('bond', createCacheKey('identity', bond.identityAddress))
    ])
    
    return bond
  }
}
