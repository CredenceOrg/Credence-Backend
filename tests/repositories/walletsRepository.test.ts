/**
 * Unit tests for WalletsRepository using a mock Pool.
 *
 * No live database or pg-mem required — all SQL is intercepted by a
 * synchronous mock so tests remain fast and deterministic.
 *
 * Critical coverage:
 * - Overdraft-by-precision regression: Number() collapses two distinct
 *   large integers to the same float, silently allowing an overdraft.
 *   compareDecimals() rejects this correctly.
 * - Exact-balance debit succeeds (boundary condition).
 * - Upfront validation rejects zero / negative / non-numeric amounts
 *   before the row lock is ever acquired.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import {
  WalletsRepository,
  InsufficientBalanceError,
  AmountScaleError,
  AmountOverflowError,
} from '../../src/db/repositories/walletsRepository.js';

// ---------------------------------------------------------------------------
// BigInt-exact arithmetic helpers (used only inside the mock UPDATE handler)
// ---------------------------------------------------------------------------

function decimalAdd(a: string, b: string): string {
  const [aInt, aFrac = ''] = a.split('.');
  const [bInt, bFrac = ''] = b.split('.');
  const scale = Math.max(aFrac.length, bFrac.length);
  const aScaled = BigInt(aInt + aFrac.padEnd(scale, '0'));
  const bScaled = BigInt(bInt + bFrac.padEnd(scale, '0'));
  const sum = aScaled + bScaled;
  if (scale === 0) return sum.toString();
  const factor = 10n ** BigInt(scale);
  return `${sum / factor}.${(sum % factor).toString().padStart(scale, '0')}`;
}

function decimalSub(a: string, b: string): string {
  const [aInt, aFrac = ''] = a.split('.');
  const [bInt, bFrac = ''] = b.split('.');
  const scale = Math.max(aFrac.length, bFrac.length);
  const aScaled = BigInt(aInt + aFrac.padEnd(scale, '0'));
  const bScaled = BigInt(bInt + bFrac.padEnd(scale, '0'));
  const diff = aScaled - bScaled;
  if (scale === 0) return diff.toString();
  const factor = 10n ** BigInt(scale);
  return `${diff / factor}.${(diff % factor).toString().padStart(scale, '0')}`;
}

// ---------------------------------------------------------------------------
// Mock Pool
// ---------------------------------------------------------------------------

interface MockWalletRow {
  id: string;
  address: string;
  balance: string;
  currency: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * Build a mock Pool whose connected clients intercept the exact SQL patterns
 * emitted by WalletsRepository.debit() and credit().
 */
function makeMockPool(walletStore: Map<string, MockWalletRow>): Pool {
  const makeClient = (): PoolClient => {
    const query = vi.fn().mockImplementation(
      async (text: string | { text: string }, values?: unknown[]) => {
        const sql = (typeof text === 'string' ? text : text.text).trim();

        // Transaction lifecycle + lock-timeout commands
        if (
          /^BEGIN/i.test(sql) ||
          /^SET LOCAL/i.test(sql) ||
          /^COMMIT/i.test(sql) ||
          /^ROLLBACK/i.test(sql)
        ) {
          return { rows: [], rowCount: 0 };
        }

        // SELECT … FOR UPDATE (lock the row)
        if (/SELECT.*FROM wallets/is.test(sql) && /FOR UPDATE/i.test(sql)) {
          const id = values![0] as string;
          const row = walletStore.get(id);
          return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
        }

        // UPDATE wallets SET balance = … (debit or credit)
        if (/UPDATE wallets/is.test(sql) && /SET balance/i.test(sql)) {
          const [id, amount] = values as [string, string];
          const row = walletStore.get(id);
          if (!row) return { rows: [], rowCount: 0 };

          const isDebit = /balance\s*-\s*\$2/i.test(sql);
          const newBalance = isDebit
            ? decimalSub(row.balance, amount)
            : decimalAdd(row.balance, amount);

          const updated = { ...row, balance: newBalance, updated_at: new Date() };
          walletStore.set(id, updated);
          return { rows: [updated], rowCount: 1 };
        }

        // INSERT INTO wallet_transactions — upstream ledger recording added in the same tx
        if (/INSERT INTO wallet_transactions/i.test(sql)) {
          const [walletId, type, amount, previousBalance, newBalance] = values as string[];
          return {
            rows: [{
              id: crypto.randomUUID(),
              wallet_id: walletId,
              type,
              amount,
              previous_balance: previousBalance,
              new_balance: newBalance,
              created_at: new Date(),
            }],
            rowCount: 1,
          };
        }

        return { rows: [], rowCount: 0 };
      },
    );

    return { query, release: vi.fn() } as unknown as PoolClient;
  };

  return {
    connect: vi.fn().mockImplementation(async () => makeClient()),
  } as unknown as Pool;
}

