/**
 * Cache-aware service for attestation operations.
 * Ensures cache consistency after attestation score updates.
 */

import { AttestationsRepository, Attestation, type AttestationPage, type ListAttestationsPageOptions, type CursorPaginationOptions, type AttestationCursorPage } from '../db/repositories/attestationsRepository.js'
import { cache } from '../cache/redis.js'
import { createCacheKey, invalidateCache } from '../cache/invalidation.js'

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
   * Get one subject-address page with read-through caching.
   */
  async getAttestationsBySubjectPage(
    subjectAddress: string,
    options: ListAttestationsPageOptions
  ): Promise<AttestationPage> {
    const cacheKey = createCacheKey('subject', subjectAddress, 'page', options.offset, options.limit)
    const cached = await cache.get<AttestationPage>('attestation', cacheKey)

    if (cached) {
      return {
        ...cached,
        attestations: cached.attestations.map(a => ({
          ...a,
          createdAt: new Date(a.createdAt)
        }))
      }
    }

    const page = await this.repository.listBySubjectPage(subjectAddress, options)
    await cache.set('attestation', cacheKey, page, ATTESTATION_CACHE_TTL)

    return page
  }

  /**
   * Get one subject-address page with cursor-based pagination.
   * Cursor-based pagination doesn't cache by offset since cursors are opaque.
   */
  async getAttestationsBySubjectPaginated(
    subjectAddress: string,
    options: CursorPaginationOptions
  ): Promise<AttestationCursorPage> {
    // For cursor-based pagination, we skip caching to avoid invalidation complexity
    // Cursors are opaque and not tied to page numbers, so caching by cursor would be inefficient
    const page = await this.repository.listBySubjectPaginated(subjectAddress, options)
    
    return {
      attestations: page.attestations.map(a => ({
        ...a,
        createdAt: new Date(a.createdAt)
      })),
      hasMore: page.hasMore,
    }
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
   * Create attestation with cache invalidation for related queries.
   */
  async createAttestation(input: Parameters<AttestationsRepository['create']>[0]): Promise<Attestation> {
    const attestation = await this.repository.create(input)
    await this.invalidateForAttestation(attestation)
    
    return attestation
  }

  /**
   * Invalidate all attestation list caches after a write.
   */
  async invalidateForAttestation(attestation: Attestation): Promise<void> {
    await Promise.all([
      invalidateCache('attestation', createCacheKey('subject', attestation.subjectAddress)),
      invalidateCache('attestation', createCacheKey('bond', attestation.bondId)),
      cache.clearNamespace('attestation')
    ])
  }
}
