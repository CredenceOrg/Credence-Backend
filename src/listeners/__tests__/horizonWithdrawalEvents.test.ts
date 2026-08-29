import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { compareDecimals } from '../../lib/decimalMath.js'

// Mock Stellar SDK before importing the module
vi.mock('@stellar/stellar-sdk', () => {
  const mockServer = {
    operations: vi.fn().mockReturnValue({
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      cursor: vi.fn().mockReturnThis(),
      call: vi.fn()
    })
  }

  return {
    Horizon: {
      Server: class MockServer {
        constructor(url: string) {
          return mockServer
        }
      }
    }
  }
})

vi.mock('../../services/identityService.js', () => ({
  upsertCursor: vi.fn().mockResolvedValue(undefined),
}))

// Import after mocking
import { HorizonWithdrawalListener, createHorizonWithdrawalListener } from '../horizonWithdrawalEvents.js'
import { CursorRepository } from '../../db/repositories/cursorRepository.js'
import { upsertCursor } from '../../services/identityService.js'

/**
 * A minimal in-memory stand-in for a `pg` Pool that backs BOTH the raw
 * `pool.query(...)` calls made directly by `IdempotencyRepository` and the
 * checked-out `client` used for the withdrawal listener's own BEGIN/COMMIT
 * transactions. Persisting `idempotency_keys` rows in a real Map (rather
 * than mocking `IdempotencyRepository` away entirely) means the tests below
 * exercise the REAL `IdempotentConsumer` + `IdempotencyRepository` dedup
 * logic, not just an assumption about how it behaves.
 */
function makeMockPool() {
  const idempotencyRows = new Map<string, any>()

  const client = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  }

  const query = vi.fn(async (text: string, params?: any[]) => {
    if (text.includes('FROM idempotency_keys')) {
      const key = params?.[0]
      const row = idempotencyRows.get(key)
      if (!row || new Date(row.expires_at).getTime() <= Date.now()) return { rows: [] }
      return { rows: [row] }
    }
    if (text.includes('INSERT INTO idempotency_keys')) {
      const [key, actorId, requestHash, responseCode, responseBody, ttlSeconds, expiresAt] = params!
      idempotencyRows.set(key, {
        key,
        actor_id: actorId,
        request_hash: requestHash,
        response_code: responseCode,
        response_body: responseBody,
        ttl_seconds: ttlSeconds,
        expires_at: expiresAt,
        created_at: new Date(),
      })
      return { rows: [], rowCount: 1 }
    }
    if (text.includes('DELETE FROM idempotency_keys')) {
      idempotencyRows.delete(params?.[0])
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  })

  const pool = {
    connect: vi.fn().mockResolvedValue(client),
    query,
  }

  return { pool, client, idempotencyRows }
}

