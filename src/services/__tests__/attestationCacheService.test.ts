/**
 * Tests for AttestationCacheService
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AttestationCacheService } from '../attestationCacheService.js'
import { AttestationsRepository } from '../../db/repositories/attestationsRepository.js'
import { cache } from '../../cache/redis.js'
import * as invalidation from '../../cache/invalidation.js'

vi.mock('../../cache/redis.js', () => ({
  cache: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    clearNamespace: vi.fn()
  }
}))

vi.mock('../../cache/invalidation.js', async () => {
  const actual = await vi.importActual('../../cache/invalidation.js')
  return {
    ...actual,
    invalidateCache: vi.fn()
  }
})

describe('AttestationCacheService', () => {
  let service: AttestationCacheService
  let mockRepository: AttestationsRepository

  const mockAttestation = {
    id: 1,
    bondId: 10,
    attesterAddress: '0xabc',
    subjectAddress: '0x123',
    score: 85,
    note: 'Good reputation',
    createdAt: new Date('2024-01-01')
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockRepository = {
      findById: vi.fn(),
      listBySubject: vi.fn(),
      listByBond: vi.fn(),
      updateScore: vi.fn(),
      create: vi.fn()
    } as any

    service = new AttestationCacheService(mockRepository)
  })

  describe('getAttestationById', () => {
    it('should return cached attestation if available', async () => {
      vi.mocked(cache.get).mockResolvedValue(mockAttestation)

      const result = await service.getAttestationById(1)

      expect(cache.get).toHaveBeenCalledWith('attestation', 'id:1')
      expect(mockRepository.findById).not.toHaveBeenCalled()
      expect(result).toEqual(mockAttestation)
    })

    it('should fetch from repository and cache if not in cache', async () => {
      vi.mocked(cache.get).mockResolvedValue(null)
      vi.mocked(mockRepository.findById).mockResolvedValue(mockAttestation)

      const result = await service.getAttestationById(1)

      expect(mockRepository.findById).toHaveBeenCalledWith(1)
      expect(cache.set).toHaveBeenCalledWith('attestation', 'id:1', mockAttestation, 300)
      expect(result).toEqual(mockAttestation)
    })
  })

  describe('getAttestationsBySubject', () => {
    it('should return cached attestations if available', async () => {
      vi.mocked(cache.get).mockResolvedValue([mockAttestation])

      const result = await service.getAttestationsBySubject('0x123')

      expect(cache.get).toHaveBeenCalledWith('attestation', 'subject:0x123')
      expect(mockRepository.listBySubject).not.toHaveBeenCalled()
      expect(result).toEqual([mockAttestation])
    })

    it('should fetch from repository and cache if not in cache', async () => {
      vi.mocked(cache.get).mockResolvedValue(null)
      vi.mocked(mockRepository.listBySubject).mockResolvedValue([mockAttestation])

      const result = await service.getAttestationsBySubject('0x123')

      expect(mockRepository.listBySubject).toHaveBeenCalledWith('0x123')
      expect(cache.set).toHaveBeenCalledWith('attestation', 'subject:0x123', [mockAttestation], 300)
      expect(result).toEqual([mockAttestation])
    })
  })

  describe('updateScore', () => {
    it('should update score and invalidate all related caches', async () => {
      const updatedAttestation = { ...mockAttestation, score: 95 }
      vi.mocked(mockRepository.updateScore).mockResolvedValue(updatedAttestation)

      const result = await service.updateScore(1, 95)

      expect(mockRepository.updateScore).toHaveBeenCalledWith(1, 95)
      expect(invalidation.invalidateCache).toHaveBeenCalledTimes(3)
      
      // Verify ID cache invalidation with score verification
      expect(invalidation.invalidateCache).toHaveBeenCalledWith(
        'attestation',
        'id:1',
        updatedAttestation,
        expect.objectContaining({ verify: true })
      )
      
      // Verify subject cache invalidation
      expect(invalidation.invalidateCache).toHaveBeenCalledWith(
        'attestation',
        'subject:0x123'
      )
      
      // Verify bond cache invalidation
      expect(invalidation.invalidateCache).toHaveBeenCalledWith(
        'attestation',
        'bond:10'
      )
      
      expect(result).toEqual(updatedAttestation)
    })

    it('should not invalidate if update returns null', async () => {
      vi.mocked(mockRepository.updateScore).mockResolvedValue(null)

      const result = await service.updateScore(1, 95)

      expect(invalidation.invalidateCache).not.toHaveBeenCalled()
      expect(result).toBeNull()
    })
  })

  describe('createAttestation', () => {
    it('should create attestation and invalidate related list caches', async () => {
      const input = {
        bondId: 10,
        attesterAddress: '0xabc',
        subjectAddress: '0x123',
        score: 85,
        note: 'Good reputation'
      }
      vi.mocked(mockRepository.create).mockResolvedValue(mockAttestation)

      const result = await service.createAttestation(input)

      expect(mockRepository.create).toHaveBeenCalledWith(input)
      expect(invalidation.invalidateCache).toHaveBeenCalledTimes(2)
      
      // Verify subject list cache invalidation
      expect(invalidation.invalidateCache).toHaveBeenCalledWith(
        'attestation',
        'subject:0x123'
      )
      
      // Verify bond list cache invalidation
      expect(invalidation.invalidateCache).toHaveBeenCalledWith(
        'attestation',
        'bond:10'
      )
      expect(cache.clearNamespace).toHaveBeenCalledWith('attestation')
      
      expect(result).toEqual(mockAttestation)
    })
  })
})
