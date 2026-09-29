/**
 * Unit tests for WalletTransactionsRepository using a mock Queryable (#1384).
 *
 * No live database or pg-mem required — all SQL is intercepted by a mock so
 * tests remain fast and deterministic.
 *
 * Coverage goals (issue #1384 — boundary and recovery):
 *
 * - Loading / stale states: empty ledger, no balance at a point in time,
 *   inclusive range boundaries, wallet isolation between ledgers.
 * - Error recovery: pg errors (FK 23503, CHECK 23514, lock timeout 55P03)
 *   propagate VERBATIM. This is a load-bearing invariant: TransactionManager
 *   inspects `err.code === "55P03"` to decide whether a retry is safe, so any
 *   error wrapping in the repository would silently break lock-timeout retries
 *   for every credit()/debit() that records to the ledger.
 * - No internal retry: a failed INSERT is attempted exactly once. Blind
 *   retries of a ledger INSERT could double-record an entry (the ledger is
 *   append-only and has no idempotency key), so retries must stay owned by
 *   the caller's transaction manager.
 * - Concurrency: interleaved record() calls each append exactly one row with
 *   their own parameter values (no cross-contamination of awaited params).
 * - Precision boundaries: amount/previous_balance/new_balance are strings end
 *   to end; Number() collapses distinct 17-digit integers, so any numeric
 *   coercion on the read or write path would corrupt the immutable ledger.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Queryable } from '../../src/db/repositories/queryable.js';
import {
  WalletTransactionsRepository,
  type WalletTransaction,
} from '../../src/db/repositories/walletTransactionsRepository.js';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type MockTxRow = {
  id: string;
  wallet_id: string;
  type: 'credit' | 'debit';
  amount: string;
  previous_balance: string;
  new_balance: string;
  created_at: Date | string;
};

/** pg-style error carrying the 5-char SQLSTATE the driver exposes. */
type PgError = Error & { code?: string; detail?: string };

const toDate = (value: Date | string): Date =>
  value instanceof Date ? value : new Date(value);

const byCreatedAtAsc = (a: MockTxRow, b: MockTxRow) =>
  toDate(a.created_at).getTime() - toDate(b.created_at).getTime();

const clone = (row: MockTxRow): MockTxRow => ({ ...row });

// Fixed timeline so boundary tests are deterministic regardless of wall clock.
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T01:00:00.000Z';
const T2 = '2026-01-01T02:00:00.000Z';
const T3 = '2026-01-01T03:00:00.000Z';

const at = (iso: string) => new Date(iso);

interface FailureRule {
  matches: (sql: string) => boolean;
  error: PgError;
  remaining: number; // Infinity = persistent until cleared
}

interface Harness {
  db: Queryable;
  query: ReturnType<typeof vi.fn>;
  /** Every intercepted call, as { sql, values }, in issue order. */
  calls: Array<{ sql: string; values: readonly unknown[] }>;
  ledger: MockTxRow[];
  knownWalletIds: Set<string>;
  failNext: (error: PgError) => void;
  failMatching: (pattern: RegExp, error: PgError) => void;
  clearFailures: () => void;
  setClock: (iso: string) => void;
}

/**
 * Build a mock Queryable that intercepts the exact SQL shapes emitted by
 * WalletTransactionsRepository and emulates the DB contract:
 *
 * - INSERT validates the FK (wallet must be known → 23503) and the type
 *   CHECK constraint ('credit' | 'debit' → 23514), mirroring the
 *   `wallet_transactions` schema, and assigns id/created_at via DEFAULTs.
 * - SELECT shapes emulate ordering (ASC/DESC + LIMIT 1) and COUNT(*) as a
 *   string, exactly as pg returns it.
 */
