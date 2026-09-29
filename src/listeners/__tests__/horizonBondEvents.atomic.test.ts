import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import { AtomicBondEventProcessor } from '../horizonBondEvents.atomic.js'
import { TransactionManager } from '../../db/transaction.js'
import { IdempotencyRepository } from '../../db/repositories/idempotencyRepository.js'

// Mock dependencies
vi.mock('../../services/identityService.js', () => ({
  upsertIdentity: vi.fn(),
  upsertBond: vi.fn(),
  upsertCursor: vi.fn(),
}))

vi.mock('../../services/reputationService.js', () => ({
  invalidateTrustScoreCache: vi.fn(),
}))

vi.mock('../../db/outbox/emitter.js', () => ({
  outboxEmitter: {
    emitBatch: vi.fn(),
  },
}))

vi.mock('../../db/repositories/idempotencyRepository.js', () => ({
  IdempotencyRepository: vi.fn().mockImplementation(() => ({
    findByKey: vi.fn(),
    create: vi.fn(),
  })),
}))

import { upsertIdentity, upsertBond } from '../../services/identityService.js'
import { invalidateTrustScoreCache } from '../../services/reputationService.js'
import { outboxEmitter } from '../../db/outbox/emitter.js'

describe('AtomicBondEventProcessor', () => {
  let processor: AtomicBondEventProcessor
  let mockPool: Pool
  let mockClient: PoolClient

  const sampleEvent = {
    identity: { id: 'GABC123' },
    bond: { 
      id: 'bond-1', 
      address: 'GABC123', 
      amount: '100.50', 
      duration: '365' 
    },
    pagingToken: '123456',
    operationId: 'op-123',
  }

  beforeEach(() => {
    vi.clearAllMocks()

    mockClient = {
      query: vi.fn(),
      release: vi.fn(),
    } as any

    mockPool = {
      connect: vi.fn().mockResolvedValue(mockClient),
      query: vi.fn(),
    } as any

    processor = new AtomicBondEventProcessor(mockPool)
  })

  describe('atomic state mutation + outbox emission', () => {
    it('commits state and outbox events together', async () => {
      const idempotencyRepo = (IdempotencyRepository as any).mock.results[0].value
      idempotencyRepo.findByKey.mockResolvedValue(null)

      await processor.process(sampleEvent)

      // Verify identity and bond were upserted
      expect(upsertIdentity).toHaveBeenCalledWith(sampleEvent.identity, expect.anything())
      expect(upsertBond).toHaveBeenCalledWith(sampleEvent.bond, expect.anything())

      // Verify outbox events were emitted
      expect(outboxEmitter.emitBatch).toHaveBeenCalledWith(
        expect.anything(),
        expect.arrayContaining([
          expect.objectContaining({
            aggregateType: 'bond',
            eventType: 'bond.created',
          }),
          expect.objectContaining({
            aggregateType: 'identity',
            eventType: 'identity.bond_created',
          }),
        ])
      )

      // Verify cache invalidation happened post-commit
      expect(invalidateTrustScoreCache).toHaveBeenCalledWith('GABC123')
    })

    it('rolls back state if outbox emission fails', async () => {
      const idempotencyRepo = (IdempotencyRepository as any).mock.results[0].value
      idempotencyRepo.findByKey.mockResolvedValue(null)
      
      ;(outboxEmitter.emitBatch as any).mockRejectedValueOnce(
        new Error('Outbox insert failed')
      )

      await expect(processor.process(sampleEvent)).rejects.toThrow('Outbox insert failed')

      // Verify no cache invalidation on failure
      expect(invalidateTrustScoreCache).not.toHaveBeenCalled()
    })

    it('rolls back if idempotency marker creation fails', async () => {
      const idempotencyRepo = (IdempotencyRepository as any).mock.results[0].value
      idempotencyRepo.findByKey.mockResolvedValue(null)
      idempotencyRepo.create.mockRejectedValueOnce(
        new Error('Idempotency insert failed')
      )

      await expect(processor.process(sampleEvent)).rejects.toThrow('Idempotency insert failed')
      expect(invalidateTrustScoreCache).not.toHaveBeenCalled()
    })
  })

  describe('idempotency and replay protection', () => {
    it('skips already-processed events', async () => {
      const idempotencyRepo = (IdempotencyRepository as any).mock.results[0].value
      idempotencyRepo.findByKey.mockResolvedValue({ id: 'existing' })

      await processor.process(sampleEvent)

      // No state changes or outbox events
      expect(upsertIdentity).not.toHaveBeenCalled()
      expect(upsertBond).not.toHaveBeenCalled()
      expect(outboxEmitter.emitBatch).not.toHaveBeenCalled()
      expect(invalidateTrustScoreCache).not.toHaveBeenCalled()
    })

    it('creates idempotency marker within transaction', async () => {
      const idempotencyRepo = (IdempotencyRepository as any).mock.results[0].value
      idempotencyRepo.findByKey.mockResolvedValue(null)

      await processor.process(sampleEvent)

      expect(idempotencyRepo.create).toHaveBeenCalledWith(
        expect.stringContaining('bond_creation:op-123'),
        'op-123',
        expect.anything()
      )
    })
  })

  describe('failure injection at boundaries', () => {
    it.each([
      ['identity upsert', () => (upsertIdentity as any).mockRejectedValueOnce(new Error('Identity failed'))],
      ['bond upsert', () => (upsertBond as any).mockRejectedValueOnce(new Error('Bond failed'))],
      ['outbox emit', () => (outboxEmitter.emitBatch as any).mockRejectedValueOnce(new Error('Outbox failed'))],
    ])('handles %s failure atomically', async (_name, setupFailure) => {
      const idempotencyRepo = (IdempotencyRepository as any).mock.results[0].value
      idempotencyRepo.findByKey.mockResolvedValue(null)
      setupFailure()

      await expect(processor.process(sampleEvent)).rejects.toThrow()

      // No partial state or cache invalidation
      expect(invalidateTrustScoreCache).not.toHaveBeenCalled()
    })

    it('handles concurrent processing with idempotency', async () => {
      const idempotencyRepo = (IdempotencyRepository as any).mock.results[0].value
      
      // First call succeeds, second finds existing marker
      idempotencyRepo.findByKey
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'concurrent' })

      await processor.process(sampleEvent)
      await processor.process(sampleEvent)

      // Only one actual processing
      expect(upsertIdentity).toHaveBeenCalledTimes(1)
      expect(upsertBond).toHaveBeenCalledTimes(1)
      expect(outboxEmitter.emitBatch).toHaveBeenCalledTimes(1)
    })
  })

  describe('cache invalidation safety', () => {
    it('invalidates cache only after successful commit', async () => {
      const idempotencyRepo = (IdempotencyRepository as any).mock.results[0].value
      idempotencyRepo.findByKey.mockResolvedValue(null)

      const callOrder: string[] = []
      ;(upsertIdentity as any).mockImplementation(async () => {
        callOrder.push('state')
      })
      ;(upsertBond as any).mockImplementation(async () => {
        callOrder.push('state')
      })
      ;(outboxEmitter.emitBatch as any).mockImplementation(async () => {
        callOrder.push('outbox')
        return [1n, 2n]
      })
      ;(invalidateTrustScoreCache as any).mockImplementation(async () => {
        callOrder.push('cache')
      })

      await processor.process(sampleEvent)

      expect(callOrder).toEqual(['state', 'state', 'outbox', 'cache'])
    })
  })
})
