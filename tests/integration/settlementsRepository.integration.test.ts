/**
 * Integration tests for SettlementsRepository idempotency and race-condition
 * safety against a real PostgreSQL database.
 *
 * These tests require a real Postgres instance because:
 *   - pg-mem does not enforce concurrent serialisation for ON CONFLICT clauses
 *     the same way real Postgres does.
 *   - We want to exercise the DB-level UNIQUE constraint on transaction_hash,
 *     not just the application-level pre-check.
 *
 * The tests use testcontainers to spin up a postgres:16-alpine container
 * automatically. If TEST_DATABASE_URL is set that connection is used instead
 * (CI mode). If neither Docker nor TEST_DATABASE_URL is available the suite
 * skips gracefully — it will not fall back to pg-mem.
 *
 * To run locally against docker-compose.test.yml:
 *   TEST_DATABASE_URL=postgresql://credence:credence@localhost:5433/credence_test \
 *     npm test tests/integration/settlementsRepository.integration.test.ts
 *
 * Fixtures use deterministic, hard-coded values — no Date.now() or Math.random().
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { createTestDatabase, type TestDatabase } from './testDatabase.js'
import { createSchema } from '../../src/db/schema.js'
import { SettlementsRepository } from '../../src/db/repositories/settlementsRepository.js'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let testDb: TestDatabase
let pool: Pool
let repo: SettlementsRepository

/**
 * Returns true when the pool is backed by a real Postgres instance (not pg-mem).
 * pg-mem connection strings start with "pg-mem://".
 */
function isRealPostgres(db: TestDatabase): boolean {
  return !db.connectionString.startsWith('pg-mem://')
}

beforeAll(async () => {
  testDb = await createTestDatabase()

  if (!isRealPostgres(testDb)) {
    // These tests require real Postgres to enforce the unique constraint under
    // concurrent load. Skip rather than run against pg-mem.
    return
  }

  pool = testDb.pool

  // Apply the full application schema (includes bonds, identities, settlements
  // with UNIQUE (transaction_hash)).
  await createSchema(pool)
}, 60_000)

beforeEach(async () => {
  if (!isRealPostgres(testDb)) return
  // Delete in FK-safe order: settlements → bonds → identities.
  await pool.query('DELETE FROM settlements')
  await pool.query('DELETE FROM bonds')
  await pool.query('DELETE FROM identities')
})

