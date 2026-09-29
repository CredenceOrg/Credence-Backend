import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from './testDatabase.js'
import { createSchema, resetDatabase } from '../../src/db/schema.js'
import { BatchPayoutService } from '../../src/services/batchPayoutService.js'
import { BatchPayoutRepository } from '../../src/repositories/batchPayout.repository.js'
import { SettlementsRepository } from '../../src/db/repositories/settlementsRepository.js'
import { PayoutsRepository } from '../../src/db/repositories/payoutsRepository.js'
import type { PayoutItem } from '../../src/jobs/batchPayoutProcessor.js'

let db: TestDatabase

describe('Batch Payout Atomicity Integration', () => {
  beforeAll(async () => {
    db = await createTestDatabase()

    if (db.connectionString.startsWith('pg-mem://')) {
      const { newDb } = await import('pg-mem')
      const pgm = newDb()
      const adapter = pgm.adapters.createPg()
      const mockPool = new adapter.Pool()

      const originalConnect = mockPool.connect.bind(mockPool)
      mockPool.connect = async function () {
        const client = await originalConnect()
        let backup: any = null

        const originalClientQuery = client.query.bind(client)
        client.query = async function (text: any, values: any) {
          const sql = typeof text === 'string' ? text : text?.text
          if (sql === 'BEGIN' || (sql && sql.startsWith('BEGIN'))) {
            backup = pgm.backup()
          } else if (sql === 'ROLLBACK') {
            if (backup) {
              backup.restore()
            }
          } else if (sql === 'COMMIT') {
            backup = null
          }
          return await originalClientQuery(text, values)
        }
        return client
      }

      db.pool = mockPool

      await db.pool.query(`
        CREATE TABLE IF NOT EXISTS identities (
          address TEXT PRIMARY KEY,
          display_name TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          version INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS bonds (
          id BIGSERIAL PRIMARY KEY,
          identity_address TEXT NOT NULL,
          amount NUMERIC(20, 7) NOT NULL,
          start_time TIMESTAMPTZ NOT NULL,
          duration_days INTEGER NOT NULL,
          status TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS settlements (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          bond_id BIGINT NOT NULL,
          amount NUMERIC(36, 18) NOT NULL,
          transaction_hash VARCHAR(128) NOT NULL UNIQUE,
          settled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          status TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS payouts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          recipient TEXT NOT NULL,
          amount NUMERIC(36, 18) NOT NULL,
          currency TEXT NOT NULL DEFAULT 'USD',
          status TEXT NOT NULL DEFAULT 'pending',
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `)
    } else {
      await createSchema(db.pool)
      await db.pool.query(`
        CREATE TABLE IF NOT EXISTS payouts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          recipient TEXT NOT NULL,
          amount NUMERIC(36, 18) NOT NULL CHECK (amount >= 0),
          currency TEXT NOT NULL DEFAULT 'USD',
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
          metadata JSONB DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `)
    }
  }, 120000)

  afterAll(async () => {
    if (db) {
      await db.close()
    }
  })

  beforeEach(async () => {
    if (db.connectionString.startsWith('pg-mem://')) {
      await db.pool.query('DELETE FROM settlements')
      await db.pool.query('DELETE FROM payouts')
      await db.pool.query('DELETE FROM bonds')
      await db.pool.query('DELETE FROM identities')
    } else {
      await resetDatabase(db.pool)
      await db.pool.query('TRUNCATE TABLE payouts CASCADE')
    }

    await db.pool.query(
      `INSERT INTO identities (address, display_name) VALUES ('0x1111222233334444555566667777888899990000', 'Test User')`,
    )
    await db.pool.query(
      `INSERT INTO bonds (id, identity_address, amount, start_time, duration_days, status) VALUES (1, '0x1111222233334444555566667777888899990000', 1000, NOW(), 30, 'active')`,
    )
  })

  it('processes a valid batch of payouts successfully and handles duplicate retries idempotently', async () => {
    const store = new BatchPayoutRepository(db.pool)
    const executed: string[] = []
    const executor = {
      execute: vi.fn(async (item: PayoutItem) => {
        executed.push(item.transactionHash)
      }),
    }

    const service = new BatchPayoutService(store, executor)
    const items: PayoutItem[] = [
      { bondId: '1', amount: '100', transactionHash: 'tx-happy-1' },
      { bondId: '1', amount: '250', transactionHash: 'tx-happy-2' },
    ]

    const result = await service.processBatch(items)
    expect(result.total).toBe(2)
    expect(result.settled).toBe(2)
    expect(result.failed).toBe(0)
    expect(executed).toEqual(['tx-happy-1', 'tx-happy-2'])

    const dbRows = await db.pool.query('SELECT * FROM settlements ORDER BY transaction_hash')
    expect(dbRows.rows).toHaveLength(2)
    expect(dbRows.rows[0].status).toBe('settled')
    expect(dbRows.rows[1].status).toBe('settled')

    // Retry same items -> should be skipped idempotently without errors
    const retryResult = await service.processBatch(items)
    expect(retryResult.total).toBe(2)
    expect(retryResult.skipped).toBe(2)
    expect(retryResult.settled).toBe(0)
    expect(executor.execute).toHaveBeenCalledTimes(2) // Not called again
  })

  it('enforces atomic validation: invalid amount in payload rejects batch BEFORE any writes occur', async () => {
    const store = new BatchPayoutRepository(db.pool)
    const executor = {
      execute: vi.fn(async () => {}),
    }

    const service = new BatchPayoutService(store, executor)
    const items: PayoutItem[] = [
      { bondId: '1', amount: '100', transactionHash: 'tx-valid-1' },
      { bondId: '1', amount: '-50', transactionHash: 'tx-invalid-amount' },
    ]

    await expect(service.processBatch(items)).rejects.toThrow('invalid amount')
    expect(executor.execute).not.toHaveBeenCalled()

    const dbRows = await db.pool.query('SELECT * FROM settlements')
    expect(dbRows.rows).toHaveLength(0) // Zero writes applied!
  })

  it('enforces atomic validation: empty transactionHash rejects batch BEFORE any writes occur', async () => {
    const store = new BatchPayoutRepository(db.pool)
    const executor = {
      execute: vi.fn(async () => {}),
    }

    const service = new BatchPayoutService(store, executor)
    const items: PayoutItem[] = [
      { bondId: '1', amount: '100', transactionHash: '' },
    ]

    await expect(service.processBatch(items)).rejects.toThrow('invalid transactionHash')
    expect(executor.execute).not.toHaveBeenCalled()

    const dbRows = await db.pool.query('SELECT * FROM settlements')
    expect(dbRows.rows).toHaveLength(0) // Zero writes applied!
  })

  it('enforces atomic validation: empty bondId rejects batch BEFORE any writes occur', async () => {
    const store = new BatchPayoutRepository(db.pool)
    const executor = {
      execute: vi.fn(async () => {}),
    }

    const service = new BatchPayoutService(store, executor)
    const items: PayoutItem[] = [
      { bondId: '', amount: '100', transactionHash: 'tx-valid-1' },
    ]

    await expect(service.processBatch(items)).rejects.toThrow('invalid bondId')
    expect(executor.execute).not.toHaveBeenCalled()

    const dbRows = await db.pool.query('SELECT * FROM settlements')
    expect(dbRows.rows).toHaveLength(0) // Zero writes applied!
  })

  it('rolls back atomic database transactions during SettlementsRepository.upsertBatch upon error', async () => {
    const repo = new SettlementsRepository(db.pool)

    const validInputs = [
      { bondId: '1', amount: '100', transactionHash: 'tx-batch-1' },
      { bondId: '1', amount: '200', transactionHash: 'tx-batch-2' },
    ]

    await repo.upsertBatch(validInputs)
    const rowsBefore = await db.pool.query('SELECT * FROM settlements')
    expect(rowsBefore.rows).toHaveLength(2)

    await db.pool.query('DELETE FROM settlements')

    // Simulate an error during batch upsert by wrapping pool in a proxy that throws on the second query
    let queryCount = 0
    const errorDb = {
      ...db.pool,
      connect: async () => {
        const client = await db.pool.connect()
        const origQuery = client.query.bind(client)
        client.query = async function (text: any, values: any) {
          const sql = typeof text === 'string' ? text : text?.text
          if (sql && sql.includes('INSERT INTO settlements')) {
            queryCount++
            if (queryCount === 2) {
              throw new Error('Simulated database write error during batch!')
            }
          }
          return await origQuery(text, values)
        }
        return client
      },
    } as any

    const errorRepo = new SettlementsRepository(errorDb)
    await expect(errorRepo.upsertBatch(validInputs)).rejects.toThrow('Simulated database write error during batch!')

    const rowsAfter = await db.pool.query('SELECT * FROM settlements')
    expect(rowsAfter.rows).toHaveLength(0) // Transaction rolled back completely!
  })

  it('rolls back atomic database transactions during PayoutsRepository.createBatch upon error', async () => {
    const repo = new PayoutsRepository(db.pool)

    const validInputs = [
      { recipient: '0xabc', amount: '100' },
      { recipient: '0xdef', amount: '200' },
    ]

    await repo.createBatch(validInputs)
    const rowsBefore = await db.pool.query('SELECT * FROM payouts')
    expect(rowsBefore.rows).toHaveLength(2)

    await db.pool.query('DELETE FROM payouts')

    let queryCount = 0
    const errorDb = {
      ...db.pool,
      connect: async () => {
        const client = await db.pool.connect()
        const origQuery = client.query.bind(client)
        client.query = async function (text: any, values: any) {
          const sql = typeof text === 'string' ? text : text?.text
          if (sql && sql.includes('INSERT INTO payouts')) {
            queryCount++
            if (queryCount === 2) {
              throw new Error('Simulated payout insertion error!')
            }
          }
          return await origQuery(text, values)
        }
        return client
      },
    } as any

    const errorRepo = new PayoutsRepository(errorDb)
    await expect(errorRepo.createBatch(validInputs)).rejects.toThrow('Simulated payout insertion error!')

    const rowsAfter = await db.pool.query('SELECT * FROM payouts')
    expect(rowsAfter.rows).toHaveLength(0) // Transaction rolled back completely!
  })
})
