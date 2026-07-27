import { describe, it, expect, vi, beforeEach } from 'vitest'
import { diffAndRecordShadowWrites, executeShadowWrite, type ShadowWriteResult } from './shadowWrite'
import * as metricsModule from '../middleware/metrics.js'
import type { Settlement, SettlementsRepository, CreateSettlementInput, UpsertSettlementResult } from '../db/repositories/settlementsRepository.js'

// Mock the metrics module
vi.mock('../middleware/metrics.js')

describe('shadowWrite', () => {
  const mockRecordShadowWriteMismatch = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(metricsModule.recordShadowWriteMismatch).mockImplementation(mockRecordShadowWriteMismatch)
  })

  const createMockSettlement = (overrides?: Partial<Settlement>): Settlement => ({
    id: '1',
    bondId: '100',
    amount: '1000000',
    transactionHash: '0x' + 'a'.repeat(64),
    settledAt: new Date(),
    status: 'settled',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  })

  describe('diffAndRecordShadowWrites', () => {
    it('returns false when both pipelines succeed with identical results', () => {
      const settlement = createMockSettlement()
      const result: ShadowWriteResult = {
        oldResult: { settlement, isDuplicate: false },
        newResult: { settlement, isDuplicate: false },
      }

      const hasMismatch = diffAndRecordShadowWrites(result)

      expect(hasMismatch).toBe(false)
      expect(mockRecordShadowWriteMismatch).not.toHaveBeenCalled()
    })

    it('records error_mismatch when only old pipeline fails', () => {
      const settlement = createMockSettlement()
      const result: ShadowWriteResult = {
        oldResult: undefined as any,
        newResult: { settlement, isDuplicate: false },
        oldError: new Error('Old pipeline error'),
      }

      const hasMismatch = diffAndRecordShadowWrites(result)

      expect(hasMismatch).toBe(true)
      expect(mockRecordShadowWriteMismatch).toHaveBeenCalledWith('error_mismatch')
    })

    it('records error_mismatch when only new pipeline fails', () => {
      const settlement = createMockSettlement()
      const result: ShadowWriteResult = {
        oldResult: { settlement, isDuplicate: false },
        newResult: undefined as any,
        newError: new Error('New pipeline error'),
      }

      const hasMismatch = diffAndRecordShadowWrites(result)

      expect(hasMismatch).toBe(true)
      expect(mockRecordShadowWriteMismatch).toHaveBeenCalledWith('error_mismatch')
    })

    it('returns false when both pipelines fail (consistent behavior)', () => {
      const result: ShadowWriteResult = {
        oldResult: undefined as any,
        newResult: undefined as any,
        oldError: new Error('Error'),
        newError: new Error('Error'),
      }

      const hasMismatch = diffAndRecordShadowWrites(result)

      expect(hasMismatch).toBe(false)
      expect(mockRecordShadowWriteMismatch).not.toHaveBeenCalled()
    })

    it('records status_mismatch when status differs', () => {
      const oldSettlement = createMockSettlement({ status: 'settled' })
      const newSettlement = createMockSettlement({ status: 'pending' })
      const result: ShadowWriteResult = {
        oldResult: { settlement: oldSettlement, isDuplicate: false },
        newResult: { settlement: newSettlement, isDuplicate: false },
      }

      const hasMismatch = diffAndRecordShadowWrites(result)

      expect(hasMismatch).toBe(true)
      expect(mockRecordShadowWriteMismatch).toHaveBeenCalledWith('status_mismatch')
    })

    it('records data_mismatch when amount differs', () => {
      const oldSettlement = createMockSettlement({ amount: '1000000' })
      const newSettlement = createMockSettlement({ amount: '2000000' })
      const result: ShadowWriteResult = {
        oldResult: { settlement: oldSettlement, isDuplicate: false },
        newResult: { settlement: newSettlement, isDuplicate: false },
      }

      const hasMismatch = diffAndRecordShadowWrites(result)

      expect(hasMismatch).toBe(true)
      expect(mockRecordShadowWriteMismatch).toHaveBeenCalledWith('data_mismatch')
    })

    it('records data_mismatch when bondId differs', () => {
      const oldSettlement = createMockSettlement({ bondId: '100' })
      const newSettlement = createMockSettlement({ bondId: '200' })
      const result: ShadowWriteResult = {
        oldResult: { settlement: oldSettlement, isDuplicate: false },
        newResult: { settlement: newSettlement, isDuplicate: false },
      }

      const hasMismatch = diffAndRecordShadowWrites(result)

      expect(hasMismatch).toBe(true)
      expect(mockRecordShadowWriteMismatch).toHaveBeenCalledWith('data_mismatch')
    })

    it('records data_mismatch when isDuplicate differs', () => {
      const settlement = createMockSettlement()
      const result: ShadowWriteResult = {
        oldResult: { settlement, isDuplicate: true },
        newResult: { settlement, isDuplicate: false },
      }

      const hasMismatch = diffAndRecordShadowWrites(result)

      expect(hasMismatch).toBe(true)
      expect(mockRecordShadowWriteMismatch).toHaveBeenCalledWith('data_mismatch')
    })

    it('detects multiple mismatches', () => {
      const oldSettlement = createMockSettlement({ status: 'settled', amount: '1000000' })
      const newSettlement = createMockSettlement({ status: 'pending', amount: '2000000' })
      const result: ShadowWriteResult = {
        oldResult: { settlement: oldSettlement, isDuplicate: false },
        newResult: { settlement: newSettlement, isDuplicate: false },
      }

      const hasMismatch = diffAndRecordShadowWrites(result)

      expect(hasMismatch).toBe(true)
      expect(mockRecordShadowWriteMismatch).toHaveBeenCalledTimes(2)
      expect(mockRecordShadowWriteMismatch).toHaveBeenCalledWith('status_mismatch')
      expect(mockRecordShadowWriteMismatch).toHaveBeenCalledWith('data_mismatch')
    })
  })

  describe('executeShadowWrite', () => {
    it('executes both repositories in parallel and returns old result', async () => {
      const settlement = createMockSettlement()
      const input: CreateSettlementInput = {
        bondId: '100',
        amount: '1000000',
        transactionHash: settlement.transactionHash,
      }

      const mockOldRepository = {
        upsert: vi.fn().mockResolvedValue({ settlement, isDuplicate: false }),
      } as unknown as SettlementsRepository

      const mockNewRepository = {
        upsert: vi.fn().mockResolvedValue({ settlement, isDuplicate: false }),
      } as unknown as SettlementsRepository

      const result = await executeShadowWrite(mockOldRepository, mockNewRepository, input)

      expect(result.primaryResult).toEqual({ settlement, isDuplicate: false })
      expect(result.hadMismatch).toBe(false)
      expect(mockOldRepository.upsert).toHaveBeenCalledWith(input)
      expect(mockNewRepository.upsert).toHaveBeenCalledWith(input)
    })

    it('returns old result even if new pipeline fails', async () => {
      const settlement = createMockSettlement()
      const input: CreateSettlementInput = {
        bondId: '100',
        amount: '1000000',
        transactionHash: settlement.transactionHash,
      }

      const mockOldRepository = {
        upsert: vi.fn().mockResolvedValue({ settlement, isDuplicate: false }),
      } as unknown as SettlementsRepository

      const mockNewRepository = {
        upsert: vi.fn().mockRejectedValue(new Error('New pipeline error')),
      } as unknown as SettlementsRepository

      const result = await executeShadowWrite(mockOldRepository, mockNewRepository, input)

      expect(result.primaryResult).toEqual({ settlement, isDuplicate: false })
      expect(result.hadMismatch).toBe(true)
      expect(mockRecordShadowWriteMismatch).toHaveBeenCalledWith('error_mismatch')
    })

    it('throws if old pipeline fails', async () => {
      const settlement = createMockSettlement()
      const input: CreateSettlementInput = {
        bondId: '100',
        amount: '1000000',
        transactionHash: settlement.transactionHash,
      }

      const mockOldRepository = {
        upsert: vi.fn().mockRejectedValue(new Error('Old pipeline error')),
      } as unknown as SettlementsRepository

      const mockNewRepository = {
        upsert: vi.fn().mockResolvedValue({ settlement, isDuplicate: false }),
      } as unknown as SettlementsRepository

      await expect(executeShadowWrite(mockOldRepository, mockNewRepository, input)).rejects.toThrow(
        'Old pipeline error'
      )
    })

    it('detects mismatches during parallel execution', async () => {
      const oldSettlement = createMockSettlement({ status: 'settled' })
      const newSettlement = createMockSettlement({ status: 'pending' })
      const input: CreateSettlementInput = {
        bondId: '100',
        amount: '1000000',
        transactionHash: oldSettlement.transactionHash,
      }

      const mockOldRepository = {
        upsert: vi.fn().mockResolvedValue({ settlement: oldSettlement, isDuplicate: false }),
      } as unknown as SettlementsRepository

      const mockNewRepository = {
        upsert: vi.fn().mockResolvedValue({ settlement: newSettlement, isDuplicate: false }),
      } as unknown as SettlementsRepository

      const result = await executeShadowWrite(mockOldRepository, mockNewRepository, input)

      expect(result.hadMismatch).toBe(true)
      expect(mockRecordShadowWriteMismatch).toHaveBeenCalledWith('status_mismatch')
    })
  })
})