afterAll(async () => {
  await testDb.close()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert a minimal identity row and return its address. */
async function seedIdentity(address: string): Promise<string> {
  await pool.query(
    `INSERT INTO identities (address) VALUES ($1) ON CONFLICT DO NOTHING`,
    [address],
  )
  return address
}

/** Insert a minimal bond row and return its numeric id. */
async function seedBond(identityAddress: string, amount = '100'): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO bonds (identity_address, amount, start_time, duration_days, status)
     VALUES ($1, $2, NOW(), 30, 'active')
     RETURNING id`,
    [identityAddress, amount],
  )
  return result.rows[0].id
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SettlementsRepository – idempotency (real Postgres)', () => {
  beforeEach(() => {
    if (!isRealPostgres(testDb)) return
    repo = new SettlementsRepository(pool)
  })

  // =========================================================================
  // Basic upsert idempotency
  // =========================================================================

  describe('upsert() – basic idempotency', () => {
    it('creates a new settlement and returns isDuplicate=false on first call', async () => {
      if (!isRealPostgres(testDb)) return

      const identity = await seedIdentity('0xISettl_new_01')
      const bondId = await seedBond(identity)

      const result = await repo.upsert({
        bondId,
        amount: '500.00',
        transactionHash: 'tx_itest_new_01',
      })

      expect(result.isDuplicate).toBe(false)
      expect(result.settlement.transactionHash).toBe('tx_itest_new_01')
      expect(result.settlement.status).toBe('pending')
      expect(result.settlement.bondId).toBe(String(bondId))
      expect(result.settlement.settledAt).toBeInstanceOf(Date)
      expect(result.settlement.createdAt).toBeInstanceOf(Date)
      // UUID format
      expect(result.settlement.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      )
    })

    it('returns isDuplicate=true and the same id on a replay (second call with same tx hash)', async () => {
      if (!isRealPostgres(testDb)) return

      const identity = await seedIdentity('0xISettl_replay_01')
      const bondId = await seedBond(identity)
      const input = { bondId, amount: '100', transactionHash: 'tx_itest_replay_01' }

      const first = await repo.upsert(input)
      const second = await repo.upsert(input)

      expect(first.isDuplicate).toBe(false)
      expect(second.isDuplicate).toBe(true)
      expect(second.settlement.id).toBe(first.settlement.id)
    })

    it('produces exactly one row after N sequential replays', async () => {
      if (!isRealPostgres(testDb)) return

      const identity = await seedIdentity('0xISettl_seq_01')
      const bondId = await seedBond(identity)
      const input = { bondId, amount: '200', transactionHash: 'tx_itest_seq_01' }

      for (let i = 0; i < 5; i++) {
        await repo.upsert(input)
      }

      const all = await repo.findByBondId(bondId)
      expect(all).toHaveLength(1)
    })

    it('allows distinct transactions for the same bond', async () => {
      if (!isRealPostgres(testDb)) return

      const identity = await seedIdentity('0xISettl_multi_01')
      const bondId = await seedBond(identity)

      await repo.upsert({ bondId, amount: '100', transactionHash: 'tx_itest_multi_01' })
      await repo.upsert({ bondId, amount: '200', transactionHash: 'tx_itest_multi_02' })
      await repo.upsert({ bondId, amount: '300', transactionHash: 'tx_itest_multi_03' })

      const all = await repo.findByBondId(bondId)
      expect(all).toHaveLength(3)
    })
  })

  // =========================================================================
  // Upsert updates fields on conflict
  // =========================================================================

  describe('upsert() – field updates on conflict', () => {
    it('updates status and amount when the same transaction_hash is re-submitted', async () => {
      if (!isRealPostgres(testDb)) return

      const identity = await seedIdentity('0xISettl_upd_01')
      const bondId = await seedBond(identity)

      await repo.upsert({
        bondId,
        amount: '100',
        transactionHash: 'tx_itest_upd_01',
        status: 'pending',
      })

      const updated = await repo.upsert({
        bondId,
        amount: '150',
        transactionHash: 'tx_itest_upd_01',
        status: 'settled',
      })

      expect(updated.settlement.status).toBe('settled')
      expect(Number(updated.settlement.amount)).toBeCloseTo(150)
    })

    it('does not change bond_id when the same transaction_hash arrives from a different bond', async () => {
      if (!isRealPostgres(testDb)) return

      const identity1 = await seedIdentity('0xISettl_bondswap_01')
      const identity2 = await seedIdentity('0xISettl_bondswap_02')
      const bondId1 = await seedBond(identity1)
      const bondId2 = await seedBond(identity2)

      // First owner of this tx hash
      const first = await repo.upsert({
        bondId: bondId1,
        amount: '100',
        transactionHash: 'tx_itest_bondswap_01',
      })

      // Second upsert with a different bond_id for the same tx hash
      const second = await repo.upsert({
        bondId: bondId2,
        amount: '200',
        transactionHash: 'tx_itest_bondswap_01',
      })

      // Should return the existing settlement (not create a new one)
      expect(second.settlement.id).toBe(first.settlement.id)
      expect(second.isDuplicate).toBe(true)
      // bond_id stays pinned to the first inserter
      expect(second.settlement.bondId).toBe(String(bondId1))
      // But amount can be updated
      expect(Number(second.settlement.amount)).toBeCloseTo(200)
    })

    it('preserves provided settledAt timestamp', async () => {
      if (!isRealPostgres(testDb)) return

      const identity = await seedIdentity('0xISettl_ts_01')
      const bondId = await seedBond(identity)
      const settledAt = new Date('2025-03-01T00:00:00.000Z')

      const result = await repo.upsert({
        bondId,
        amount: '300',
        transactionHash: 'tx_itest_ts_01',
        settledAt,
      })

      expect(result.settlement.settledAt.toISOString()).toBe(settledAt.toISOString())
    })
  })

  // =========================================================================
  // Global uniqueness: same tx hash, different bonds
  // =========================================================================

  describe('upsert() – global transaction_hash uniqueness across bonds', () => {
    it('produces only one row across two different bonds for the same tx hash', async () => {
      if (!isRealPostgres(testDb)) return

      const identity1 = await seedIdentity('0xISettl_global_01')
      const identity2 = await seedIdentity('0xISettl_global_02')
      const bondId1 = await seedBond(identity1)
      const bondId2 = await seedBond(identity2)

      const first = await repo.upsert({
        bondId: bondId1,
        amount: '100',
        transactionHash: 'tx_itest_global_01',
      })

      const second = await repo.upsert({
        bondId: bondId2,
        amount: '100',
        transactionHash: 'tx_itest_global_01',
      })

      expect(first.settlement.id).toBe(second.settlement.id)
      expect(second.isDuplicate).toBe(true)

      // Confirm at the DB level: only one row with this hash
      const { rows } = await pool.query(
        `SELECT COUNT(*)::INT AS cnt FROM settlements WHERE transaction_hash = $1`,
        ['tx_itest_global_01'],
      )
      expect(rows[0].cnt).toBe(1)
    })

    it('keeps the original bond_id when re-replayed from different bonds', async () => {
      if (!isRealPostgres(testDb)) return

      const identity1 = await seedIdentity('0xISettl_orig_01')
      const identity2 = await seedIdentity('0xISettl_orig_02')
      const identity3 = await seedIdentity('0xISettl_orig_03')
      const bondId1 = await seedBond(identity1)
      const bondId2 = await seedBond(identity2)
      const bondId3 = await seedBond(identity3)

      const first = await repo.upsert({
        bondId: bondId1,
        amount: '50',
        transactionHash: 'tx_itest_orig_01',
      })

      await repo.upsert({ bondId: bondId2, amount: '50', transactionHash: 'tx_itest_orig_01' })
      await repo.upsert({ bondId: bondId3, amount: '50', transactionHash: 'tx_itest_orig_01' })

      const found = await repo.findByTransactionHash('tx_itest_orig_01')
      expect(found).not.toBeNull()
      expect(found!.bondId).toBe(String(bondId1))
      expect(found!.id).toBe(first.settlement.id)
    })
  })

  // =========================================================================
  // Race / concurrent upserts (real Postgres concurrency)
  // =========================================================================

  describe('upsert() – concurrent race conditions', () => {
    it('produces exactly one row when 10 upserts fire in parallel for the same tx hash', async () => {
      if (!isRealPostgres(testDb)) return

      const identity = await seedIdentity('0xISettl_race_01')
      const bondId = await seedBond(identity)
      const input = { bondId, amount: '999', transactionHash: 'tx_itest_race_01' }

      await Promise.all(Array.from({ length: 10 }, () => repo.upsert(input)))

      const { rows } = await pool.query(
        `SELECT COUNT(*)::INT AS cnt FROM settlements WHERE transaction_hash = $1`,
        ['tx_itest_race_01'],
      )
      expect(rows[0].cnt).toBe(1)
    })

    it('all parallel upserts return the same settlement id', async () => {
      if (!isRealPostgres(testDb)) return

      const identity = await seedIdentity('0xISettl_race_02')
      const bondId = await seedBond(identity)
      const input = { bondId, amount: '123', transactionHash: 'tx_itest_race_02' }

      const results = await Promise.all(Array.from({ length: 8 }, () => repo.upsert(input)))

      const ids = new Set(results.map((r) => r.settlement.id))
      expect(ids.size).toBe(1)
    })

    it('concurrent upserts from different bonds produce one row and consistent ids', async () => {
      if (!isRealPostgres(testDb)) return

      const identity1 = await seedIdentity('0xISettl_race_03a')
      const identity2 = await seedIdentity('0xISettl_race_03b')
      const bondId1 = await seedBond(identity1)
      const bondId2 = await seedBond(identity2)

      const jobs = [
        ...Array.from({ length: 4 }, () =>
          repo.upsert({ bondId: bondId1, amount: '10', transactionHash: 'tx_itest_race_03' }),
        ),
        ...Array.from({ length: 4 }, () =>
          repo.upsert({ bondId: bondId2, amount: '20', transactionHash: 'tx_itest_race_03' }),
        ),
      ]

      const results = await Promise.all(jobs)

      // Exactly one DB row
      const { rows } = await pool.query(
        `SELECT COUNT(*)::INT AS cnt FROM settlements WHERE transaction_hash = $1`,
        ['tx_itest_race_03'],
      )
      expect(rows[0].cnt).toBe(1)

      // All callers got the same settlement id
      const ids = new Set(results.map((r) => r.settlement.id))
      expect(ids.size).toBe(1)

      // Total rows across both bonds is still 1
      const count1 = await repo.countByBondId(bondId1)
      const count2 = await repo.countByBondId(bondId2)
      expect(count1 + count2).toBe(1)
    })

    it('exactly one caller gets isDuplicate=false; the rest get isDuplicate=true', async () => {
      if (!isRealPostgres(testDb)) return

      const identity = await seedIdentity('0xISettl_race_04')
      const bondId = await seedBond(identity)
      const input = { bondId, amount: '77', transactionHash: 'tx_itest_race_04' }

      const results = await Promise.all(Array.from({ length: 6 }, () => repo.upsert(input)))

      const nonDuplicates = results.filter((r) => !r.isDuplicate)
      const duplicates = results.filter((r) => r.isDuplicate)

      // Exactly one should be the original insert
      expect(nonDuplicates).toHaveLength(1)
      // The rest are idempotent replays
      expect(duplicates).toHaveLength(5)
    })
  })

  // =========================================================================
  // DB-level constraint enforcement (bypass application layer)
  // =========================================================================

  describe('UNIQUE constraint – enforced at DB level', () => {
    it('raw INSERT with duplicate transaction_hash throws a unique-violation error', async () => {
      if (!isRealPostgres(testDb)) return

      const identity = await seedIdentity('0xISettl_dbraw_01')
      const bondId = await seedBond(identity)

      await pool.query(
        `INSERT INTO settlements (bond_id, amount, transaction_hash, settled_at, status)
         VALUES ($1, $2, $3, NOW(), 'pending')`,
        [bondId, '100', 'tx_itest_raw_01'],
      )

      // Second raw INSERT for the same transaction_hash must fail at DB level
      await expect(
        pool.query(
          `INSERT INTO settlements (bond_id, amount, transaction_hash, settled_at, status)
           VALUES ($1, $2, $3, NOW(), 'pending')`,
          [bondId, '100', 'tx_itest_raw_01'],
        ),
      ).rejects.toMatchObject({
        code: '23505', // PostgreSQL unique_violation
      })
    })

    it('ON CONFLICT DO UPDATE succeeds where a plain INSERT would fail', async () => {
      if (!isRealPostgres(testDb)) return

      const identity = await seedIdentity('0xISettl_dbraw_02')
      const bondId = await seedBond(identity)

      await pool.query(
        `INSERT INTO settlements (bond_id, amount, transaction_hash, settled_at, status)
         VALUES ($1, $2, $3, NOW(), 'pending')`,
        [bondId, '100', 'tx_itest_raw_02'],
      )

      await expect(
        pool.query(
          `INSERT INTO settlements (bond_id, amount, transaction_hash, settled_at, status)
           VALUES ($1, $2, $3, NOW(), 'settled')
           ON CONFLICT (transaction_hash) DO UPDATE
             SET status = EXCLUDED.status, updated_at = NOW()`,
          [bondId, '200', 'tx_itest_raw_02'],
        ),
      ).resolves.toBeDefined()

      const { rows } = await pool.query(
        `SELECT status FROM settlements WHERE transaction_hash = $1`,
        ['tx_itest_raw_02'],
      )
      expect(rows[0].status).toBe('settled')
    })
  })

  // =========================================================================
  // findByTransactionHash()
  // =========================================================================

  describe('findByTransactionHash()', () => {
    it('returns the settlement after upsert', async () => {
      if (!isRealPostgres(testDb)) return

      const identity = await seedIdentity('0xISettl_find_01')
      const bondId = await seedBond(identity)

      await repo.upsert({ bondId, amount: '111', transactionHash: 'tx_itest_find_01' })

      const found = await repo.findByTransactionHash('tx_itest_find_01')
      expect(found).not.toBeNull()
      expect(found!.transactionHash).toBe('tx_itest_find_01')
    })

    it('returns null for an unknown hash', async () => {
      if (!isRealPostgres(testDb)) return

      const found = await repo.findByTransactionHash('tx_itest_nonexistent')
      expect(found).toBeNull()
    })
  })
})