function makeHarness(): Harness {
  const ledger: MockTxRow[] = [];
  const knownWalletIds = new Set<string>();
  const calls: Harness['calls'] = [];
  const failures: FailureRule[] = [];

  let nowMs = Date.parse(T0);
  const clock = () => new Date(nowMs);

  const query = vi.fn(
    async (text: string | { text: string }, values?: unknown[]) => {
      const sql = (typeof text === 'string' ? text : text.text).trim();
      calls.push({ sql, values: values ?? [] });

      for (const rule of failures) {
        if (rule.remaining > 0 && rule.matches(sql)) {
          if (rule.remaining !== Number.POSITIVE_INFINITY) rule.remaining -= 1;
          throw rule.error;
        }
      }

      // INSERT INTO wallet_transactions … RETURNING … (record())
      if (/^INSERT INTO wallet_transactions/i.test(sql)) {
        const [walletId, type, amount, previousBalance, newBalance] =
          values as string[];

        // Deterministic interleaving point so concurrent record() calls
        // overlap inside the handler, not just before it.
        await new Promise((resolve) => setTimeout(resolve, 0));

        if (!knownWalletIds.has(walletId)) {
          const err = new Error(
            'insert or update on table "wallet_transactions" violates foreign key constraint "wallet_transactions_wallet_id_fkey"',
          ) as PgError;
          err.code = '23503';
          err.detail = `Key (wallet_id)=(${walletId}) is not present in table "wallets".`;
          throw err;
        }
        if (type !== 'credit' && type !== 'debit') {
          const err = new Error(
            'new row for relation "wallet_transactions" violates check constraint "wallet_transactions_type_check"',
          ) as PgError;
          err.code = '23514';
          throw err;
        }

        const row: MockTxRow = {
          id: crypto.randomUUID(),
          wallet_id: walletId,
          type,
          amount,
          previous_balance: previousBalance,
          new_balance: newBalance,
          created_at: clock(),
        };
        ledger.push(row);
        return { rows: [clone(row)], rowCount: 1 };
      }

      // SELECT new_balance … ORDER BY created_at DESC LIMIT 1 (getBalanceAtTime)
      if (/ORDER BY created_at DESC/i.test(sql) && /LIMIT 1/i.test(sql)) {
        const [walletId, timestamp] = values as [string, Date];
        const ts = timestamp.getTime();
        const candidates = ledger
          .filter(
            (r) =>
              r.wallet_id === walletId && toDate(r.created_at).getTime() <= ts,
          )
          .sort(byCreatedAtAsc);
        const last = candidates[candidates.length - 1];
        return {
          rows: last ? [{ new_balance: last.new_balance }] : [],
          rowCount: last ? 1 : 0,
        };
      }

      // SELECT … created_at >= $2 AND created_at <= $3 (findByWalletIdInRange)
      if (/created_at >= \$2/i.test(sql) && /created_at <= \$3/i.test(sql)) {
        const [walletId, start, end] = values as [string, Date, Date];
        const lo = start.getTime();
        const hi = end.getTime();
        const rows = ledger
          .filter((r) => r.wallet_id === walletId)
          .filter((r) => {
            const t = toDate(r.created_at).getTime();
            return t >= lo && t <= hi;
          })
          .sort(byCreatedAtAsc);
        return { rows: rows.map(clone), rowCount: rows.length };
      }

      // SELECT … ORDER BY created_at ASC (findByWalletId)
      if (
        /FROM wallet_transactions/i.test(sql) &&
        /ORDER BY created_at ASC/i.test(sql)
      ) {
        const walletId = values![0] as string;
        const rows = ledger
          .filter((r) => r.wallet_id === walletId)
          .sort(byCreatedAtAsc);
        return { rows: rows.map(clone), rowCount: rows.length };
      }

      // SELECT COUNT(*) as count … (getCountByWalletId)
      if (/COUNT\(\*\)/i.test(sql)) {
        const walletId = values![0] as string;
        const count = ledger.filter((r) => r.wallet_id === walletId).length;
        // pg returns BIGINT columns (COUNT) as strings.
        return { rows: [{ count: String(count) }], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    },
  );

  const db = { query } as unknown as Queryable;

  return {
    db,
    query,
    calls,
    ledger,
    knownWalletIds,
    failNext: (error) =>
      failures.push({ matches: () => true, error, remaining: 1 }),
    failMatching: (pattern, error) =>
      failures.push({ matches: (sql) => pattern.test(sql), error, remaining: Number.POSITIVE_INFINITY }),
    clearFailures: () => {
      failures.length = 0;
    },
    setClock: (iso) => {
      nowMs = Date.parse(iso);
    },
  };
}

function seedTransaction(
  ledger: MockTxRow[],
  override: Partial<MockTxRow> & {
    wallet_id: string;
    created_at: Date | string;
  },
): MockTxRow {
  const row: MockTxRow = {
    id: crypto.randomUUID(),
    type: 'credit',
    amount: '10',
    previous_balance: '0',
    new_balance: '10',
    ...override,
  };
  ledger.push(row);
  return row;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WalletTransactionsRepository', () => {
  let harness: Harness;
  let repo: WalletTransactionsRepository;

  beforeEach(() => {
    harness = makeHarness();
    repo = new WalletTransactionsRepository(harness.db);
  });

  // =========================================================================
  // record()
  // =========================================================================

  describe('record()', () => {
    const validParams = {
      walletId: 'w-1',
      type: 'debit' as const,
      amount: '30',
      previousBalance: '100',
      newBalance: '70',
    };

    it('appends to the ledger and returns the fully mapped transaction', async () => {
      harness.knownWalletIds.add('w-1');
      harness.setClock(T1);

      const tx = await repo.record(validParams);

      expect(harness.ledger).toHaveLength(1);
      expect(tx).toEqual({
        id: expect.any(String),
        walletId: 'w-1',
        type: 'debit',
        amount: '30',
        previousBalance: '100',
        newBalance: '70',
        createdAt: at(T1),
      });
      // createdAt must be a real Date instance, not a string.
      expect(tx.createdAt).toBeInstanceOf(Date);
      // The ledger row id is server-assigned (DB DEFAULT) and echoed back.
      expect(tx.id).toBe(harness.ledger[0].id);
    });

    it('passes parameters verbatim, in order, with no coercion', async () => {
      harness.knownWalletIds.add('w-1');
      const params = {
        walletId: 'w-1',
        type: 'credit' as const,
        amount: '0.000000000000000001',
        previousBalance: '999999999999999998.999999999999999999',
        newBalance: '999999999999999999.999999999999999999',
      };

      await repo.record(params);

      expect(harness.calls).toHaveLength(1);
      expect(harness.calls[0].values).toEqual([
        'w-1',
        'credit',
        '0.000000000000000001',
        '999999999999999998.999999999999999999',
        '999999999999999999.999999999999999999',
      ]);
    });

    it('precision regression — never routes ledger values through Number()', async () => {
      // Number() maps two DISTINCT 17-digit integers to the same float, so any
      // numeric coercion would silently corrupt the immutable ledger.
      harness.knownWalletIds.add('w-1');
      const a = '9007199254740992'; // MAX_SAFE_INTEGER + 1
      const b = '9007199254740993'; // MAX_SAFE_INTEGER + 2
      expect(Number(a)).toBe(Number(b)); // confirm the float collision

      const tx = await repo.record({
        walletId: 'w-1',
        type: 'credit',
        amount: b,
        previousBalance: a,
        newBalance: b,
      });

      expect(tx.amount).toBe(b);
      expect(tx.previousBalance).toBe(a);
      expect(tx.newBalance).toBe(b);
    });

    it('does not mutate the caller-supplied params object', async () => {
      harness.knownWalletIds.add('w-1');
      const params = { ...validParams };
      const snapshot = { ...params };

      await repo.record(params);

      expect(params).toEqual(snapshot);
    });

    it('uses $1–$5 placeholders — values are bound, never interpolated', async () => {
      harness.knownWalletIds.add('w-1');
      // A quote-laden walletId must survive as a bound parameter, not become
      // part of the SQL text (injection regression guard).
      const hostile = `w'; DROP TABLE wallets; --`;
      harness.knownWalletIds.add(hostile);

      await repo.record({
        walletId: hostile,
        type: 'credit',
        amount: '1',
        previousBalance: '0',
        newBalance: '1',
      });

      const { sql, values } = harness.calls[0];
      expect(sql).toContain('$1');
      expect(sql).toContain('$5');
      expect(sql).not.toContain(hostile);
      expect(values[0]).toBe(hostile);
    });

    it('lets the DB assign id and created_at via column DEFAULTs', async () => {
      // The INSERT must not invent its own timestamp (it would drift from the
      // DB clock used by concurrent writers and by ORDER BY created_at).
      harness.knownWalletIds.add('w-1');

      await repo.record(validParams);

      const sql = harness.calls[0].sql;
      expect(sql).toMatch(/^INSERT INTO wallet_transactions/i);
      expect(sql).toMatch(/RETURNING/i);
      // Exactly five bound values: no sixth parameter for a client timestamp.
      expect(harness.calls[0].values).toHaveLength(5);
    });

    it('concurrent record() calls interleave safely — each appends exactly one row with its own values', async () => {
      harness.knownWalletIds.add('w-1');
      harness.knownWalletIds.add('w-2');

      const [credit, debit] = await Promise.all([
        repo.record({
          walletId: 'w-1',
          type: 'credit',
          amount: '5',
          previousBalance: '0',
          newBalance: '5',
        }),
        repo.record({
          walletId: 'w-2',
          type: 'debit',
          amount: '7',
          previousBalance: '10',
          newBalance: '3',
        }),
      ]);

      expect(harness.ledger).toHaveLength(2);
      expect(credit.id).not.toBe(debit.id);

      const byWallet = new Map(harness.ledger.map((r) => [r.wallet_id, r]));
      // No cross-contamination of awaited parameter values between calls.
      expect(byWallet.get('w-1')).toMatchObject({
        type: 'credit',
        amount: '5',
        previous_balance: '0',
        new_balance: '5',
      });
      expect(byWallet.get('w-2')).toMatchObject({
        type: 'debit',
        amount: '7',
        previous_balance: '10',
        new_balance: '3',
      });
    });

    it('duplicate record() calls append two distinct ledger rows (append-only, no silent dedup)', async () => {
      harness.knownWalletIds.add('w-1');

      const first = await repo.record(validParams);
      const second = await repo.record(validParams);

      expect(harness.ledger).toHaveLength(2);
      expect(first.id).not.toBe(second.id);
    });

    it('surfaces FK violations (23503) for unknown wallets verbatim', async () => {
      // No wallet seeded → the DB contract (schema FK) rejects the write.
      const err = await repo
        .record(validParams)
        .catch((e: PgError) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe('23503');
      expect(err.message).toMatch(/foreign key constraint/i);
    });

    it('surfaces CHECK violations (23514) for invalid types verbatim', async () => {
      harness.knownWalletIds.add('w-1');

      const err = await repo
        .record({
          walletId: 'w-1',
          // Runtime cast simulates a caller bypassing the compile-time union.
          type: 'transfer' as unknown as 'credit',
          amount: '1',
          previousBalance: '0',
          newBalance: '1',
        })
        .catch((e: PgError) => e);

      expect(err.code).toBe('23514');
      expect(err.message).toMatch(/check constraint/i);
    });

    it('performs no internal retry — a failed INSERT is attempted exactly once', async () => {
      // Retrying a ledger INSERT from inside the repository could double-record
      // an entry (append-only table, no idempotency key). Retries are owned by
      // the caller's TransactionManager; the repo must fail fast, exactly once.
      harness.knownWalletIds.add('w-1');
      const transient = new Error(
        'lock timeout after 2000ms',
      ) as PgError;
      transient.code = '55P03';
      harness.failNext(transient);

      await expect(repo.record(validParams)).rejects.toBe(transient);
      expect(harness.query).toHaveBeenCalledTimes(1);
      expect(harness.ledger).toHaveLength(0);
    });
  });

  // =========================================================================
  // findByWalletId()
  // =========================================================================

  describe('findByWalletId()', () => {
    it('returns all transactions mapped to camelCase, oldest first', async () => {
      seedTransaction(harness.ledger, {
        wallet_id: 'w-1',
        amount: '5',
        new_balance: '5',
        created_at: at(T2),
      });
      seedTransaction(harness.ledger, {
        wallet_id: 'w-1',
        type: 'debit',
        amount: '2',
        previous_balance: '5',
        new_balance: '3',
        created_at: at(T1),
      });

      const rows = await repo.findByWalletId('w-1');

      expect(rows.map((r) => r.createdAt.toISOString())).toEqual([T1, T2]);
      expect(rows[0]).toMatchObject({
        walletId: 'w-1',
        type: 'debit',
        amount: '2',
        previousBalance: '5',
        newBalance: '3',
      });
      expect(rows[1].type).toBe('credit');
    });

    it('returns [] for a wallet with no transactions (empty ledger boundary)', async () => {
      await expect(repo.findByWalletId('w-empty')).resolves.toEqual([]);
    });

    it('never leaks rows belonging to other wallets', async () => {
      seedTransaction(harness.ledger, { wallet_id: 'w-1', created_at: at(T1) });
      seedTransaction(harness.ledger, { wallet_id: 'w-2', created_at: at(T1) });

      const rows = await repo.findByWalletId('w-1');

      expect(rows).toHaveLength(1);
      expect(rows.every((r) => r.walletId === 'w-1')).toBe(true);
    });

    it('converts string created_at values (driver variance) into Date instances', async () => {
      // The row type admits Date | string; pg usually returns Date for
      // timestamptz, but the mapping must not depend on that.
      seedTransaction(harness.ledger, {
        wallet_id: 'w-1',
        created_at: T1, // string, not Date
      });

      const rows = await repo.findByWalletId('w-1');

      expect(rows[0].createdAt).toBeInstanceOf(Date);
      expect(rows[0].createdAt.toISOString()).toBe(T1);
    });

    it('binds the walletId as a parameter — hostile ids are never interpolated', async () => {
      const hostile = `w'; DELETE FROM wallet_transactions; --`;
      seedTransaction(harness.ledger, { wallet_id: hostile, created_at: at(T1) });

      const rows = await repo.findByWalletId(hostile);

      expect(rows).toHaveLength(1);
      expect(rows[0].walletId).toBe(hostile);
      const { sql, values } = harness.calls[0];
      expect(sql).not.toContain(hostile);
      expect(values[0]).toBe(hostile);
    });

    it('propagates DB failures verbatim — no wrapping, no swallowing', async () => {
      const boom = new Error('connection terminated unexpectedly');
      harness.failNext(boom);

      await expect(repo.findByWalletId('w-1')).rejects.toBe(boom);
    });
  });

  // =========================================================================
  // findByWalletIdInRange()
  // =========================================================================

  describe('findByWalletIdInRange()', () => {
    beforeEach(() => {
      seedTransaction(harness.ledger, {
        wallet_id: 'w-1',
        amount: '1',
        new_balance: '1',
        created_at: at(T0),
      });
      seedTransaction(harness.ledger, {
        wallet_id: 'w-1',
        amount: '2',
        previous_balance: '1',
        new_balance: '3',
        created_at: at(T1),
      });
      seedTransaction(harness.ledger, {
        wallet_id: 'w-1',
        amount: '4',
        previous_balance: '3',
        new_balance: '7',
        created_at: at(T2),
      });
      seedTransaction(harness.ledger, {
        wallet_id: 'w-2', // isolation probe — must never appear for w-1
        created_at: at(T1),
      });
    });

    it('returns only rows within [start, end], both bounds inclusive, oldest first', async () => {
      const rows = await repo.findByWalletIdInRange('w-1', at(T0), at(T2));

      expect(rows.map((r) => r.createdAt.toISOString())).toEqual([T0, T1, T2]);
    });

    it('boundary — start === end selects only rows at that exact instant', async () => {
      const rows = await repo.findByWalletIdInRange('w-1', at(T1), at(T1));

      expect(rows.map((r) => r.createdAt.toISOString())).toEqual([T1]);
    });

    it('boundary — window entirely after the last transaction returns []', async () => {
      const rows = await repo.findByWalletIdInRange('w-1', at(T3), at(T3));

      expect(rows).toEqual([]);
    });

    it('boundary — window entirely before the first transaction returns []', async () => {
      const before = new Date(Date.parse(T0) - 1);
      const rows = await repo.findByWalletIdInRange('w-1', before, before);

      expect(rows).toEqual([]);
    });

    it('passes walletId and both Date bounds as ordered parameters, unmodified', async () => {
      const start = at(T0);
      const end = at(T2);

      await repo.findByWalletIdInRange('w-1', start, end);

      expect(harness.calls[0].values).toEqual(['w-1', start, end]);
      // The caller's Date objects must not be stringified, cloned or mutated.
      expect(harness.calls[0].values![1]).toBe(start);
      expect(harness.calls[0].values![2]).toBe(end);
    });

    it('does not leak other wallets’ rows that fall inside the window', async () => {
      const rows = await repo.findByWalletIdInRange('w-1', at(T0), at(T2));

      expect(rows.every((r) => r.walletId === 'w-1')).toBe(true);
      expect(rows).toHaveLength(3);
    });

    it('propagates DB failures verbatim', async () => {
      const boom = new Error('relation "wallet_transactions" does not exist');
      harness.failNext(boom);

      await expect(
        repo.findByWalletIdInRange('w-1', at(T0), at(T2)),
      ).rejects.toBe(boom);
    });
  });

  // =========================================================================
  // getCountByWalletId()
  // =========================================================================

  describe('getCountByWalletId()', () => {
    it('returns 0 for a wallet with no transactions (boundary)', async () => {
      await expect(repo.getCountByWalletId('w-empty')).resolves.toBe(0);
    });

    it('returns the exact ledger count as a number', async () => {
      seedTransaction(harness.ledger, { wallet_id: 'w-1', created_at: at(T0) });
      seedTransaction(harness.ledger, { wallet_id: 'w-1', created_at: at(T1) });
      seedTransaction(harness.ledger, { wallet_id: 'w-1', created_at: at(T2) });
      seedTransaction(harness.ledger, { wallet_id: 'w-2', created_at: at(T0) });

      await expect(repo.getCountByWalletId('w-1')).resolves.toBe(3);
    });

    it('parses the string COUNT that pg returns for BIGINT columns', async () => {
      seedTransaction(harness.ledger, { wallet_id: 'w-1', created_at: at(T0) });

      await repo.getCountByWalletId('w-1');

      expect(harness.calls[0].sql).toMatch(/COUNT\(\*\)/i);
      expect(typeof harness.calls[0].values![0]).toBe('string');
    });

    it('does not count other wallets’ transactions', async () => {
      seedTransaction(harness.ledger, { wallet_id: 'w-2', created_at: at(T0) });

      await expect(repo.getCountByWalletId('w-1')).resolves.toBe(0);
    });

    it('propagates DB failures verbatim', async () => {
      const boom = new Error('connection reset by peer');
      harness.failNext(boom);

      await expect(repo.getCountByWalletId('w-1')).rejects.toBe(boom);
    });
  });

  // =========================================================================
  // getBalanceAtTime()
  // =========================================================================

  describe('getBalanceAtTime()', () => {
    beforeEach(() => {
      seedTransaction(harness.ledger, {
        wallet_id: 'w-1',
        amount: '10',
        previous_balance: '0',
        new_balance: '10',
        created_at: at(T0),
      });
      seedTransaction(harness.ledger, {
        wallet_id: 'w-1',
        type: 'debit',
        amount: '3',
        previous_balance: '10',
        new_balance: '7',
        created_at: at(T1),
      });
      seedTransaction(harness.ledger, {
        wallet_id: 'w-1',
        type: 'credit',
        amount: '1',
        previous_balance: '7',
        new_balance: '8',
        created_at: at(T2),
      });
    });

    it('returns the latest new_balance at or before the timestamp (DESC + LIMIT 1)', async () => {
      await expect(repo.getBalanceAtTime('w-1', at(T1))).resolves.toBe('7');
      await expect(repo.getBalanceAtTime('w-1', at(T2))).resolves.toBe('8');
    });

    it('boundary — a transaction exactly at the timestamp is included (<= is inclusive)', async () => {
      await expect(repo.getBalanceAtTime('w-1', at(T0))).resolves.toBe('10');
    });

    it('returns null when the ledger has no transaction at or before the timestamp', async () => {
      const before = new Date(Date.parse(T0) - 1);
      await expect(repo.getBalanceAtTime('w-1', before)).resolves.toBeNull();
    });

    it('returns null for a wallet with no transactions at all (stale/empty state)', async () => {
      await expect(repo.getBalanceAtTime('w-never-used', at(T2))).resolves.toBeNull();
    });

    it('ignores other wallets’ transactions when reconstructing the balance', async () => {
      seedTransaction(harness.ledger, {
        wallet_id: 'w-2',
        amount: '999',
        new_balance: '999',
        created_at: at(T1),
      });

      // w-2's 999 must not bleed into w-1's historical balance.
      await expect(repo.getBalanceAtTime('w-1', at(T1))).resolves.toBe('7');
    });

    it('precision regression — returns large balances verbatim as strings', async () => {
      const huge = '9007199254740993'; // collides with …992 under Number()
      seedTransaction(harness.ledger, {
        wallet_id: 'w-big',
        amount: huge,
        previous_balance: '0',
        new_balance: huge,
        created_at: at(T1),
      });

      await expect(repo.getBalanceAtTime('w-big', at(T2))).resolves.toBe(huge);
    });

    it('propagates lock timeouts with their pg code intact (55P03) so callers can retry safely', async () => {
      // TransactionManager.classifies retries via err.code === "55P03".
      // Wrapping or stringifying the error here would silently break
      // lock-timeout retries for every credit()/debit() ledger write.
      const lockTimeout = new Error('lock timeout after 2000ms') as PgError;
      lockTimeout.code = '55P03';
      harness.failMatching(/SELECT/i, lockTimeout);

      const err = await repo
        .getBalanceAtTime('w-1', at(T1))
        .catch((e: PgError) => e);

      expect(err).toBe(lockTimeout);
      expect(err.code).toBe('55P03');
    });
  });
});
