import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from './testDatabase.js'

const sharedStorage = vi.hoisted(() => new Map<string, string>())

vi.mock('../../src/cache/redis.js', () => {
  const mockClient = {
    connect: async () => {},
    get: async (key: string) => sharedStorage.get(key) ?? null,
    set: async (key: string, value: string) => { sharedStorage.set(key, value); return 'OK' },
    setEx: async (key: string, ttl: number, value: string) => { sharedStorage.set(key, value); return 'OK' },
    del: async (key: string) => { const existed = sharedStorage.has(key); sharedStorage.delete(key); return existed ? 1 : 0 },
    quit: async () => {},
    disconnect: async () => {},
    on: () => {},
    isOpen: true,
  } as any

  const MockRedisConnection = {
    getInstance: () => ({
      connect: async () => {},
      getClient: () => mockClient,
      isOpen: true,
    })
  }

  return {
    RedisConnection: MockRedisConnection,
    redisConnection: MockRedisConnection.getInstance(),
    cache: {
      get: (ns: string, k: string) => mockClient.get(`${ns}:${k}`).then(v => v ? JSON.parse(v) : null),
      set: (ns: string, k: string, v: any, ttl?: number) => mockClient.set(`${ns}:${k}`, JSON.stringify(v)),
      delete: (ns: string, k: string) => mockClient.del(`${ns}:${k}`),
      exists: (ns: string, k: string) => Promise.resolve(sharedStorage.has(`${ns}:${k}`)),
      clearNamespace: (nsPattern: string) => {
        let count = 0
        const prefix = nsPattern.replace('*', '')
        for (const key of sharedStorage.keys()) {
          if (key.startsWith(prefix)) {
            sharedStorage.delete(key)
            count++
          }
        }
        return Promise.resolve(count)
      }
    }
  }
})

import { SettlementsRepository, Settlement } from '../../src/db/repositories/settlementsRepository.js'
import { SettlementService } from '../../src/services/settlementService.js'
import { cache } from '../../src/cache/redis.js'
import { TransactionManager } from '../../src/db/transaction.js'

let db: TestDatabase
let txManager: TransactionManager
let repository: SettlementsRepository
let service: SettlementService