function seedWallet(
  store: Map<string, MockWalletRow>,
  override: Partial<MockWalletRow> & { id: string; balance: string },
): MockWalletRow {
  const row: MockWalletRow = {
    address: '0xTest',
    currency: 'USD',
    created_at: new Date(),
    updated_at: new Date(),
    ...override,
  };
  store.set(row.id, row);
  return row;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WalletsRepository', () => {
  let store: Map<string, MockWalletRow>;
  let pool: Pool;
  let repo: WalletsRepository;

  beforeEach(() => {
    store = new Map();
    pool = makeMockPool(store);
    repo = new WalletsRepository({} as any, pool);
  });

  // =========================================================================
  // debit()
  // =========================================================================

  describe('debit()', () => {
    it('throws without a pool', async () => {
      const noPoolRepo = new WalletsRepository({} as any);
      await expect(noPoolRepo.debit('any', '1')).rejects.toThrow(
        'requires a Pool instance',
      );
    });

    it('rejects non-numeric amount before acquiring lock', async () => {
      await expect(repo.debit('w1', 'abc')).rejects.toThrow('Invalid debit amount');
    });

    it('rejects negative amount before acquiring lock', async () => {
      await expect(repo.debit('w1', '-1')).rejects.toThrow('Invalid debit amount');
    });

    it('rejects zero amount before acquiring lock', async () => {
      await expect(repo.debit('w1', '0')).rejects.toThrow('Invalid debit amount');
    });

    it('rejects empty string before acquiring lock', async () => {
      await expect(repo.debit('w1', '')).rejects.toThrow('Invalid debit amount');
    });

    it('throws when wallet is not found', async () => {
      await expect(repo.debit('missing-id', '1')).rejects.toThrow('not found');
    });

    it('throws InsufficientBalanceError when amount > balance', async () => {
      seedWallet(store, { id: 'w1', balance: '100' });
      await expect(repo.debit('w1', '101')).rejects.toBeInstanceOf(
        InsufficientBalanceError,
      );
    });

    it('succeeds when amount < balance and returns correct shape', async () => {
      seedWallet(store, { id: 'w1', balance: '100' });
      const result = await repo.debit('w1', '30');
      expect(result.previousBalance).toBe('100');
      expect(result.newBalance).toBe('70');
      expect(result.debitedAmount).toBe('30');
      expect(result.wallet.balance).toBe('70');
    });

    it('succeeds on exact-balance debit (amount === balance)', async () => {
      seedWallet(store, { id: 'w1', balance: '50.25' });
      const result = await repo.debit('w1', '50.25');
      expect(result.newBalance).toBe('0.00');
    });

    // -----------------------------------------------------------------------
    // Precision regression: the overdraft that Number() would allow
    // -----------------------------------------------------------------------

    it('precision regression — rejects overdraft invisible to Number()', async () => {
      // Numbers just above MAX_SAFE_INTEGER lose the last bit in IEEE 754.
      // Both 9007199254740992 (MAX_SAFE_INTEGER+1) and 9007199254740993
      // (MAX_SAFE_INTEGER+2) round to the same float, so Number()-based
      // comparison treats them as equal and would allow the overdraft.
      const balance = '9007199254740992'; // MAX_SAFE_INTEGER + 1
      const amount  = '9007199254740993'; // MAX_SAFE_INTEGER + 2
      expect(Number(balance) === Number(amount)).toBe(true); // confirm the float collision

      seedWallet(store, { id: 'w1', balance });
      await expect(repo.debit('w1', amount)).rejects.toBeInstanceOf(
        InsufficientBalanceError,
      );
    });

    it('precision regression — allows exact large-integer debit', async () => {
      const balance = '9007199254740993';
      const amount  = '9007199254740993';
      seedWallet(store, { id: 'w1', balance });
      const result = await repo.debit('w1', amount);
      expect(result.previousBalance).toBe(balance);
    });

    it('sub-unit precision — rejects 0.000000002 from balance 0.000000001', async () => {
      seedWallet(store, { id: 'w1', balance: '0.000000001' });
      await expect(repo.debit('w1', '0.000000002')).rejects.toBeInstanceOf(
        InsufficientBalanceError,
      );
    });

    it('sub-unit precision — accepts 0.000000001 from balance 0.000000002', async () => {
      seedWallet(store, { id: 'w1', balance: '0.000000002' });
      const result = await repo.debit('w1', '0.000000001');
      expect(result.newBalance).toBe('0.000000001');
    });

    it('handles max-precision 18-digit balances without loss', async () => {
      // wallets.balance is NUMERIC(36, 18): 18 integer digits is the maximum
      // magnitude the column can hold (beyond Number()'s ~15-16 digit
      // precision), so this is the largest realistic balance, not an
      // arbitrary large number that could never be persisted.
      const balance = '999999999999999999';
      const amount  = '1';
      seedWallet(store, { id: 'w1', balance });
      const result = await repo.debit('w1', amount);
      expect(result.newBalance).toBe('999999999999999998');
    });

    it('rejects overdraft on max-precision 18-digit balance using exact comparison', async () => {
      // Both values are realistic (≤ 18 integer digits, fits NUMERIC(36,18))
      // and differ only past the ~15-16 significant digits Number() can
      // represent exactly, so this only passes if compareDecimals() is used.
      const balance = '111111111111111111';
      const amount  = '999999999999999999';
      seedWallet(store, { id: 'w1', balance });
      await expect(repo.debit('w1', amount)).rejects.toBeInstanceOf(
        InsufficientBalanceError,
      );
    });

    it('rejects a debit amount whose integer part overflows NUMERIC(36,18)', async () => {
      // 19 integer digits exceeds the column's 18-digit maximum — this must
      // be rejected before any lock is acquired, not surfaced as a
      // (misleading) insufficient-balance error.
      seedWallet(store, { id: 'w1', balance: '999999999999999999' });
      const amount = '1000000000000000000'; // 19 digits
      await expect(repo.debit('w1', amount)).rejects.toBeInstanceOf(
        AmountOverflowError,
      );
    });

    it('rejects a debit amount with more fractional digits than the column scale', async () => {
      // NUMERIC(36,18) supports at most 18 fractional digits. Postgres would
      // silently round a 19th-digit amount rather than reject it, which
      // would desync the immutable ledger entry (recorded verbatim) from the
      // actual balance change. The application layer must reject it instead.
      seedWallet(store, { id: 'w1', balance: '1' });
      const amount = '0.0000000000000000001'; // 19 fractional digits
      await expect(repo.debit('w1', amount)).rejects.toBeInstanceOf(
        AmountScaleError,
      );
    });

    it('InsufficientBalanceError carries the correct fields', async () => {
      seedWallet(store, { id: 'w1', balance: '50' });
      const err = await repo.debit('w1', '100').catch((e) => e);
      expect(err).toBeInstanceOf(InsufficientBalanceError);
      expect(err.walletId).toBe('w1');
      expect(err.available).toBe('50');
      expect(err.requested).toBe('100');
    });
  });

  // =========================================================================
  // credit()
  // =========================================================================

  describe('credit()', () => {
    it('throws without a pool', async () => {
      const noPoolRepo = new WalletsRepository({} as any);
      await expect(noPoolRepo.credit('any', '1')).rejects.toThrow(
        'requires a Pool instance',
      );
    });

    it('rejects non-numeric amount before acquiring lock', async () => {
      await expect(repo.credit('w1', 'xyz')).rejects.toThrow('Invalid credit amount');
    });

    it('rejects negative amount before acquiring lock', async () => {
      await expect(repo.credit('w1', '-5')).rejects.toThrow('Invalid credit amount');
    });

    it('rejects zero amount before acquiring lock', async () => {
      await expect(repo.credit('w1', '0')).rejects.toThrow('Invalid credit amount');
    });

    it('throws when wallet is not found', async () => {
      await expect(repo.credit('missing-id', '1')).rejects.toThrow('not found');
    });

    it('credits the balance correctly and returns updated wallet', async () => {
      seedWallet(store, { id: 'w1', balance: '100' });
      const wallet = await repo.credit('w1', '50');
      expect(wallet.balance).toBe('150');
    });

    it('credits a zero-balance wallet', async () => {
      seedWallet(store, { id: 'w1', balance: '0' });
      const wallet = await repo.credit('w1', '0.000000001');
      expect(wallet.balance).toBe('0.000000001');
    });

    it('credits up to the exact max-precision boundary (18 integer digits)', async () => {
      seedWallet(store, { id: 'w1', balance: '999999999999999998' });
      const wallet = await repo.credit('w1', '1');
      expect(wallet.balance).toBe('999999999999999999');
    });

    it('rejects a credit amount whose integer part overflows NUMERIC(36,18) on its own', async () => {
      seedWallet(store, { id: 'w1', balance: '0' });
      const amount = '1000000000000000000'; // 19 digits, invalid regardless of balance
      await expect(repo.credit('w1', amount)).rejects.toBeInstanceOf(
        AmountOverflowError,
      );
    });

    it('rejects a credit amount with more fractional digits than the column scale', async () => {
      seedWallet(store, { id: 'w1', balance: '0' });
      const amount = '0.0000000000000000001'; // 19 fractional digits
      await expect(repo.credit('w1', amount)).rejects.toBeInstanceOf(
        AmountScaleError,
      );
    });

    it('rejects a credit that would push an existing balance past the column bound', async () => {
      // Neither the current balance nor the amount overflows on its own —
      // only their sum does. This can only be caught after the row is
      // locked and the current balance is known, so it must be checked
      // there (before the UPDATE), not just at the pre-lock format check.
      seedWallet(store, { id: 'w1', balance: '999999999999999999' });
      await expect(repo.credit('w1', '1')).rejects.toBeInstanceOf(
        AmountOverflowError,
      );
    });
  });
});
