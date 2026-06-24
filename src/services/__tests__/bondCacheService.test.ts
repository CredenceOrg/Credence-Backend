/**
 * Tests for BondCacheService
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BondCacheService } from '../bondCacheService.js'
import { BondsRepository } from '../../db/repositories/bondsRepository.js'
import { cache } from '../../cache/redis.js'
import * as invalidation from '../../cache/invalidation.js'

vi.mock('../../cache/redis.js', () => ({
  cache: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn()
  }
}))

vi.mock('../../cache/invalidation.js', async () => {
  const actual = await vi.importActual('../../cache/invalidation.js')
  return {
    ...actual,
    invalidateCache: vi.fn()
  }
})

describe('BondCacheService', () => {
  let service: BondCacheService
  let mockRepository: BondsRepository

  const mockBond = {
    id: 1,
    identityAddress: '0x123',
    amount: '1000000000000000000',
    startTime: new Date('2024-01-01'),
    durationDays: 365,
    status: 'active' as const,
    createdAt: new Date('2024-01-01')
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockRepository = {
      findById: vi.fn(),
      listByIdentity: vi.fn(),
      updateStatus: vi.fn(),
      debit: vi.fn()
    } as any

    service = new BondCacheService(mockRepository)
  })

  describe('getBondById', () => {
    it('should return cached bond if available', async () => {
      const cachedBond = { ...mockBond }
      vi.mocked(cache.get).mockResolvedValue(cachedBond)

      const result = await service.getBondById(1)

      expect(cache.get).toHaveBeenCalledWith('bond', 'id:1')
      expect(mockRepository.findById).not.toHaveBeenCalled()
      expect(result).toEqual(mockBond)
    })

    it('should fetch from repository and cache if not in cache', async () => {
      vi.mocked(cache.get).mockResolvedValue(null)
      vi.mocked(mockRepository.findById).mockResolvedValue(mockBond)

      const result = await service.getBondById(1)

      expect(cache.get).toHaveBeenCalledWith('bond', 'id:1')
      expect(mockRepository.findById).toHaveBeenCalledWith(1)
      expect(cache.set).toHaveBeenCalledWith('bond', 'id:1', mockBond, 300)
      expect(result).toEqual(mockBond)
    })

    it('should not cache if bond not found', async () => {
      vi.mocked(cache.get).mockResolvedValue(null)
      vi.mocked(mockRepository.findById).mockResolvedValue(null)

      const result = await service.getBondById(1)

      expect(cache.set).not.toHaveBeenCalled()
      expect(result).toBeNull()
    })
  })

  describe('getBondsByIdentity', () => {
    it('should return cached bonds if available', async () => {
      const cachedBonds = [mockBond]
      vi.mocked(cache.get).mockResolvedValue(cachedBonds)

      const result = await service.getBondsByIdentity('0x123')

      expect(cache.get).toHaveBeenCalledWith('bond', 'identity:0x123')
      expect(mockRepository.listByIdentity).not.toHaveBeenCalled()
      expect(result).toEqual(cachedBonds)
    })

    it('should fetch from repository and cache if not in cache', async () => {
      vi.mocked(cache.get).mockResolvedValue(null)
      vi.mocked(mockRepository.listByIdentity).mockResolvedValue([mockBond])

      const result = await service.getBondsByIdentity('0x123')

      expect(mockRepository.listByIdentity).toHaveBeenCalledWith('0x123')
      expect(cache.set).toHaveBeenCalledWith('bond', 'identity:0x123', [mockBond], 300)
      expect(result).toEqual([mockBond])
    })
  })

  describe('updateStatus', () => {
    it('should update status and invalidate caches', async () => {
      const updatedBond = { ...mockBond, status: 'released' as const }
      vi.mocked(mockRepository.updateStatus).mockResolvedValue(updatedBond)

      const result = await service.updateStatus(1, 'released')

      expect(mockRepository.updateStatus).toHaveBeenCalledWith(1, 'released')
      expect(invalidation.invalidateCache).toHaveBeenCalledTimes(2)
      expect(invalidation.invalidateCache).toHaveBeenCalledWith(
        'bond',
        'id:1',
        updatedBond,
        { verify: true }
      )
      expect(invalidation.invalidateCache).toHaveBeenCalledWith(
        'bond',
        'identity:0x123'
      )
      expect(result).toEqual(updatedBond)
    })

    it('should not invalidate if update returns null', async () => {
      vi.mocked(mockRepository.updateStatus).mockResolvedValue(null)

      const result = await service.updateStatus(1, 'released')

      expect(invalidation.invalidateCache).not.toHaveBeenCalled()
      expect(result).toBeNull()
    })
  })

  describe('debit', () => {
    it('should debit amount and invalidate caches', async () => {
      const debitedBond = { ...mockBond, amount: '500000000000000000' }
      vi.mocked(mockRepository.debit).mockResolvedValue(debitedBond)

      const result = await service.debit(1, '500000000000000000')

      expect(mockRepository.debit).toHaveBeenCalledWith(1, '500000000000000000')
      expect(invalidation.invalidateCache).toHaveBeenCalledTimes(2)
      expect(invalidation.invalidateCache).toHaveBeenCalledWith(
        'bond',
        'id:1',
        debitedBond,
        { verify: true }
      )
      expect(invalidation.invalidateCache).toHaveBeenCalledWith(
        'bond',
        'identity:0x123'
      )
      expect(result).toEqual(debitedBond)
    })
  })
})
