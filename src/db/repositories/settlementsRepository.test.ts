import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { newDb } from 'pg-mem'
import type { IMemoryDb } from 'pg-mem'
import { Pool } from 'pg'
import { SettlementsRepository } from './settlementsRepository.js'
import type { UpsertSettlementResult } from './settlementsRepository.js'

function createPassthroughPool(pool: Pool): Pool {
  return new Proxy(pool, {
    get(target, prop) {
      if (prop !== 'query') return (target as any)[prop]
      return (text: string, values?: unknown[]) => {
        return (target as any).query(text, values)
      }
    },
  })
}

async function buildTestDb(): Promise<{ db: IMemoryDb; pool: Pool; proxiedPool: Pool }> {
  const db = newDb()

  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: 'uuid',
    implementation: () => crypto.randomUUID(),
  } as Parameters<typeof db.public.registerFunction>[0])

  const adapter = db.adapters.createPg()
  const pool = new adapter.Pool() as unknown as Pool

  await pool.query(`
    CREATE TABLE IF NOT EXISTS identities (
      id          UUID          PRIMARY KEY,
      address     VARCHAR(255)  NOT NULL UNIQUE,
      created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    );
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bonds (
      id              UUID           PRIMARY KEY,
      identity_id     UUID           NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
      bonded_amount   NUMERIC(36,18) NOT NULL CHECK (bonded_amount >= 0),
      bond_start      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
      bond_duration   INTERVAL       NOT NULL,
      bond_end        TIMESTAMPTZ,
      slashed_amount  NUMERIC(36,18) NOT NULL DEFAULT 0 CHECK (slashed_amount >= 0),
      active          BOOLEAN        NOT NULL DEFAULT TRUE,
      created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW()
    );
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS settlements (
      id              BIGSERIAL      PRIMARY KEY,
      bond_id         UUID           NOT NULL REFERENCES bonds(id) ON DELETE CASCADE,
      amount          NUMERIC(20,7)  NOT NULL CHECK (amount >= 0),
      transaction_hash TEXT          NOT NULL,
      settled_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
      status          TEXT           NOT NULL DEFAULT 'pending'
                                     CHECK (status IN ('pending', 'settled', 'failed')),
      created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
      CONSTRAINT settlements_transaction_hash_unique UNIQUE (transaction_hash)
    );
  `)

  const proxiedPool = createPassthroughPool(pool)
  return { db, pool, proxiedPool }
}

async function insertIdentity(pool: Pool, address: string): Promise<string> {
  const id = crypto.randomUUID()
  await pool.query(`INSERT INTO identities (id, address) VALUES ($1, $2)`, [id, address])
  return id
}

async function insertBond(
  pool: Pool,
  identityId: string,
  bondedAmount = '100',
  bondDuration = '30 days',
): Promise<string> {
  const id = crypto.randomUUID()
  await pool.query(
    `INSERT INTO bonds (id, identity_id, bonded_amount, bond_start, bond_duration, active)
     VALUES ($1, $2, $3, NOW(), $4::INTERVAL, TRUE)`,
    [id, identityId, bondedAmount, bondDuration],
  )
  return id
}

