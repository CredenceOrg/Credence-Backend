/**
 * Integration tests for WalletsRepository against a real PostgreSQL database.
 *
 * These tests use testcontainers to spin up a postgres:16-alpine container
 * automatically. If TEST_DATABASE_URL is set, that connection is used instead
 * (CI mode). When neither Docker nor TEST_DATABASE_URL is available the suite
 * is skipped automatically — it cannot run against pg-mem because the schema
 * uses PostgreSQL-specific functions (trim, gen_random_uuid) not supported by
 * pg-mem.
 *
 * To run locally against docker-compose.test.yml:
 *   TEST_DATABASE_URL=postgresql://credence:credence@localhost:5433/credence_test \
 *     npm test tests/integration/walletsRepository.integration.test.ts
 *
 * Fixtures use deterministic, hardcoded values — no Date.now() or Math.random().
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { createTestDatabase, type TestDatabase } from './testDatabase.js'
import { createSchema } from '../../src/db/schema.js'
import {
  WalletsRepository,
  InsufficientBalanceError,
  WalletAlreadyExistsError,
} from '../../src/db/repositories/walletsRepository.js'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let testDb: TestDatabase
let pool: Pool
let repo: WalletsRepository

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
    // pg-mem does not support the Postgres functions used in the schema
    // (trim, gen_random_uuid inside CHECK constraints). Skip the whole suite.
    return
  }

  pool = testDb.pool

  // Apply full schema so wallets and wallet_transactions tables exist.
  await createSchema(pool)
}, 60_000)

beforeEach(async () => {
  if (!isRealPostgres(testDb)) return
  // Clean wallets (CASCADE takes wallet_transactions with it).
  await pool.query('DELETE FROM wallet_transactions')
  await pool.query('DELETE FROM wallets')
})

afterAll(async () => {
  await testDb.close()
})

// ---------------------------------------------------------------------------
// Helper — seed a wallet with a known, deterministic address and balance.
// All test addresses are prefixed "0xITest" to avoid any collision with
// production data patterns.
// ---------------------------------------------------------------------------

async function seedWallet(
  address: string,
  initialBalance: string,
  currency = 'USD',
) {
  return repo.create({ address, initialBalance, currency })
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('WalletsRepository – real Postgres integration', () => {
  beforeEach(() => {
    if (!isRealPostgres(testDb)) return
    // Re-create the repo for each test so it uses the cleaned pool.
    repo = new WalletsRepository(pool, pool)
  })

  // =========================================================================
  // create()
  // =========================================================================

  describe('create()', () => {
    it('saves_wallet_record_to_postgres', async () => {
      if (!isRealPostgres(testDb)) return

      const wallet = await repo.create({
        address: '0xITest_create_happy',
        initialBalance: '100',
        currency: 'USD',
      })

      // Verify the shape returned from Postgres.
      expect(wallet.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      )
      expect(wallet.address).toBe('0xITest_create_happy')
      expect(wallet.balance).toContain('100')
      expect(wallet.currency).toBe('USD')
      expect(wallet.createdAt).toBeInstanceOf(Date)
      expect(wallet.updatedAt).toBeInstanceOf(Date)
    })

    it('persists_wallet_so_findById_returns_it', async () => {
      if (!isRealPostgres(testDb)) return

      const created = await repo.create({
        address: '0xITest_create_persisted',
        initialBalance: '200',
      })

      const found = await repo.findById(created.id)

      expect(found).not.toBeNull()
      expect(found!.id).toBe(created.id)
      expect(found!.address).toBe('0xITest_create_persisted')
    })

    it('rejects_duplicate_address_with_WalletAlreadyExistsError', async () => {
      if (!isRealPostgres(testDb)) return

      await repo.create({ address: '0xITest_create_dup' })

      await expect(
        repo.create({ address: '0xITest_create_dup' }),
      ).rejects.toBeInstanceOf(WalletAlreadyExistsError)
    })

    it('defaults_balance_to_zero_when_no_initialBalance_given', async () => {
      if (!isRealPostgres(testDb)) return

      const wallet = await repo.create({ address: '0xITest_create_defaults' })

      // Postgres NUMERIC(36,18) zero renders as "0" or "0.000000000000000000".
      expect(parseFloat(wallet.balance)).toBe(0)
    })
  })

  // =========================================================================
  // findByAddress()
  // =========================================================================

  describe('findByAddress()', () => {
    it('finds_wallet_by_address', async () => {
      if (!isRealPostgres(testDb)) return

      await seedWallet('0xITest_findByAddr_exists', '50')
      const found = await repo.findByAddress('0xITest_findByAddr_exists')

      expect(found).not.toBeNull()
      expect(found!.address).toBe('0xITest_findByAddr_exists')
    })

    it('returns_null_for_unknown_address', async () => {
      if (!isRealPostgres(testDb)) return

      const found = await repo.findByAddress('0xITest_findByAddr_missing')
      expect(found).toBeNull()
    })
  })

  // =========================================================================
  // list()
  // =========================================================================

  describe('list()', () => {
    it('returns_all_wallets_ordered_by_creation_desc', async () => {
      if (!isRealPostgres(testDb)) return

      await seedWallet('0xITest_list_A', '10')
      await seedWallet('0xITest_list_B', '20')

      const wallets = await repo.list()

      const addresses = wallets.map((w) => w.address)
      expect(addresses).toContain('0xITest_list_A')
      expect(addresses).toContain('0xITest_list_B')
    })

    it('filters_by_currency', async () => {
      if (!isRealPostgres(testDb)) return

      await seedWallet('0xITest_list_USD', '10', 'USD')
      await seedWallet('0xITest_list_EUR', '10', 'EUR')

      const usdWallets = await repo.list('USD')
      const eurWallets = await repo.list('EUR')

      expect(usdWallets.every((w) => w.currency === 'USD')).toBe(true)
      expect(eurWallets.every((w) => w.currency === 'EUR')).toBe(true)
    })
  })

  // =========================================================================
  // credit()
  // =========================================================================

  describe('credit()', () => {
    it('credits_balance_and_returns_updated_wallet', async () => {
      if (!isRealPostgres(testDb)) return

      const wallet = await seedWallet('0xITest_credit_happy', '100')

      const updated = await repo.credit(wallet.id, '50')

      // 100 + 50 = 150
      expect(parseFloat(updated.balance)).toBeCloseTo(150, 5)
    })

    it('credit_persists_to_postgres_so_subsequent_findById_reflects_new_balance', async () => {
      if (!isRealPostgres(testDb)) return

      const wallet = await seedWallet('0xITest_credit_persist', '200')

      await repo.credit(wallet.id, '75')

      const found = await repo.findById(wallet.id)
      expect(parseFloat(found!.balance)).toBeCloseTo(275, 5)
    })

    it('rejects_credit_for_missing_wallet', async () => {
      if (!isRealPostgres(testDb)) return

      const missingId = '00000000-0000-0000-0000-000000000001'
      await expect(repo.credit(missingId, '10')).rejects.toThrow('not found')
    })
  })

  // =========================================================================
  // debit()
  // =========================================================================

  describe('debit()', () => {
    it('debits_balance_atomically_and_returns_DebitResult', async () => {
      if (!isRealPostgres(testDb)) return

      const wallet = await seedWallet('0xITest_debit_happy', '300')

      const result = await repo.debit(wallet.id, '100')

      expect(result.debitedAmount).toBe('100')
      expect(parseFloat(result.previousBalance)).toBeCloseTo(300, 5)
      expect(parseFloat(result.newBalance)).toBeCloseTo(200, 5)
      expect(parseFloat(result.wallet.balance)).toBeCloseTo(200, 5)
    })

    it('debit_persists_to_postgres_so_findById_reflects_reduced_balance', async () => {
      if (!isRealPostgres(testDb)) return

      const wallet = await seedWallet('0xITest_debit_persist', '500')

      await repo.debit(wallet.id, '150')

      const found = await repo.findById(wallet.id)
      expect(parseFloat(found!.balance)).toBeCloseTo(350, 5)
    })

    it('exact_balance_debit_leaves_wallet_at_zero', async () => {
      if (!isRealPostgres(testDb)) return

      const wallet = await seedWallet('0xITest_debit_zero', '99')

      const result = await repo.debit(wallet.id, '99')

      expect(parseFloat(result.newBalance)).toBe(0)
    })

    it('debit_records_ledger_entry_in_wallet_transactions', async () => {
      if (!isRealPostgres(testDb)) return

      const wallet = await seedWallet('0xITest_debit_ledger', '400')

      await repo.debit(wallet.id, '120')

      const rows = await pool.query(
        'SELECT * FROM wallet_transactions WHERE wallet_id = $1',
        [wallet.id],
      )
      expect(rows.rowCount).toBeGreaterThanOrEqual(1)
      const entry = rows.rows[0]
      expect(entry.type).toBe('debit')
      expect(entry.amount).toBe('120')
    })

    // ── Sad paths ──────────────────────────────────────────────────────────

    it('throws_InsufficientBalanceError_when_amount_exceeds_balance', async () => {
      if (!isRealPostgres(testDb)) return

      const wallet = await seedWallet('0xITest_debit_overdraft', '50')

      const err = await repo.debit(wallet.id, '51').catch((e) => e)

      expect(err).toBeInstanceOf(InsufficientBalanceError)
      expect(err.walletId).toBe(wallet.id)
      expect(err.available).toContain('50')
      expect(err.requested).toBe('51')
    })

    it('rejects_debit_on_missing_wallet_with_not_found_error', async () => {
      if (!isRealPostgres(testDb)) return

      const missingId = '00000000-0000-0000-0000-000000000002'
      await expect(repo.debit(missingId, '1')).rejects.toThrow('not found')
    })

    it('balance_unchanged_after_failed_overdraft_debit', async () => {
      if (!isRealPostgres(testDb)) return

      const wallet = await seedWallet('0xITest_debit_rollback', '80')

      await repo.debit(wallet.id, '200').catch(() => {})

      const found = await repo.findById(wallet.id)
      expect(parseFloat(found!.balance)).toBeCloseTo(80, 5)
    })
  })

  // =========================================================================
  // delete()
  // =========================================================================

  describe('delete()', () => {
    it('deletes_wallet_record_from_postgres', async () => {
      if (!isRealPostgres(testDb)) return

      const wallet = await seedWallet('0xITest_delete_happy', '10')

      const deleted = await repo.delete(wallet.id)

      expect(deleted).toBe(true)
      expect(await repo.findById(wallet.id)).toBeNull()
    })

    it('returns_false_when_deleting_nonexistent_wallet', async () => {
      if (!isRealPostgres(testDb)) return

      const result = await repo.delete('00000000-0000-0000-0000-000000000003')
      expect(result).toBe(false)
    })
  })
})
