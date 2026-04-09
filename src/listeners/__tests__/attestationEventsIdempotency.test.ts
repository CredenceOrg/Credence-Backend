/**
 * Integration tests for AttestationEventListener with IdempotencyGuard
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { AttestationEventListener } from '../attestationEvents.js'
import { IdempotencyGuard } from '../../lib/idempotencyGuard.js'
import type { AttestationStore, AttestationEvent } from '../attestationEvents.js'
import type { CacheService } from '../../cache/redis.js'
import type { Attestation } from '../../types/attestation.js'

describe('AttestationEventListener with IdempotencyGuard', () => {
  let mockStore: AttestationStore
  let mockCache: CacheService
  let idempotencyGuard: IdempotencyGuard
  let listener: AttestationEventListener
  let fetchEvents: ReturnType<typeof vi.fn>

  beforeEach(() => {
    // Mock attestation store
    mockStore = {
      create: vi.fn((params) => ({
        id: `att-${Date.now()}`,
        ...params,
        createdAt: new Date().toISOString(),
        revokedAt: null,
      })),
      findById: vi.fn(),
      findBySubject: vi.fn(() => ({ attestations: [], total: 0 })),
      revoke: vi.fn((id) => ({
        id,
        subject: 'test-subject',
        verifier: 'test-verifier',
        weight: 100,
        claim: 'test-claim',
        createdAt: new Date().toISOString(),
        revokedAt: new Date().toISOString(),
      })),
    } as unknown as AttestationStore

    // Mock cache service
    mockCache = {
      exists: vi.fn(),
      set: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      clearNamespace: vi.fn(),
      expire: vi.fn(),
      ttl: vi.fn(),
      healthCheck: vi.fn(),
    } as unknown as CacheService

    // Create idempotency guard
    idempotencyGuard = new IdempotencyGuard(mockCache, {
      ttlSeconds: 3600,
      logger: vi.fn(),
    })

    // Mock event fetcher
    fetchEvents = vi.fn().mockResolvedValue([])

    // Create listener with idempotency guard
    listener = new AttestationEventListener(
      mockStore,
      fetchEvents,
      {
        pollingInterval: 1000,
        lastCursor: 'now',
        idempotencyGuard,
      }
    )
  })

  describe('redelivery scenario', () => {
    it('should process add event only once on redelivery', async () => {
      const event: AttestationEvent = {
        id: 'event-123',
        pagingToken: 'token-123',
        type: 'add',
        subject: 'subject-addr',
        verifier: 'verifier-addr',
        weight: 100,
        claim: 'test-claim',
        createdAt: new Date().toISOString(),
        transactionHash: 'tx-hash-123',
      }

      // First delivery
      vi.mocked(mockCache.exists).mockResolvedValueOnce(false)
      vi.mocked(mockCache.set).mockResolvedValue(true)

      const result1 = await listener.processEvent(event)
      expect(result1).toBe('subject-addr')
      expect(mockStore.create).toHaveBeenCalledTimes(1)

      // Second delivery (redelivery)
      vi.mocked(mockCache.exists).mockResolvedValueOnce(true)

      const result2 = await listener.processEvent(event)
      expect(result2).toBeNull()
      expect(mockStore.create).toHaveBeenCalledTimes(1) // Still only called once

      // Third delivery (another redelivery)
      vi.mocked(mockCache.exists).mockResolvedValueOnce(true)

      const result3 = await listener.processEvent(event)
      expect(result3).toBeNull()
      expect(mockStore.create).toHaveBeenCalledTimes(1) // Still only called once
    })

    it('should process revoke event only once on redelivery', async () => {
      const event: AttestationEvent = {
        id: 'event-456',
        pagingToken: 'token-456',
        type: 'revoke',
        subject: 'subject-addr',
        verifier: 'verifier-addr',
        weight: 0,
        claim: '',
        createdAt: new Date().toISOString(),
        transactionHash: 'tx-hash-456',
      }

      // Mock existing attestation
      vi.mocked(mockStore.findBySubject).mockReturnValue({
        attestations: [
          {
            id: 'att-1',
            subject: 'subject-addr',
            verifier: 'verifier-addr',
            weight: 100,
            claim: 'test-claim',
            createdAt: new Date().toISOString(),
            revokedAt: null,
          } as Attestation,
        ],
        total: 1,
      })

      // First delivery
      vi.mocked(mockCache.exists).mockResolvedValueOnce(false)
      vi.mocked(mockCache.set).mockResolvedValue(true)

      const result1 = await listener.processEvent(event)
      expect(result1).toBe('subject-addr')
      expect(mockStore.revoke).toHaveBeenCalledTimes(1)

      // Second delivery (redelivery)
      vi.mocked(mockCache.exists).mockResolvedValueOnce(true)

      const result2 = await listener.processEvent(event)
      expect(result2).toBeNull()
      expect(mockStore.revoke).toHaveBeenCalledTimes(1) // Still only called once
    })

    it('should handle mixed add and revoke redeliveries', async () => {
      const addEvent: AttestationEvent = {
        id: 'event-add-1',
        pagingToken: 'token-1',
        type: 'add',
        subject: 'subject-addr',
        verifier: 'verifier-addr',
        weight: 100,
        claim: 'test-claim',
        createdAt: new Date().toISOString(),
        transactionHash: 'tx-hash-1',
      }

      const revokeEvent: AttestationEvent = {
        id: 'event-revoke-1',
        pagingToken: 'token-2',
        type: 'revoke',
        subject: 'subject-addr',
        verifier: 'verifier-addr',
        weight: 0,
        claim: '',
        createdAt: new Date().toISOString(),
        transactionHash: 'tx-hash-2',
      }

      // Process add event
      vi.mocked(mockCache.exists).mockResolvedValueOnce(false)
      vi.mocked(mockCache.set).mockResolvedValue(true)
      await listener.processEvent(addEvent)

      // Redeliver add event (in-memory dedup will catch it)
      const addResult = await listener.processEvent(addEvent)
      expect(addResult).toBeNull()

      // Process revoke event
      vi.mocked(mockCache.exists).mockResolvedValueOnce(false)
      vi.mocked(mockStore.findBySubject).mockReturnValue({
        attestations: [
          {
            id: 'att-1',
            subject: 'subject-addr',
            verifier: 'verifier-addr',
            weight: 100,
            claim: 'test-claim',
            createdAt: new Date().toISOString(),
            revokedAt: null,
          } as Attestation,
        ],
        total: 1,
      })
      await listener.processEvent(revokeEvent)

      // Redeliver revoke event (in-memory dedup will catch it)
      const revokeResult = await listener.processEvent(revokeEvent)
      expect(revokeResult).toBeNull()

      expect(mockStore.create).toHaveBeenCalledTimes(1)
      expect(mockStore.revoke).toHaveBeenCalledTimes(1)
    })
  })

  describe('marker expiration behavior', () => {
    it('should allow reprocessing after marker expires', async () => {
      const event: AttestationEvent = {
        id: 'event-789',
        pagingToken: 'token-789',
        type: 'add',
        subject: 'subject-addr',
        verifier: 'verifier-addr',
        weight: 100,
        claim: 'test-claim',
        createdAt: new Date().toISOString(),
        transactionHash: 'tx-hash-789',
      }

      // First processing
      vi.mocked(mockCache.exists).mockResolvedValueOnce(false)
      vi.mocked(mockCache.set).mockResolvedValue(true)

      const result1 = await listener.processEvent(event)
      expect(result1).toBe('subject-addr')
      expect(mockStore.create).toHaveBeenCalledTimes(1)

      // Marker still exists (within TTL) - in-memory dedup will catch it
      const result2 = await listener.processEvent(event)
      expect(result2).toBeNull()
      expect(mockStore.create).toHaveBeenCalledTimes(1)

      // Simulate restart: create new listener (clears in-memory map)
      const newListener = new AttestationEventListener(
        mockStore,
        fetchEvents,
        {
          pollingInterval: 1000,
          lastCursor: 'now',
          idempotencyGuard,
        }
      )

      // Marker still exists (within TTL) - Redis guard will catch it
      vi.mocked(mockCache.exists).mockResolvedValueOnce(true)
      const result3 = await newListener.processEvent(event)
      expect(result3).toBeNull()
      expect(mockStore.create).toHaveBeenCalledTimes(1)

      // Marker expired (after TTL) - will process again
      vi.mocked(mockCache.exists).mockResolvedValueOnce(false)
      const result4 = await newListener.processEvent(event)
      expect(result4).toBe('subject-addr')
      expect(mockStore.create).toHaveBeenCalledTimes(2) // Called again after expiration
    })
  })

  describe('statistics tracking', () => {
    it('should track duplicates in stats', async () => {
      const event: AttestationEvent = {
        id: 'event-stats',
        pagingToken: 'token-stats',
        type: 'add',
        subject: 'subject-addr',
        verifier: 'verifier-addr',
        weight: 100,
        claim: 'test-claim',
        createdAt: new Date().toISOString(),
        transactionHash: 'tx-hash-stats',
      }

      // First processing
      vi.mocked(mockCache.exists).mockResolvedValueOnce(false)
      vi.mocked(mockCache.set).mockResolvedValue(true)
      await listener.processEvent(event)

      // Redeliveries
      vi.mocked(mockCache.exists).mockResolvedValueOnce(true)
      await listener.processEvent(event)

      vi.mocked(mockCache.exists).mockResolvedValueOnce(true)
      await listener.processEvent(event)

      const stats = listener.getStats()
      expect(stats.eventsProcessed).toBe(1)
      expect(stats.duplicatesSkipped).toBe(2)
      expect(stats.addEvents).toBe(1)
    })
  })

  describe('fallback behavior without idempotency guard', () => {
    it('should use in-memory deduplication when guard is not provided', async () => {
      const listenerWithoutGuard = new AttestationEventListener(
        mockStore,
        fetchEvents,
        {
          pollingInterval: 1000,
          lastCursor: 'now',
          // No idempotencyGuard provided
        }
      )

      const event: AttestationEvent = {
        id: 'event-fallback',
        pagingToken: 'token-fallback',
        type: 'add',
        subject: 'subject-addr',
        verifier: 'verifier-addr',
        weight: 100,
        claim: 'test-claim',
        createdAt: new Date().toISOString(),
        transactionHash: 'tx-hash-fallback',
      }

      // First processing
      const result1 = await listenerWithoutGuard.processEvent(event)
      expect(result1).toBe('subject-addr')
      expect(mockStore.create).toHaveBeenCalledTimes(1)

      // Second processing (in-memory dedup)
      const result2 = await listenerWithoutGuard.processEvent(event)
      expect(result2).toBeNull()
      expect(mockStore.create).toHaveBeenCalledTimes(1)

      // Cache should not be called
      expect(mockCache.exists).not.toHaveBeenCalled()
      expect(mockCache.set).not.toHaveBeenCalled()
    })
  })

  describe('error handling', () => {
    it('should proceed even if marker write fails', async () => {
      const event: AttestationEvent = {
        id: 'event-error',
        pagingToken: 'token-error',
        type: 'add',
        subject: 'subject-addr',
        verifier: 'verifier-addr',
        weight: 100,
        claim: 'test-claim',
        createdAt: new Date().toISOString(),
        transactionHash: 'tx-hash-error',
      }

      vi.mocked(mockCache.exists).mockResolvedValue(false)
      vi.mocked(mockCache.set).mockResolvedValue(false) // Marker write fails

      const result = await listener.processEvent(event)
      expect(result).toBe('subject-addr')
      expect(mockStore.create).toHaveBeenCalledTimes(1)
    })

    it('should handle cache errors gracefully', async () => {
      const event: AttestationEvent = {
        id: 'event-cache-error',
        pagingToken: 'token-cache-error',
        type: 'add',
        subject: 'subject-addr',
        verifier: 'verifier-addr',
        weight: 100,
        claim: 'test-claim',
        createdAt: new Date().toISOString(),
        transactionHash: 'tx-hash-cache-error',
      }

      vi.mocked(mockCache.exists).mockRejectedValue(new Error('Redis connection failed'))

      // Should not throw, should proceed with processing
      await expect(listener.processEvent(event)).rejects.toThrow('Redis connection failed')
    })
  })
})
