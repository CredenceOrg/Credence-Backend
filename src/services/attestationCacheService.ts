/**
 * Cache-aware service for attestation operations.
 * Ensures cache consistency after attestation score updates.
 */

import { AttestationsRepository, Attestation } from '../db/repositories/attestationsRepository.js'
import { cache } from '../cache/redis.js'
import { invalidateCache, invalidatePattern, createCacheKey } from '../cache/invalidation.js'

const ATTESTATION_CACHE_TTL = 300 // 5 minutes

export class AttestationCacheService {
  constructor(private readonly repository: AttestationsRepository) {}

  /**
   * Get attestation by ID with caching.
   */
  async getAttestationById(id: number): Promise<Attestation | null> {
    const cacheKey = createCacheKey('id', id)
    const cached = await cache.get<Attestation>('attestation', cacheKey)
    
    if (cached) {
      // Re-hydrate Date objects
      return {
        ...cached,
        createdAt: new Date(cached.createdAt)
      }
    }
    
    const attestation = await this.repository.findById(id)
    if (attestation) {
      await cache.set('attestation', cacheKey, attestation, ATTESTATION_CACHE_TTL)
    }
    
    return attestation
  }

  /**
   * Get attestations by subject address with caching.
   */
  async getAttestationsBySubject(subjectAddress: string): Promise<Attestation[]> {
    const cacheKey = createCacheKey('subject', subjectAddress)
    const cached = await cache.get<Attestation[]>('attestation', cacheKey)
    
    if (cached) {
      // Re-hydrate Date objects
      return cached.map(a => ({
        ...a,
        createdAt: new Date(a.createdAt)
      }))
    }
    
    const attestations = await this.repository.listBySubject(subjectAddress)
    if (attestations.length > 0) {
      await cache.set('attestation', cacheKey, attestations, ATTESTATION_CACHE_TTL)
    }
    
    return attestations
  }

  /**
   * Get paginated attestations by subject with read-through caching.
   */
  async getAttestationsBySubjectPaginated(
    subjectAddress: string,
    options: { offset: number; limit: number },
  ): Promise<{ rows: Attestation[]; total: number }> {
    const cacheKey = createCacheKey(
      'subject',
      subjectAddress,
      'offset',
      options.offset,
      'limit',
      options.limit,
    )
    const cached = await cache.get<{ rows: Attestation[]; total: number }>('attestation', cacheKey)

    if (cached) {
      return {
        rows: cached.rows.map((a) => ({
          ...a,
          createdAt: new Date(a.createdAt),
        })),
        total: cached.total,
      }
    }

    const result = await this.repository.listBySubjectPaginated(subjectAddress, options)
    await cache.set('attestation', cacheKey, result, ATTESTATION_CACHE_TTL)

    return result
  }

  /**
   * Get attestations by bond ID with caching.
   */
  async getAttestationsByBond(bondId: number): Promise<Attestation[]> {
    const cacheKey = createCacheKey('bond', bondId)
    const cached = await cache.get<Attestation[]>('attestation', cacheKey)
    
    if (cached) {
      // Re-hydrate Date objects
      return cached.map(a => ({
        ...a,
        createdAt: new Date(a.createdAt)
      }))
    }
    
    const attestations = await this.repository.listByBond(bondId)
    if (attestations.length > 0) {
      await cache.set('attestation', cacheKey, attestations, ATTESTATION_CACHE_TTL)
    }
    
    return attestations
  }

  /**
   * Update attestation score with cache invalidation.
   */
  async updateScore(id: number, score: number): Promise<Attestation | null> {
    const attestation = await this.repository.updateScore(id, score)
    
    if (attestation) {
      // Invalidate ID, subject, and bond-based caches
      await Promise.all([
        invalidateCache('attestation', createCacheKey('id', id), attestation, { 
          verify: true,
          verifyFn: (cached, fresh) => cached.score !== fresh.score
        }),
        invalidateCache('attestation', createCacheKey('subject', attestation.subjectAddress)),
        invalidateCache('attestation', createCacheKey('bond', attestation.bondId))
      ])
    }
    
    return attestation
  }

  /**
   * Invalidate list caches after an attestation is persisted elsewhere.
   */
  async invalidateAfterCreate(attestation: Attestation): Promise<void> {
    await Promise.all([
      invalidatePattern('attestation', `subject:${attestation.subjectAddress}`),
      invalidateCache('attestation', createCacheKey('bond', attestation.bondId)),
    ])
  }

  /**
   * Create attestation with cache invalidation for related queries.
   */
  async createAttestation(input: Parameters<AttestationsRepository['create']>[0]): Promise<Attestation> {
    const attestation = await this.repository.create(input)
    await this.invalidateAfterCreate(attestation)
    return attestation
  }
}
