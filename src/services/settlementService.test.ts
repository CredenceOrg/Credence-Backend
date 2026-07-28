import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SettlementService } from './settlementService.js'
import { SettlementsRepository, Settlement, CreateSettlementInput } from '../db/repositories/settlementsRepository.js'
import { cache } from '../cache/redis.js'
import * as metrics from '../middleware/metrics.js'
import * as featureFlags from '../config/featureFlags.js'
import * as shadowWrite from './shadowWrite.js'
import * as invalidationModule from '../cache/invalidation.js'

// Mock dependencies
vi.mock('../cache/redis.js', () => ({
  cache: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    exists: vi.fn()
  }
}))

vi.mock('../middleware/metrics.js', () => ({
  recordStaleCacheRead: vi.fn(),
  recordSettlementDuplicate: vi.fn()
}))

vi.mock('../config/featureFlags.js', () => ({
  getFlag: vi.fn()
}))

vi.mock('./shadowWrite.js', () => ({
  executeShadowWrite: vi.fn()
}))

vi.mock('../cache/invalidation.js', () => ({
  invalidateCache: vi.fn()
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
    
    // Default: shadow write mode disabled
    vi.mocked(featureFlags.getFlag).mockReturnValue(false)

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
    it('should record settlement duplicate metric when isDuplicate is true', async () => {
      const input: CreateSettlementInput = {
        bondId: 100,
        amount: '500',
        transactionHash: '0x123abc',
        status: 'settled'
      }
      
      const updatedSettlement = { ...mockSettlement, status: 'settled' }
      mockSettlementsRepository.upsert.mockResolvedValue({ 
        settlement: updatedSettlement, 
        isDuplicate: true 
      })
      
      vi.mocked(cache.get).mockResolvedValue(null)

      const result = await settlementService.upsertSettlementStatus(input)

      expect(mockSettlementsRepository.upsert).toHaveBeenCalledWith(input)
      expect(metrics.recordSettlementDuplicate).toHaveBeenCalled()
      expect(result).toEqual(updatedSettlement)
    })

    it('should not record settlement duplicate metric when isDuplicate is false', async () => {
      const input: CreateSettlementInput = {
        bondId: 100,
        amount: '500',
        transactionHash: '0x123abc',
        status: 'pending'
      }
      
      mockSettlementsRepository.upsert.mockResolvedValue({ 
        settlement: mockSettlement, 
        isDuplicate: false 
      })
      
      vi.mocked(cache.get).mockResolvedValue(null)

      const result = await settlementService.upsertSettlementStatus(input)

      expect(mockSettlementsRepository.upsert).toHaveBeenCalledWith(input)
      expect(metrics.recordSettlementDuplicate).not.toHaveBeenCalled()
      expect(result).toEqual(mockSettlement)
    })

    it('should invalidate cache post-commit and not trigger stale read metric if cache deletes successfully', async () => {
      const input: CreateSettlementInput = {
        bondId: 100,
        amount: '500',
        transactionHash: '0x123abc',
        status: 'settled'
      }
      
      const updatedSettlement = { ...mockSettlement, status: 'settled' }
      mockSettlementsRepository.upsert.mockResolvedValue({ 
        settlement: updatedSettlement,
        isDuplicate: false 
      })
      
      vi.mocked(invalidationModule.invalidateCache).mockResolvedValue(undefined)

      const result = await settlementService.upsertSettlementStatus(input)

      expect(mockSettlementsRepository.upsert).toHaveBeenCalledWith(input)
      expect(invalidationModule.invalidateCache).toHaveBeenCalled()
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
      mockSettlementsRepository.upsert.mockResolvedValue({ 
        settlement: updatedSettlement,
        isDuplicate: false 
      })
      
      vi.mocked(invalidationModule.invalidateCache).mockResolvedValue(undefined)

      const result = await settlementService.upsertSettlementStatus(input)

      expect(invalidationModule.invalidateCache).toHaveBeenCalled()
      expect(result).toEqual(updatedSettlement)
    })

    it('should use shadow write when SHADOW_WRITE_MODE and NEW_PIPELINE are enabled', async () => {
      vi.mocked(featureFlags.getFlag).mockImplementation((flag) => {
        if (flag === 'shadowWriteMode') return true
        if (flag === 'newPipeline') return true
        return false
      })

      const input: CreateSettlementInput = {
        bondId: 100,
        amount: '500',
        transactionHash: '0x123abc',
        status: 'settled'
      }
      
      const updatedSettlement = { ...mockSettlement, status: 'settled' }
      vi.mocked(shadowWrite.executeShadowWrite).mockResolvedValue({
        primaryResult: { settlement: updatedSettlement, isDuplicate: false },
        hadMismatch: false
      })
      
      vi.mocked(cache.get).mockResolvedValue(null)

      const result = await settlementService.upsertSettlementStatus(input)

      expect(shadowWrite.executeShadowWrite).toHaveBeenCalledWith(
        mockSettlementsRepository,
        mockSettlementsRepository,
        input
      )
      expect(mockSettlementsRepository.upsert).not.toHaveBeenCalled()
      expect(result).toEqual(updatedSettlement)
    })

    it('should not use shadow write when only NEW_PIPELINE is enabled without SHADOW_WRITE_MODE', async () => {
      vi.mocked(featureFlags.getFlag).mockImplementation((flag) => {
        if (flag === 'newPipeline') return true
        return false
      })

      const input: CreateSettlementInput = {
        bondId: 100,
        amount: '500',
        transactionHash: '0x123abc',
        status: 'settled'
      }
      
      const updatedSettlement = { ...mockSettlement, status: 'settled' }
      mockSettlementsRepository.upsert.mockResolvedValue({
        settlement: updatedSettlement,
        isDuplicate: false
      })
      
      vi.mocked(cache.get).mockResolvedValue(null)

      const result = await settlementService.upsertSettlementStatus(input)

      expect(shadowWrite.executeShadowWrite).not.toHaveBeenCalled()
      expect(mockSettlementsRepository.upsert).toHaveBeenCalledWith(input)
      expect(result).toEqual(updatedSettlement)
    })

    it('should record settlement duplicate metric when using shadow write mode', async () => {
      vi.mocked(featureFlags.getFlag).mockImplementation((flag) => {
        if (flag === 'shadowWriteMode') return true
        if (flag === 'newPipeline') return true
        return false
      })

      const input: CreateSettlementInput = {
        bondId: 100,
        amount: '500',
        transactionHash: '0x123abc',
        status: 'settled'
      }
      
      const updatedSettlement = { ...mockSettlement, status: 'settled' }
      vi.mocked(shadowWrite.executeShadowWrite).mockResolvedValue({
        primaryResult: { settlement: updatedSettlement, isDuplicate: true },
        hadMismatch: false
      })
      
      vi.mocked(cache.get).mockResolvedValue(null)

      const result = await settlementService.upsertSettlementStatus(input)

      expect(metrics.recordSettlementDuplicate).toHaveBeenCalled()
      expect(result).toEqual(updatedSettlement)
    })
  })
})