describe('Cache Invalidation Integration', () => {
  beforeAll(async () => {
    db = await createTestDatabase()

    if (db.connectionString.startsWith('pg-mem://')) {
      await db.pool.query(`
        CREATE TABLE IF NOT EXISTS settlements (
          id SERIAL PRIMARY KEY,
          bond_id INTEGER NOT NULL,
          amount TEXT NOT NULL,
          transaction_hash TEXT UNIQUE NOT NULL,
          settled_at TIMESTAMP NOT NULL,
          status TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `)
    } else {
      await db.pool.query(`
        CREATE TABLE IF NOT EXISTS settlements (
          id SERIAL PRIMARY KEY,
          bond_id INTEGER NOT NULL,
          amount TEXT NOT NULL,
          transaction_hash TEXT UNIQUE NOT NULL,
          settled_at TIMESTAMP NOT NULL,
          status TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `)
    }

    txManager = new TransactionManager(db.pool)
    repository = new SettlementsRepository(db.pool)
    service = new SettlementService(repository)
  })

  afterAll(async () => {
    if (db) {
      await db.close()
    }
  })

  beforeEach(async () => {
    await db.pool.query('DELETE FROM settlements')
    sharedStorage.clear()
  })

  it('Cache invalidated after successful transaction status update', async () => {
    const input = {
      bondId: 100,
      amount: '1000',
      transactionHash: 'tx_1',
      status: 'pending' as const
    }
    const created = await service.upsertSettlementStatus(input)
    expect(created.status).toBe('pending')

    const fetched1 = await service.getSettlementByHash('tx_1')
    expect(fetched1).not.toBeNull()
    expect(fetched1!.status).toBe('pending')

    const cachedVal = await cache.get('settlement', 'tx_1')
    expect(cachedVal).not.toBeNull()

    await service.upsertSettlementStatus({
      ...input,
      status: 'settled'
    })

    const cachedVal2 = await cache.get('settlement', 'tx_1')
    expect(cachedVal2).toBeNull()
  })

  it('Reads immediately after an update return fresh data', async () => {
    const input = {
      bondId: 100,
      amount: '1000',
      transactionHash: 'tx_1',
      status: 'pending' as const
    }
    await service.upsertSettlementStatus(input)
    await service.getSettlementByHash('tx_1')

    await txManager.withTransaction(async () => {
      await service.upsertSettlementStatus({
        ...input,
        status: 'settled'
      })
      const fetchedInside = await service.getSettlementByHash('tx_1')
      expect(fetchedInside!.status).toBe('settled')
    })

    const fetched = await service.getSettlementByHash('tx_1')
    expect(fetched!.status).toBe('settled')
  })

  it('Failed database updates do not invalidate cache', async () => {
    const input = {
      bondId: 100,
      amount: '1000',
      transactionHash: 'tx_1',
      status: 'pending' as const
    }
    await service.upsertSettlementStatus(input)
    await service.getSettlementByHash('tx_1')
    
    const cachedValBefore = await cache.get('settlement', 'tx_1')
    expect(cachedValBefore).not.toBeNull()

    await expect(
      txManager.withTransaction(async () => {
        await service.upsertSettlementStatus({
          ...input,
          status: 'settled'
        })
        throw new Error('Force Rollback')
      })
    ).rejects.toThrow('Force Rollback')

    const cachedValAfter = await cache.get('settlement', 'tx_1')
    expect(cachedValAfter).not.toBeNull()
    expect(cachedValAfter.status).toBe('pending')
  })

  it('Concurrent updates and reads remain consistent', async () => {
    const input = {
      bondId: 100,
      amount: '1000',
      transactionHash: 'tx_1',
      status: 'pending' as const
    }
    await service.upsertSettlementStatus(input)
    await service.getSettlementByHash('tx_1')

    // Manually set lock to simulate concurrent update in progress
    await cache.set('lock:settlement', 'tx_1', '1', 5)

    // Populate a stale cached value
    await cache.set('settlement', 'tx_1', {
      bondId: 100,
      amount: '1000',
      transactionHash: 'tx_1',
      status: 'stale_status',
      settledAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }, 300)

    // Since the lock is active, the read must bypass the cache and fetch 'pending' from the DB
    const fetched = await service.getSettlementByHash('tx_1')
    expect(fetched!.status).toBe('pending')

    // Remove the lock
    await cache.delete('lock:settlement', 'tx_1')
  })

  it('Multiple cache keys referencing the same transaction are invalidated', async () => {
    const input = {
      bondId: 100,
      amount: '1000',
      transactionHash: 'tx_1',
      status: 'pending' as const
    }
    const created = await service.upsertSettlementStatus(input)

    await cache.set('settlement', 'tx_1', created, 300)
    await cache.set('settlement', `id:${created.id}`, created, 300)
    await cache.set('settlement', `bondId:${created.bondId}`, created, 300)

    await service.upsertSettlementStatus({
      ...input,
      status: 'settled'
    })

    expect(await cache.get('settlement', 'tx_1')).toBeNull()
    expect(await cache.get('settlement', `id:${created.id}`)).toBeNull()
    expect(await cache.get('settlement', `bondId:${created.bondId}`)).toBeNull()
  })

  it('Repeated updates do not leave stale cache entries', async () => {
    const input = {
      bondId: 100,
      amount: '1000',
      transactionHash: 'tx_1',
      status: 'pending' as const
    }
    await service.upsertSettlementStatus(input)

    await service.upsertSettlementStatus({ ...input, status: 'settled' })
    await service.upsertSettlementStatus({ ...input, status: 'failed' })
    await service.upsertSettlementStatus({ ...input, status: 'settled' })

    const fetched = await service.getSettlementByHash('tx_1')
    expect(fetched!.status).toBe('settled')

    const cachedVal = await cache.get('settlement', 'tx_1')
    expect(cachedVal!.status).toBe('settled')
  })

  it('Existing caching behavior remains unaffected for unrelated resources', async () => {
    await cache.set('settlement', 'tx_unrelated', { id: 'unrelated' }, 300)

    const input = {
      bondId: 100,
      amount: '1000',
      transactionHash: 'tx_1',
      status: 'pending' as const
    }
    await service.upsertSettlementStatus(input)

    const unrelatedVal = await cache.get('settlement', 'tx_unrelated')
    expect(unrelatedVal).toEqual({ id: 'unrelated' })
  })
})
