import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SettlementService } from './settlementService.js'
import { SettlementsRepository, Settlement, CreateSettlementInput } from '../db/repositories/settlementsRepository.js'
import { cache } from '../cache/redis.js'
import * as metrics from '../middleware/metrics.js'

// Mock dependencies
vi.mock('../cache/redis.js', () => ({
  cache: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn()
  }
}))

vi.mock('../middleware/metrics.js', () => ({
  recordStaleCacheRead: vi.fn()
}))

describe('SettlementService', () => {
  let settlementService: SettlementService
  let mockSettlementsRepository: any

  const mockDate = new Date()
  
  const mockSettlement: Settlement = {
    id: 1,
    bondId: 100,
    amount: '500',
    transactionHash: '0x123abc',
    settledAt: mockDate,
    status: 'pending',
    createdAt: mockDate,
    updatedAt: mockDate
  }

  beforeEach(() => {
    vi.clearAllMocks()

    mockSettlementsRepository = {
      upsert: vi.fn(),
      findByTransactionHash: vi.fn(),
    }
    
    settlementService = new SettlementService(mockSettlementsRepository as unknown as SettlementsRepository)
  })

  describe('getSettlementByHash', () => {
    it('should return cached settlement and re-hydrate dates if found in cache', async () => {
      // Redis serializes dates to strings
      const jsonCached = {
        ...mockSettlement,
        settledAt: mockDate.toISOString(),
        createdAt: mockDate.toISOString(),
        updatedAt: mockDate.toISOString()
      }
      
      vi.mocked(cache.get).mockResolvedValue(jsonCached as any)

      const result = await settlementService.getSettlementByHash('0x123abc')

      expect(cache.get).toHaveBeenCalledWith('settlement', '0x123abc')
      expect(mockSettlementsRepository.findByTransactionHash).not.toHaveBeenCalled()
      expect(result).toEqual(mockSettlement)
    })

    it('should fetch from DB and set cache with TTL if not in cache', async () => {
      vi.mocked(cache.get).mockResolvedValue(null)
      mockSettlementsRepository.findByTransactionHash.mockResolvedValue(mockSettlement)

      const result = await settlementService.getSettlementByHash('0x123abc')

      expect(cache.get).toHaveBeenCalledWith('settlement', '0x123abc')
      expect(mockSettlementsRepository.findByTransactionHash).toHaveBeenCalledWith('0x123abc')
      // Ensure TTL is set to 300 seconds
      expect(cache.set).toHaveBeenCalledWith('settlement', '0x123abc', mockSettlement, 300)
      expect(result).toEqual(mockSettlement)
    })
  })

  describe('upsertSettlementStatus', () => {
    it('should invalidate cache post-commit and not trigger stale read metric if cache deletes successfully', async () => {
      const input: CreateSettlementInput = {
        bondId: 100,
        amount: '500',
        transactionHash: '0x123abc',
        status: 'settled'
      }
      
      const updatedSettlement = { ...mockSettlement, status: 'settled' }
      mockSettlementsRepository.upsert.mockResolvedValue({ settlement: updatedSettlement })
      
      // Simulate cache deleting successfully (subsequent get returns null)
      vi.mocked(cache.get).mockResolvedValue(null)

      const result = await settlementService.upsertSettlementStatus(input)

      expect(mockSettlementsRepository.upsert).toHaveBeenCalledWith(input)
      expect(cache.delete).toHaveBeenCalledWith('settlement', '0x123abc')
      expect(cache.get).toHaveBeenCalledWith('settlement', '0x123abc')
      expect(metrics.recordStaleCacheRead).not.toHaveBeenCalled()
      expect(result).toEqual(updatedSettlement)
    })

    it('should trigger stale-read metric if cache returns old data post-invalidation', async () => {
      const input: CreateSettlementInput = {
        bondId: 100,
        amount: '500',
        transactionHash: '0x123abc',
        status: 'settled'
      }
      
      const updatedSettlement = { ...mockSettlement, status: 'settled' }
      mockSettlementsRepository.upsert.mockResolvedValue({ settlement: updatedSettlement })
      
      // Simulate cache race condition where it still holds the old data
      const staleCachedData = { ...updatedSettlement, status: 'pending' }
      vi.mocked(cache.get).mockResolvedValue(staleCachedData as any)

      const result = await settlementService.upsertSettlementStatus(input)

      expect(cache.delete).toHaveBeenCalledWith('settlement', '0x123abc')
      expect(cache.get).toHaveBeenCalledWith('settlement', '0x123abc')
      expect(metrics.recordStaleCacheRead).toHaveBeenCalledWith('settlement')
      expect(result).toEqual(updatedSettlement)
    })
  })
})