describe('HorizonWithdrawalListener', () => {
  let listener: HorizonWithdrawalListener

  beforeEach(() => {
    vi.clearAllMocks()
    
    // Spy on prototype methods to prevent real database queries
    vi.spyOn(CursorRepository.prototype, 'findByStreamName').mockResolvedValue(null)
    vi.spyOn(CursorRepository.prototype, 'upsert').mockResolvedValue({} as any)
    vi.spyOn(CursorRepository.prototype, 'getCursorLag').mockResolvedValue(0)
    
    // Create listener with test configuration
    listener = createHorizonWithdrawalListener({
      horizonUrl: 'https://horizon-testnet.stellar.org',
      pollingInterval: 100, // Short interval for tests
      lastCursor: 'now'
    })
  })

  afterEach(async () => {
    await listener.stop()
  })

  describe('constructor', () => {
    it('creates listener with default configuration', () => {
      const defaultListener = createHorizonWithdrawalListener()
      expect(defaultListener).toBeInstanceOf(HorizonWithdrawalListener)
    })

    it('creates listener with custom configuration', () => {
      const customConfig = {
        horizonUrl: 'https://custom-horizon.example.com',
        pollingInterval: 10000,
        bondContractAddress: 'GABCD...'
      }
      const customListener = createHorizonWithdrawalListener(customConfig)
      expect(customListener).toBeInstanceOf(HorizonWithdrawalListener)
    })
  })

  describe('start and stop', () => {
    it('starts the listener', async () => {
      await listener.start()
      
      expect(listener.isActive()).toBe(true)
    })

    it('stops the listener', async () => {
      await listener.start()
      await listener.stop()
      
      expect(listener.isActive()).toBe(false)
    })
  })

  describe('cursor management', () => {
    it('gets and sets cursor', () => {
      expect(listener.getCursor()).toBe('now')
      
      listener.setCursor('123456789')
      expect(listener.getCursor()).toBe('123456789')
    })
  })

  describe('bond state calculation', () => {
    it('calculates partial withdrawal correctly', () => {
      const currentBond = {
        bondId: 'bond-123',
        account: 'GABC...',
        amount: '1000.0000000',
        isActive: true
      }

      const event = {
        id: 'op-123',
        pagingToken: '123456',
        type: 'payment',
        createdAt: new Date(),
        bondId: 'bond-123',
        account: 'GABC...',
        amount: '300.0000000',
        assetType: 'native',
        transactionHash: 'tx-123',
        operationIndex: 0
      }

      const update = (listener as any).calculateBondUpdate(currentBond, event)

      expect(compareDecimals(update.newAmount, '700')).toBe(0)
      expect(update.isActive).toBe(true)
      expect(update.previousAmount).toBe('1000.0000000')
    })

    it('calculates full withdrawal correctly', () => {
      const currentBond = {
        bondId: 'bond-123',
        account: 'GABC...',
        amount: '1000.0000000',
        isActive: true
      }

      const event = {
        id: 'op-123',
        pagingToken: '123456',
        type: 'payment',
        createdAt: new Date(),
        bondId: 'bond-123',
        account: 'GABC...',
        amount: '1000.0000000',
        assetType: 'native',
        transactionHash: 'tx-123',
        operationIndex: 0
      }

      const update = (listener as any).calculateBondUpdate(currentBond, event)

      expect(update.newAmount).toBe('0')
      expect(update.isActive).toBe(false)
      expect(update.previousAmount).toBe('1000.0000000')
    })

    it('prevents negative amounts', () => {
      const currentBond = {
        bondId: 'bond-123',
        account: 'GABC...',
        amount: '500.0000000',
        isActive: true
      }

      const event = {
        id: 'op-123',
        pagingToken: '123456',
        type: 'payment',
        createdAt: new Date(),
        bondId: 'bond-123',
        account: 'GABC...',
        amount: '1000.0000000', // More than current amount
        assetType: 'native',
        transactionHash: 'tx-123',
        operationIndex: 0
      }

      const update = (listener as any).calculateBondUpdate(currentBond, event)

      expect(update.newAmount).toBe('0') // Should not go negative
      expect(update.isActive).toBe(false)
    })
  })

  describe('score snapshot logic', () => {
    it('creates snapshot for full withdrawal', () => {
      const update = {
        bondId: 'bond-123',
        account: 'GABC...',
        previousAmount: '1000.0000000',
        newAmount: '0',
        isActive: false,
        updatedAt: new Date(),
        transactionHash: 'tx-123'
      }

      const shouldCreate = (listener as any).shouldCreateScoreSnapshot(update)
      expect(shouldCreate).toBe(true)
    })

    it('creates snapshot for large partial withdrawal (>=50%)', () => {
      const update = {
        bondId: 'bond-123',
        account: 'GABC...',
        previousAmount: '1000.0000000',
        newAmount: '400.0000000', // 60% withdrawn
        isActive: true,
        updatedAt: new Date(),
        transactionHash: 'tx-123'
      }

      const shouldCreate = (listener as any).shouldCreateScoreSnapshot(update)
      expect(shouldCreate).toBe(true)
    })

    it('does not create snapshot for small partial withdrawal (<50%)', () => {
      const update = {
        bondId: 'bond-123',
        account: 'GABC...',
        previousAmount: '1000.0000000',
        newAmount: '600.0000000', // 40% withdrawn
        isActive: true,
        updatedAt: new Date(),
        transactionHash: 'tx-123'
      }

      const shouldCreate = (listener as any).shouldCreateScoreSnapshot(update)
      expect(shouldCreate).toBe(false)
    })
  })

  describe('stats', () => {
    it('returns listener statistics', () => {
      const stats = listener.getStats()

      expect(stats).toEqual({
        isRunning: false,
        horizonUrl: 'https://horizon-testnet.stellar.org',
        lastCursor: 'now',
        pollingInterval: 100
      })
    })
  })

  describe('poison message routing', () => {
    it('routes a schema-invalid withdrawal event to the DLQ and does not process it', async () => {
      const invalidEvent = {
        id: 'op-1',
        pagingToken: 'pt-1',
        type: 'payment',
        createdAt: new Date(),
        bondId: 'bond-1-tx-1',
        account: 'GABC',
        amount: 'not-a-number', // fails decimalAmountSchema regex
        assetType: 'native',
        transactionHash: 'tx-1',
        operationIndex: 0,
      }

      const captureFailure = vi.fn().mockResolvedValue(undefined)
      const fetchSpy = vi
        .spyOn(HorizonWithdrawalListener.prototype as any, 'fetchWithdrawalEvents')
        .mockResolvedValue([invalidEvent])
      const processSpy = vi.spyOn(HorizonWithdrawalListener.prototype as any, 'processWithdrawalEvent')

      const invalidEventListener = createHorizonWithdrawalListener(
        { pollingInterval: 100 },
        undefined,
        { captureFailure },
      )

      await invalidEventListener.start()
      await invalidEventListener.stop()

      fetchSpy.mockRestore()

      expect(processSpy).not.toHaveBeenCalled()
      expect(captureFailure).toHaveBeenCalledTimes(1)
      const [messageType, , reason] = captureFailure.mock.calls[0]
      expect(messageType).toBe('bond_withdrawal')
      expect(reason).toContain('SCHEMA_VALIDATION_FAILED')

      processSpy.mockRestore()
    })
  })

  describe('decimal precision (#1263)', () => {
    it('does not lose precision the way parseFloat subtraction would', () => {
      // parseFloat("0.3000000") - parseFloat("0.1000000") === 0.19999999999999998
      // in IEEE-754 double arithmetic. The fix must produce exactly "0.2".
      const currentBond = { bondId: 'bond-1', account: 'GABC', amount: '0.3000000', isActive: true }
      const event = {
        id: 'op-1', pagingToken: 'pt-1', type: 'payment', createdAt: new Date(),
        bondId: 'bond-1', account: 'GABC', amount: '0.1000000', assetType: 'native',
        transactionHash: 'tx-1', operationIndex: 0,
      }

      const update = (listener as any).calculateBondUpdate(currentBond, event)

      expect(update.newAmount).toBe('0.2')
    })
  })

  describe('concurrency and race safety (#1263)', () => {
    const baseEvent = {
      id: 'op-dup', pagingToken: 'pt-dup', type: 'payment', createdAt: new Date(),
      bondId: 'bond-1', account: 'GABC', amount: '100.0000000', assetType: 'native',
      transactionHash: 'tx-dup', operationIndex: 0,
    }

    it('does not double-apply the same operation id across a sequential replay (restart-safety)', async () => {
      const { pool } = makeMockPool()
      const replayListener = createHorizonWithdrawalListener({ pollingInterval: 100_000 }, pool as any)
      let handlerCalls = 0

      const run = () =>
        (replayListener as any).idempotency.process('bond_withdrawal:op-dup', async () => {
          handlerCalls++
        })

      const first = await run()
      const second = await run() // simulates the same event being handed to the listener again

      expect(handlerCalls).toBe(1)
      expect(first.success).toBe(true)
      expect(second.success).toBe(true)

      await replayListener.stop()
    })

    it('dedupes truly concurrent calls for the same operation id (in-flight guard)', async () => {
      const { pool } = makeMockPool()
      const concurrentListener = createHorizonWithdrawalListener({ pollingInterval: 100_000 }, pool as any)
      let handlerCalls = 0

      const handler = async () => {
        handlerCalls++
        await new Promise((resolve) => setTimeout(resolve, 20))
      }

      const [a, b] = await Promise.all([
        (concurrentListener as any).idempotency.process('bond_withdrawal:op-concurrent', handler),
        (concurrentListener as any).idempotency.process('bond_withdrawal:op-concurrent', handler),
      ])

      expect(handlerCalls).toBe(1)
      expect(a.success).toBe(true)
      expect(b.success).toBe(true)

      await concurrentListener.stop()
    })

    it('commits the mutation and the cursor checkpoint as one atomic unit, in order', async () => {
      const { pool, client } = makeMockPool()
      const atomicListener = createHorizonWithdrawalListener({ pollingInterval: 100_000 }, pool as any)

      vi.spyOn(CursorRepository.prototype, 'findByStreamName').mockResolvedValue(null)
      vi.spyOn(HorizonWithdrawalListener.prototype as any, 'fetchWithdrawalEvents').mockResolvedValue([baseEvent])
      const processSpy = vi
        .spyOn(HorizonWithdrawalListener.prototype as any, 'processWithdrawalEvent')
        .mockResolvedValue(undefined)

      await atomicListener.start()
      await atomicListener.stop()

      const calls = client.query.mock.calls.map((c: any[]) => c[0])
      expect(calls).toEqual(['BEGIN', 'COMMIT'])
      expect(processSpy).toHaveBeenCalledTimes(1)
      expect(upsertCursor).toHaveBeenCalledWith(
        { streamName: 'bond_withdrawal', pagingToken: 'pt-dup' },
        client,
      )
      // The mutation must run, and the checkpoint be written, before COMMIT.
      const processOrder = processSpy.mock.invocationCallOrder[0]
      const upsertOrder = (upsertCursor as any).mock.invocationCallOrder[0]
      const commitOrder = client.query.mock.invocationCallOrder[1]
      expect(processOrder).toBeLessThan(upsertOrder)
      expect(upsertOrder).toBeLessThan(commitOrder)
      expect(atomicListener.getCursor()).toBe('pt-dup')

      processSpy.mockRestore()
    })

    it('rolls back and does not advance the cursor when processing fails — no partial state, bounded retry', async () => {
      const { pool, client } = makeMockPool()
      const captureFailure = vi.fn().mockResolvedValue(undefined)
      const failingListener = createHorizonWithdrawalListener(
        { pollingInterval: 100_000 },
        pool as any,
        { captureFailure },
      )

      const eventA = { ...baseEvent, id: 'op-fail', pagingToken: 'pt-fail', transactionHash: 'tx-fail' }
      const eventB = {
        ...baseEvent, id: 'op-after', pagingToken: 'pt-after', bondId: 'bond-2',
        account: 'GXYZ', transactionHash: 'tx-after',
      }

      vi.spyOn(CursorRepository.prototype, 'findByStreamName').mockResolvedValue(null)
      vi.spyOn(HorizonWithdrawalListener.prototype as any, 'fetchWithdrawalEvents')
        .mockResolvedValue([eventA, eventB])
      const processSpy = vi
        .spyOn(HorizonWithdrawalListener.prototype as any, 'processWithdrawalEvent')
        .mockImplementation(async (event: any) => {
          if (event.id === 'op-fail') throw new Error('simulated transient DB error')
        })

      await failingListener.start()
      await failingListener.stop()

      expect(upsertCursor).not.toHaveBeenCalled()
      expect(failingListener.getCursor()).toBe('now')
      expect(client.query).toHaveBeenCalledWith('ROLLBACK')
      expect(client.query).not.toHaveBeenCalledWith('COMMIT')
      // The second event must never be attempted — the batch stops at the
      // first failure so nothing commits out of order.
      expect(processSpy).toHaveBeenCalledTimes(1)

      processSpy.mockRestore()
    })

    it('processWithdrawalEvent captures the failure for replay AND rethrows so no cursor advance happens', async () => {
      const captureFailure = vi.fn().mockResolvedValue(undefined)
      const boundError = new Error('bond state lookup failed')

      const { pool } = makeMockPool()
      const errorListener = createHorizonWithdrawalListener(
        { pollingInterval: 100_000 },
        pool as any,
        { captureFailure },
      )

      vi.spyOn(errorListener as any, 'getBondState').mockRejectedValue(boundError)

      await expect((errorListener as any).processWithdrawalEvent(baseEvent)).rejects.toThrow(
        'bond state lookup failed',
      )
      expect(captureFailure).toHaveBeenCalledWith('withdrawal', baseEvent, boundError.message)

      await errorListener.stop()
    })
  })
})