describe('SettlementsRepository', () => {
  let pool: Pool
  let repo: SettlementsRepository
  let bondId: string
  let unusedBondId: string

  beforeAll(async () => {
    const built = await buildTestDb()
    pool = built.pool
    repo = new SettlementsRepository(built.proxiedPool)
    const identityId = await insertIdentity(pool, '0xSETTLEMENT_TEST')
    bondId = await insertBond(pool, identityId)
    const identityId2 = await insertIdentity(pool, '0xSETTLEMENT_TEST_2')
    unusedBondId = await insertBond(pool, identityId2)
  })

  afterEach(async () => {
    await pool.query('DELETE FROM settlements')
  })

  describe('upsert()', () => {
    it('creates a new settlement and returns isDuplicate false', async () => {
      const result = await repo.upsert({
        bondId: bondId as unknown as number,
        amount: '500.1234567',
        transactionHash: 'tx_abc_001',
      })

      expect(result.isDuplicate).toBe(false)
      expect(result.settlement.transactionHash).toBe('tx_abc_001')
      expect(result.settlement.status).toBe('pending')
      expect(result.settlement.settledAt).toBeInstanceOf(Date)
      expect(result.settlement.createdAt).toBeInstanceOf(Date)
    })

    it('returns isDuplicate true on second insert with same bond_id and transaction_hash', async () => {
      const first = await repo.upsert({
        bondId: bondId as unknown as number,
        amount: '100',
        transactionHash: 'tx_dup_001',
      })
      expect(first.isDuplicate).toBe(false)

      const second = await repo.upsert({
        bondId: bondId as unknown as number,
        amount: '100',
        transactionHash: 'tx_dup_001',
      })
      expect(second.isDuplicate).toBe(true)
      expect(second.settlement.id).toBe(first.settlement.id)
    })

    it('does not create a second row on duplicate upsert', async () => {
      await repo.upsert({
        bondId: bondId as unknown as number,
        amount: '200',
        transactionHash: 'tx_nodup_001',
      })

      await repo.upsert({
        bondId: bondId as unknown as number,
        amount: '200',
        transactionHash: 'tx_nodup_001',
      })

      const count = await repo.countByBondId(bondId as unknown as number)
      expect(count).toBe(1)
    })

    it('allows different transaction hashes for the same bond', async () => {
      await repo.upsert({
        bondId: bondId as unknown as number,
        amount: '100',
        transactionHash: 'tx_multi_001',
      })

      await repo.upsert({
        bondId: bondId as unknown as number,
        amount: '200',
        transactionHash: 'tx_multi_002',
      })

      const count = await repo.countByBondId(bondId as unknown as number)
      expect(count).toBe(2)
    })

    it('updates status and amount on conflict', async () => {
      await repo.upsert({
        bondId: bondId as unknown as number,
        amount: '100',
        transactionHash: 'tx_update_001',
        status: 'pending',
      })

      const updated = await repo.upsert({
        bondId: bondId as unknown as number,
        amount: '150',
        transactionHash: 'tx_update_001',
        status: 'settled',
      })

      expect(updated.settlement.status).toBe('settled')
    })

    it('uses provided settledAt when given', async () => {
      const settledAt = new Date('2025-06-15T12:00:00Z')
      const result = await repo.upsert({
        bondId: bondId as unknown as number,
        amount: '100',
        transactionHash: 'tx_dated_001',
        settledAt,
      })

      expect(result.settlement.settledAt.toISOString()).toBe(settledAt.toISOString())
    })
  })

  describe('concurrent upserts', () => {
    it('produces exactly one row when multiple upserts run in parallel', async () => {
      const input = {
        bondId: bondId as unknown as number,
        amount: '300',
        transactionHash: 'tx_concurrent_001',
      }

      await Promise.all([
        repo.upsert(input),
        repo.upsert(input),
        repo.upsert(input),
        repo.upsert(input),
        repo.upsert(input),
      ])

      const count = await repo.countByBondId(bondId as unknown as number)
      expect(count).toBe(1)
    })

    it('all concurrent upserts return the same settlement id', async () => {
      const input = {
        bondId: bondId as unknown as number,
        amount: '400',
        transactionHash: 'tx_concurrent_002',
      }

      const results: UpsertSettlementResult[] = await Promise.all([
        repo.upsert(input),
        repo.upsert(input),
        repo.upsert(input),
      ])

      const ids = new Set(results.map((r) => r.settlement.id))
      expect(ids.size).toBe(1)
    })
  })

  describe('findById()', () => {
    it('returns the settlement when found', async () => {
      const { settlement } = await repo.upsert({
        bondId: bondId as unknown as number,
        amount: '100',
        transactionHash: 'tx_find_001',
      })

      const found = await repo.findById(settlement.id)
      expect(found).not.toBeNull()
      expect(found!.id).toBe(settlement.id)
      expect(found!.transactionHash).toBe('tx_find_001')
    })

    it('returns null for unknown id', async () => {
      const found = await repo.findById(999999)
      expect(found).toBeNull()
    })
  })

  describe('findByBondId()', () => {
    it('returns all settlements for a bond', async () => {
      await repo.upsert({
        bondId: bondId as unknown as number,
        amount: '100',
        transactionHash: 'tx_list_001',
      })

      await repo.upsert({
        bondId: bondId as unknown as number,
        amount: '200',
        transactionHash: 'tx_list_002',
      })

      const results = await repo.findByBondId(bondId as unknown as number)
      expect(results).toHaveLength(2)
    })

    it('returns empty array for a bond with no settlements', async () => {
      const results = await repo.findByBondId(unusedBondId as unknown as number)
      expect(results).toEqual([])
    })
  })

  describe('findByTransactionHash()', () => {
    it('returns the settlement for a known hash', async () => {
      await repo.upsert({
        bondId: bondId as unknown as number,
        amount: '100',
        transactionHash: 'tx_hash_001',
      })

      const found = await repo.findByTransactionHash('tx_hash_001')
      expect(found).not.toBeNull()
      expect(found!.transactionHash).toBe('tx_hash_001')
    })

    it('returns null for an unknown hash', async () => {
      const found = await repo.findByTransactionHash('tx_nonexistent')
      expect(found).toBeNull()
    })
  })

  describe('countByBondId()', () => {
    it('returns the correct count', async () => {
      await repo.upsert({
        bondId: bondId as unknown as number,
        amount: '100',
        transactionHash: 'tx_count_001',
      })

      await repo.upsert({
        bondId: bondId as unknown as number,
        amount: '200',
        transactionHash: 'tx_count_002',
      })

      const count = await repo.countByBondId(bondId as unknown as number)
      expect(count).toBe(2)
    })

    it('returns zero for a bond with no settlements', async () => {
      const count = await repo.countByBondId(unusedBondId as unknown as number)
      expect(count).toBe(0)
    })
  })

  describe('delete()', () => {
    it('removes the settlement and returns true', async () => {
      const { settlement } = await repo.upsert({
        bondId: bondId as unknown as number,
        amount: '100',
        transactionHash: 'tx_del_001',
      })

      const deleted = await repo.delete(settlement.id)
      expect(deleted).toBe(true)
      expect(await repo.findById(settlement.id)).toBeNull()
    })

    it('returns false for a non-existent id', async () => {
      const deleted = await repo.delete(999999)
      expect(deleted).toBe(false)
    })
  })

  describe('transaction_hash uniqueness (global idempotency)', () => {
    it('prevents inserting settlement with same transaction_hash for different bonds', async () => {
      // Create settlement for first bond
      await repo.upsert({
        bondId: bondId as unknown as number,
        amount: '100',
        transactionHash: 'tx_global_unique_001',
        status: 'pending',
      })

      // Attempting to create settlement with same transaction_hash for different bond
      // should update the existing one, not create a new one
      const result = await repo.upsert({
        bondId: unusedBondId as unknown as number,
        amount: '200',
        transactionHash: 'tx_global_unique_001',
        status: 'settled',
      })

      // The existing settlement should be returned (updated)
      expect(result.isDuplicate).toBe(true)
      // The bondId should remain the original one (first insert)
      expect(result.settlement.bondId).toBe(String(bondId))
      expect(String(result.settlement.amount)).toBe('200') // amount was updated
      expect(result.settlement.status).toBe('settled') // status was updated
    })

    it('produces only one row across all bonds for the same transaction_hash', async () => {
      // Insert for first bond
      const first = await repo.upsert({
        bondId: bondId as unknown as number,
        amount: '100',
        transactionHash: 'tx_one_row_001',
      })

      // Insert for second bond with same transaction_hash
      const second = await repo.upsert({
        bondId: unusedBondId as unknown as number,
        amount: '100',
        transactionHash: 'tx_one_row_001',
      })

      // Both should return the same settlement ID
      expect(first.settlement.id).toBe(second.settlement.id)
      expect(second.isDuplicate).toBe(true)

      // Verify only one row exists with this transaction_hash
      const found = await repo.findByTransactionHash('tx_one_row_001')
      expect(found).not.toBeNull()
      expect(found!.transactionHash).toBe('tx_one_row_001')

      // Verify bondId stayed with the first insert
      expect(found!.bondId).toBe(String(bondId))
    })

    it('handles rapid concurrent inserts with same transaction_hash across different bonds', async () => {
      const input1 = {
        bondId: bondId as unknown as number,
        amount: '100',
        transactionHash: 'tx_concurrent_global_001',
      }

      const input2 = {
        bondId: unusedBondId as unknown as number,
        amount: '200',
        transactionHash: 'tx_concurrent_global_001',
      }

      const results = await Promise.all([
        repo.upsert(input1),
        repo.upsert(input2),
        repo.upsert(input1),
        repo.upsert(input2),
      ])

      // All should return the same ID
      const ids = new Set(results.map((r) => r.settlement.id))
      expect(ids.size).toBe(1)

      // Verify only one row exists
      const count = await repo.countByBondId(bondId as unknown as number)
      const count2 = await repo.countByBondId(unusedBondId as unknown as number)
      expect(count + count2).toBe(1)
    })

    it('correctly marks duplicates across bonds', async () => {
      // First insert
      const first = await repo.upsert({
        bondId: bondId as unknown as number,
        amount: '100',
        transactionHash: 'tx_dup_mark_001',
      })
      expect(first.isDuplicate).toBe(false)

      // Second insert - different bond, same transaction_hash
      const second = await repo.upsert({
        bondId: unusedBondId as unknown as number,
        amount: '100',
        transactionHash: 'tx_dup_mark_001',
      })
      expect(second.isDuplicate).toBe(true)

      // Third insert - first bond again, same transaction_hash
      const third = await repo.upsert({
        bondId: bondId as unknown as number,
        amount: '100',
        transactionHash: 'tx_dup_mark_001',
      })
      expect(third.isDuplicate).toBe(true)
    })
  })
})

describe('SettlementsRepository – rowCount nullish coalescing', () => {
  function makeNullRowCountPool() {
    return {
      query: async () => ({ rows: [], rowCount: null }),
    } as unknown as Pool
  }

  it('delete() returns false when rowCount is null', async () => {
    const repo = new SettlementsRepository(makeNullRowCountPool())
    const result = await repo.delete(1)
    expect(result).toBe(false)
  })
})
