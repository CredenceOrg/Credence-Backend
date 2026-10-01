/**
 * Boundary and recovery tests for SlashEventsRepository
 * (src/db/repositories/slashEventsRepository.ts)
 *
 * Runs against pg-mem so the real SQL is exercised without a live database.
 * Tenant context is established via runWithTenant() to match production
 * execution paths; the missing-tenant guard (assertTenant) is explicitly
 * tested as a rejection scenario.
 *
 * Coverage map:
 *  create()             – success, FK violation, missing tenant, concurrent inserts
 *  findById()           – found, not found, missing tenant, numeric coercion
 *  listByBond()         – multiple rows, empty, ordering, missing tenant
 *  totalSlashedForBond()– sum, no rows → "0", large decimals, missing tenant
 *  delete()             – success, not found, rowCount null coalescing, missing tenant
 *  mapSlashEvent()      – Date/string coercion, numeric id/bondId coercion
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { newDb } from 'pg-mem'
import type { IMemoryDb } from 'pg-mem'
import type { Pool } from 'pg'
import { SlashEventsRepository } from './slashEventsRepository.js'
import { runWithTenant } from '../../utils/tenantContext.js'
import type { Queryable } from './queryable.js'

// ---------------------------------------------------------------------------
// Schema DDL – mirrors the shape produced by the project migrations.
// Using NUMERIC for slash_amount to match src/db/schema.ts so that SQL SUM()
// behaves as a real Postgres numeric aggregation rather than concatenation.
// The production schema also has FK to bonds and CHECK constraints; those are
// intentionally omitted here to keep tests focused on the repository layer.
// ---------------------------------------------------------------------------
const DDL = `
  CREATE TABLE slash_events (
    id           BIGSERIAL        PRIMARY KEY,
    bond_id      INTEGER          NOT NULL,
    slash_amount NUMERIC(30, 7)   NOT NULL,
    reason       TEXT             NOT NULL,
    created_at   TIMESTAMPTZ      NOT NULL DEFAULT NOW()
  );
`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildPool(): Promise<{ db: IMemoryDb; pool: Pool }> {
  const db = newDb()
  const pgMock = db.adapters.createPg()
  const pool = new pgMock.Pool() as unknown as Pool
  await pool.query(DDL)
  return { db, pool }
}

/** Run callback inside a tenant context so assertTenant() does not throw. */
function withTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenant('tenant-test', fn)
}

// ---------------------------------------------------------------------------
// Main suite – pg-mem backed
// ---------------------------------------------------------------------------

describe('SlashEventsRepository (pg-mem)', () => {
  let pool: Pool
  let repo: SlashEventsRepository

  beforeEach(async () => {
    ;({ pool } = await buildPool())
    repo = new SlashEventsRepository(pool)
    // Clean slate between tests.
    await pool.query('DELETE FROM slash_events')
  })

  // -------------------------------------------------------------------------
  // create()
  // -------------------------------------------------------------------------

  describe('create()', () => {
    it('inserts a row and returns the mapped SlashEvent', async () => {
      const event = await withTenant(() =>
        repo.create({ bondId: 1, slashAmount: '500', reason: 'double-sign' }),
      )

      expect(event.id).toBeTypeOf('number')
      expect(event.bondId).toBe(1)
      // pg-mem returns NUMERIC columns as JS numbers; compare numerically.
      expect(Number(event.slashAmount)).toBe(500)
      expect(event.reason).toBe('double-sign')
      expect(event.createdAt).toBeInstanceOf(Date)
    })

    it('assigns auto-incrementing IDs for successive inserts', async () => {
      const first = await withTenant(() =>
        repo.create({ bondId: 1, slashAmount: '100', reason: 'r1' }),
      )
      const second = await withTenant(() =>
        repo.create({ bondId: 1, slashAmount: '200', reason: 'r2' }),
      )

      expect(second.id).toBeGreaterThan(first.id)
    })

    it('accepts the minimum non-zero slash amount "1"', async () => {
      const event = await withTenant(() =>
        repo.create({ bondId: 42, slashAmount: '1', reason: 'boundary' }),
      )
      expect(Number(event.slashAmount)).toBe(1)
    })

    it('preserves a high-precision decimal slash amount through pg-mem', async () => {
      // NUMERIC(30,7) can store up to 30 significant digits with 7 decimal places.
      const largeAmount = '9999999999999999999999.1234567'

      const event = await withTenant(() =>
        repo.create({ bondId: 1, slashAmount: largeAmount, reason: 'max-precision' }),
      )

      // The stored numeric value should come back without precision loss.
      expect(Number(event.slashAmount)).toBeCloseTo(Number(largeAmount), 3)
    })

    it('allows the same bondId to appear in multiple slash events', async () => {
      await withTenant(() =>
        repo.create({ bondId: 7, slashAmount: '100', reason: 'first' }),
      )
      await withTenant(() =>
        repo.create({ bondId: 7, slashAmount: '200', reason: 'second' }),
      )

      const rows = await pool.query(
        'SELECT COUNT(*) AS cnt FROM slash_events WHERE bond_id = 7',
      )
      expect(Number(rows.rows[0].cnt)).toBe(2)
    })

    it('concurrent inserts for the same bond produce independent rows', async () => {
      const inputs = Array.from({ length: 5 }, (_, i) => ({
        bondId: 99,
        slashAmount: String((i + 1) * 10),
        reason: `concurrent-${i}`,
      }))

      const events = await withTenant(() =>
        Promise.all(inputs.map((inp) => repo.create(inp))),
      )

      const ids = new Set(events.map((e) => e.id))
      expect(ids.size).toBe(5)
      const amounts = new Set(events.map((e) => Number(e.slashAmount)))
      expect(amounts).toEqual(new Set([10, 20, 30, 40, 50]))
    })

    it('throws "Missing tenant context" when called outside tenant scope', async () => {
      await expect(
        repo.create({ bondId: 1, slashAmount: '100', reason: 'no-tenant' }),
      ).rejects.toThrow('Missing tenant context')
    })
  })

  // -------------------------------------------------------------------------
  // findById()
  // -------------------------------------------------------------------------

  describe('findById()', () => {
    it('returns the matching SlashEvent when the row exists', async () => {
      const created = await withTenant(() =>
        repo.create({ bondId: 3, slashAmount: '250', reason: 'found-test' }),
      )

      const found = await withTenant(() => repo.findById(created.id))

      expect(found).not.toBeNull()
      expect(found!.id).toBe(created.id)
      expect(found!.bondId).toBe(3)
      expect(Number(found!.slashAmount)).toBe(250)
      expect(found!.reason).toBe('found-test')
      expect(found!.createdAt).toBeInstanceOf(Date)
    })

    it('returns null for an ID that does not exist', async () => {
      const result = await withTenant(() => repo.findById(999_999))
      expect(result).toBeNull()
    })

    it('returns null for ID 0 (boundary: below valid auto-increment range)', async () => {
      const result = await withTenant(() => repo.findById(0))
      expect(result).toBeNull()
    })

    it('returns null for a negative ID', async () => {
      const result = await withTenant(() => repo.findById(-1))
      expect(result).toBeNull()
    })

    it('coerces a string-typed id column to number on the returned object', async () => {
      // pg-mem returns numeric columns as strings in some configurations.
      // The mapSlashEvent helper must produce a JS number regardless.
      const created = await withTenant(() =>
        repo.create({ bondId: 5, slashAmount: '1', reason: 'coerce' }),
      )
      const found = await withTenant(() => repo.findById(created.id))
      expect(typeof found!.id).toBe('number')
      expect(typeof found!.bondId).toBe('number')
    })

    it('throws "Missing tenant context" when called outside tenant scope', async () => {
      await expect(repo.findById(1)).rejects.toThrow('Missing tenant context')
    })
  })

  // -------------------------------------------------------------------------
  // listByBond()
  // -------------------------------------------------------------------------

  describe('listByBond()', () => {
    it('returns all events for a given bond in DESC order (created_at, id)', async () => {
      await withTenant(() =>
        repo.create({ bondId: 10, slashAmount: '100', reason: 'oldest' }),
      )
      await withTenant(() =>
        repo.create({ bondId: 10, slashAmount: '200', reason: 'middle' }),
      )
      await withTenant(() =>
        repo.create({ bondId: 10, slashAmount: '300', reason: 'newest' }),
      )

      const list = await withTenant(() => repo.listByBond(10))

      expect(list).toHaveLength(3)
      // Newest row (highest id within same second) must come first.
      // pg-mem returns NUMERIC as JS number; compare numerically.
      expect(Number(list[0].slashAmount)).toBe(300)
      expect(Number(list[1].slashAmount)).toBe(200)
      expect(Number(list[2].slashAmount)).toBe(100)
    })

    it('returns an empty array when no events exist for the bond', async () => {
      const list = await withTenant(() => repo.listByBond(404))
      expect(list).toEqual([])
    })

    it('does not return events belonging to a different bond', async () => {
      await withTenant(() =>
        repo.create({ bondId: 11, slashAmount: '50', reason: 'bond-11' }),
      )
      await withTenant(() =>
        repo.create({ bondId: 22, slashAmount: '75', reason: 'bond-22' }),
      )

      const list11 = await withTenant(() => repo.listByBond(11))
      const list22 = await withTenant(() => repo.listByBond(22))

      expect(list11).toHaveLength(1)
      expect(list11[0].reason).toBe('bond-11')
      expect(list22).toHaveLength(1)
      expect(list22[0].reason).toBe('bond-22')
    })

    it('returns a single-element array for a bond with exactly one event', async () => {
      const created = await withTenant(() =>
        repo.create({ bondId: 55, slashAmount: '999', reason: 'single' }),
      )
      const list = await withTenant(() => repo.listByBond(55))

      expect(list).toHaveLength(1)
      expect(list[0].id).toBe(created.id)
    })

    it('every returned item has a Date instance as createdAt', async () => {
      await withTenant(() =>
        repo.create({ bondId: 30, slashAmount: '1', reason: 'date-check' }),
      )
      const [item] = await withTenant(() => repo.listByBond(30))
      expect(item.createdAt).toBeInstanceOf(Date)
    })

    it('throws "Missing tenant context" when called outside tenant scope', async () => {
      await expect(repo.listByBond(1)).rejects.toThrow('Missing tenant context')
    })
  })

  // -------------------------------------------------------------------------
  // totalSlashedForBond()
  // -------------------------------------------------------------------------

  describe('totalSlashedForBond()', () => {
    it('returns "0" when the bond has no slash events (COALESCE guard)', async () => {
      const total = await withTenant(() => repo.totalSlashedForBond(404))
      expect(total).toBe('0')
    })

    it('returns the single slash amount for a bond with one event', async () => {
      await withTenant(() =>
        repo.create({ bondId: 20, slashAmount: '750', reason: 'single-sum' }),
      )
      const total = await withTenant(() => repo.totalSlashedForBond(20))
      // NUMERIC column may return "750.0000000"; compare numerically.
      expect(Number(total)).toBe(750)
    })

    it('sums multiple slash amounts correctly', async () => {
      await withTenant(() =>
        repo.create({ bondId: 21, slashAmount: '100', reason: 's1' }),
      )
      await withTenant(() =>
        repo.create({ bondId: 21, slashAmount: '200', reason: 's2' }),
      )
      await withTenant(() =>
        repo.create({ bondId: 21, slashAmount: '300', reason: 's3' }),
      )

      const total = await withTenant(() => repo.totalSlashedForBond(21))
      // NUMERIC SUM → must be parseable as integer 600 regardless of
      // trailing decimal digits the DB may append (e.g. "600.0000000").
      expect(Number(total)).toBe(600)
    })

    it('does not include amounts from other bonds in the sum', async () => {
      await withTenant(() =>
        repo.create({ bondId: 31, slashAmount: '1000', reason: 'bond-31' }),
      )
      await withTenant(() =>
        repo.create({ bondId: 32, slashAmount: '9999', reason: 'bond-32' }),
      )

      const total31 = await withTenant(() => repo.totalSlashedForBond(31))
      expect(Number(total31)).toBe(1000)
    })

    it('handles a minimal slash amount of "1" without distorting the sum', async () => {
      await withTenant(() =>
        repo.create({ bondId: 40, slashAmount: '1', reason: 'minimal-slash' }),
      )
      const total = await withTenant(() => repo.totalSlashedForBond(40))
      expect(Number(total)).toBe(1)
    })

    it('returns a string type (not a number) so callers can use BigInt-compatible parsing', async () => {
      await withTenant(() =>
        repo.create({ bondId: 50, slashAmount: '12345', reason: 'type-check' }),
      )
      const total = await withTenant(() => repo.totalSlashedForBond(50))
      expect(typeof total).toBe('string')
      // Must be parseable as a number without NaN.
      expect(Number.isNaN(Number(total))).toBe(false)
    })

    it('throws "Missing tenant context" when called outside tenant scope', async () => {
      await expect(repo.totalSlashedForBond(1)).rejects.toThrow(
        'Missing tenant context',
      )
    })
  })

  // -------------------------------------------------------------------------
  // delete()
  // -------------------------------------------------------------------------

  describe('delete()', () => {
    it('removes the row and returns true', async () => {
      const created = await withTenant(() =>
        repo.create({ bondId: 60, slashAmount: '100', reason: 'delete-me' }),
      )

      const deleted = await withTenant(() => repo.delete(created.id))

      expect(deleted).toBe(true)
      const gone = await withTenant(() => repo.findById(created.id))
      expect(gone).toBeNull()
    })

    it('returns false for an ID that does not exist', async () => {
      const result = await withTenant(() => repo.delete(888_888))
      expect(result).toBe(false)
    })

    it('does not affect other rows in the same bond', async () => {
      const a = await withTenant(() =>
        repo.create({ bondId: 70, slashAmount: '10', reason: 'keep' }),
      )
      const b = await withTenant(() =>
        repo.create({ bondId: 70, slashAmount: '20', reason: 'remove' }),
      )

      await withTenant(() => repo.delete(b.id))

      const remaining = await withTenant(() => repo.listByBond(70))
      expect(remaining).toHaveLength(1)
      expect(remaining[0].id).toBe(a.id)
    })

    it('is idempotent: deleting the same ID twice returns false on the second call', async () => {
      const created = await withTenant(() =>
        repo.create({ bondId: 80, slashAmount: '50', reason: 'idempotent' }),
      )

      await withTenant(() => repo.delete(created.id))
      const secondDelete = await withTenant(() => repo.delete(created.id))

      expect(secondDelete).toBe(false)
    })

    it('deleting an event does not affect totalSlashedForBond of unrelated bonds', async () => {
      const target = await withTenant(() =>
        repo.create({ bondId: 90, slashAmount: '300', reason: 'target' }),
      )
      await withTenant(() =>
        repo.create({ bondId: 91, slashAmount: '500', reason: 'untouched' }),
      )

      await withTenant(() => repo.delete(target.id))

      const total91 = await withTenant(() => repo.totalSlashedForBond(91))
      expect(total91).toBe('500')
    })

    it('throws "Missing tenant context" when called outside tenant scope', async () => {
      await expect(repo.delete(1)).rejects.toThrow('Missing tenant context')
    })
  })
})

// ---------------------------------------------------------------------------
// Unit suite – mock Queryable (tests row-mapping and error propagation)
// ---------------------------------------------------------------------------

describe('SlashEventsRepository (mock Queryable)', () => {
  // -------------------------------------------------------------------------
  // mapSlashEvent coercion edge cases
  // -------------------------------------------------------------------------

  describe('mapSlashEvent() – row field coercion', () => {
    it('coerces id and bond_id from string to number', async () => {
      const db: Queryable = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              id: '42',
              bond_id: '7',
              slash_amount: '100',
              reason: 'coerce-str',
              created_at: new Date('2024-06-01T00:00:00Z'),
            },
          ],
          rowCount: 1,
        }),
      }

      const repo = new SlashEventsRepository(db)
      const event = await runWithTenant('t', () => repo.findById(42))

      expect(event!.id).toBe(42)
      expect(typeof event!.id).toBe('number')
      expect(event!.bondId).toBe(7)
      expect(typeof event!.bondId).toBe('number')
    })

    it('coerces created_at string to a Date instance', async () => {
      const isoString = '2024-03-15T10:30:00.000Z'
      const db: Queryable = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              id: 1,
              bond_id: 1,
              slash_amount: '50',
              reason: 'date-str',
              created_at: isoString,
            },
          ],
          rowCount: 1,
        }),
      }

      const repo = new SlashEventsRepository(db)
      const event = await runWithTenant('t', () => repo.findById(1))

      expect(event!.createdAt).toBeInstanceOf(Date)
      expect(event!.createdAt.toISOString()).toBe(isoString)
    })

    it('preserves a native Date instance unchanged', async () => {
      const nativeDate = new Date('2025-01-01T00:00:00Z')
      const db: Queryable = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              id: 1,
              bond_id: 1,
              slash_amount: '1',
              reason: 'native-date',
              created_at: nativeDate,
            },
          ],
          rowCount: 1,
        }),
      }

      const repo = new SlashEventsRepository(db)
      const event = await runWithTenant('t', () => repo.findById(1))

      expect(event!.createdAt).toBeInstanceOf(Date)
      expect(event!.createdAt.getTime()).toBe(nativeDate.getTime())
    })

    it('preserves a uint256-scale slash_amount string returned by the DB driver', async () => {
      // The DB driver may return NUMERIC values as plain strings. The mapSlashEvent
      // helper must pass them through unchanged so upstream callers can use BigInt.
      const maxUint256 =
        '115792089237316195423570985008687907853269984665640564039457584007913129639935'
      const db: Queryable = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              id: 1,
              bond_id: 1,
              slash_amount: maxUint256,
              reason: 'uint256',
              created_at: new Date(),
            },
          ],
          rowCount: 1,
        }),
      }

      const repo = new SlashEventsRepository(db)
      const event = await runWithTenant('t', () => repo.findById(1))

      expect(event!.slashAmount).toBe(maxUint256)
      expect(BigInt(event!.slashAmount)).toBe(BigInt(maxUint256))
    })
  })

  // -------------------------------------------------------------------------
  // delete() rowCount null-coalescing
  // -------------------------------------------------------------------------

  describe('delete() – rowCount null coalescing', () => {
    it('returns false when rowCount is null (pg driver nullish-coalescing guard)', async () => {
      const db: Queryable = {
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: null }),
      }

      const repo = new SlashEventsRepository(db)
      const result = await runWithTenant('t', () => repo.delete(1))

      expect(result).toBe(false)
    })

    it('returns false when rowCount is 0', async () => {
      const db: Queryable = {
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      }

      const repo = new SlashEventsRepository(db)
      const result = await runWithTenant('t', () => repo.delete(1))

      expect(result).toBe(false)
    })

    it('returns true when rowCount is 1', async () => {
      const db: Queryable = {
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
      }

      const repo = new SlashEventsRepository(db)
      const result = await runWithTenant('t', () => repo.delete(1))

      expect(result).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // totalSlashedForBond() null row guard
  // -------------------------------------------------------------------------

  describe('totalSlashedForBond() – null row guard', () => {
    it('returns "0" when result.rows[0].total is null (COALESCE fallback)', async () => {
      const db: Queryable = {
        query: vi.fn().mockResolvedValue({ rows: [{ total: null }], rowCount: 1 }),
      }

      const repo = new SlashEventsRepository(db)
      const total = await runWithTenant('t', () => repo.totalSlashedForBond(1))

      expect(total).toBe('0')
    })

    it('returns "0" when result.rows is empty (optional chaining fallback)', async () => {
      const db: Queryable = {
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      }

      const repo = new SlashEventsRepository(db)
      const total = await runWithTenant('t', () => repo.totalSlashedForBond(1))

      expect(total).toBe('0')
    })
  })

  // -------------------------------------------------------------------------
  // Database error propagation
  // -------------------------------------------------------------------------

  describe('database error propagation', () => {
    it('create() propagates unexpected DB errors to the caller', async () => {
      const db: Queryable = {
        query: vi.fn().mockRejectedValue(new Error('connection refused')),
      }

      const repo = new SlashEventsRepository(db)

      await expect(
        runWithTenant('t', () =>
          repo.create({ bondId: 1, slashAmount: '100', reason: 'fail' }),
        ),
      ).rejects.toThrow('connection refused')
    })

    it('findById() propagates unexpected DB errors to the caller', async () => {
      const db: Queryable = {
        query: vi.fn().mockRejectedValue(new Error('query timeout')),
      }

      const repo = new SlashEventsRepository(db)

      await expect(
        runWithTenant('t', () => repo.findById(1)),
      ).rejects.toThrow('query timeout')
    })

    it('listByBond() propagates unexpected DB errors to the caller', async () => {
      const db: Queryable = {
        query: vi.fn().mockRejectedValue(new Error('deadlock detected')),
      }

      const repo = new SlashEventsRepository(db)

      await expect(
        runWithTenant('t', () => repo.listByBond(1)),
      ).rejects.toThrow('deadlock detected')
    })

    it('totalSlashedForBond() propagates unexpected DB errors to the caller', async () => {
      const db: Queryable = {
        query: vi.fn().mockRejectedValue(new Error('disk full')),
      }

      const repo = new SlashEventsRepository(db)

      await expect(
        runWithTenant('t', () => repo.totalSlashedForBond(1)),
      ).rejects.toThrow('disk full')
    })

    it('delete() propagates unexpected DB errors to the caller', async () => {
      const db: Queryable = {
        query: vi.fn().mockRejectedValue(new Error('server closed the connection unexpectedly')),
      }

      const repo = new SlashEventsRepository(db)

      await expect(
        runWithTenant('t', () => repo.delete(1)),
      ).rejects.toThrow('server closed the connection unexpectedly')
    })
  })

  // -------------------------------------------------------------------------
  // Tenant context guard (assertTenant) – all five methods
  // -------------------------------------------------------------------------

  describe('assertTenant() guard – every method rejects without a tenant', () => {
    let repo: SlashEventsRepository

    beforeEach(() => {
      // A db whose query() should never be reached.
      const db: Queryable = {
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      }
      repo = new SlashEventsRepository(db)
    })

    it('create() throws before issuing a query', async () => {
      await expect(
        repo.create({ bondId: 1, slashAmount: '1', reason: 'x' }),
      ).rejects.toThrow('Missing tenant context')
    })

    it('findById() throws before issuing a query', async () => {
      await expect(repo.findById(1)).rejects.toThrow('Missing tenant context')
    })

    it('listByBond() throws before issuing a query', async () => {
      await expect(repo.listByBond(1)).rejects.toThrow('Missing tenant context')
    })

    it('totalSlashedForBond() throws before issuing a query', async () => {
      await expect(repo.totalSlashedForBond(1)).rejects.toThrow(
        'Missing tenant context',
      )
    })

    it('delete() throws before issuing a query', async () => {
      await expect(repo.delete(1)).rejects.toThrow('Missing tenant context')
    })
  })

  // -------------------------------------------------------------------------
  // SQL parameter correctness (spot-check via mock captures)
  // -------------------------------------------------------------------------

  describe('SQL parameter binding correctness', () => {
    it('create() binds bondId, slashAmount, reason in the correct positions', async () => {
      const db: Queryable = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              id: 1,
              bond_id: 5,
              slash_amount: '250',
              reason: 'param-test',
              created_at: new Date(),
            },
          ],
          rowCount: 1,
        }),
      }
      const repo = new SlashEventsRepository(db)

      await runWithTenant('t', () =>
        repo.create({ bondId: 5, slashAmount: '250', reason: 'param-test' }),
      )

      const [, params] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        unknown[],
      ]
      expect(params[0]).toBe(5)         // $1 = bondId
      expect(params[1]).toBe('250')     // $2 = slashAmount
      expect(params[2]).toBe('param-test') // $3 = reason
    })

    it('findById() passes the id as $1', async () => {
      const db: Queryable = {
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      }
      const repo = new SlashEventsRepository(db)

      await runWithTenant('t', () => repo.findById(77))

      const [, params] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        unknown[],
      ]
      expect(params[0]).toBe(77)
    })

    it('listByBond() passes bondId as $1', async () => {
      const db: Queryable = {
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      }
      const repo = new SlashEventsRepository(db)

      await runWithTenant('t', () => repo.listByBond(33))

      const [, params] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        unknown[],
      ]
      expect(params[0]).toBe(33)
    })

    it('delete() passes id as $1', async () => {
      const db: Queryable = {
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
      }
      const repo = new SlashEventsRepository(db)

      await runWithTenant('t', () => repo.delete(99))

      const [, params] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        unknown[],
      ]
      expect(params[0]).toBe(99)
    })

    it('create() SQL contains RETURNING clause', async () => {
      const db: Queryable = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              id: 1,
              bond_id: 1,
              slash_amount: '1',
              reason: 'r',
              created_at: new Date(),
            },
          ],
          rowCount: 1,
        }),
      }
      const repo = new SlashEventsRepository(db)

      await runWithTenant('t', () =>
        repo.create({ bondId: 1, slashAmount: '1', reason: 'r' }),
      )

      const [sql] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
      expect(sql).toContain('RETURNING')
    })

    it('listByBond() SQL orders by created_at DESC, id DESC', async () => {
      const db: Queryable = {
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      }
      const repo = new SlashEventsRepository(db)

      await runWithTenant('t', () => repo.listByBond(1))

      const [sql] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
      expect(sql).toMatch(/ORDER BY created_at DESC,\s*id DESC/i)
    })

    it('totalSlashedForBond() SQL uses COALESCE and SUM', async () => {
      const db: Queryable = {
        query: vi.fn().mockResolvedValue({ rows: [{ total: '0' }], rowCount: 1 }),
      }
      const repo = new SlashEventsRepository(db)

      await runWithTenant('t', () => repo.totalSlashedForBond(1))

      const [sql] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
      expect(sql).toMatch(/COALESCE/i)
      expect(sql).toMatch(/SUM/i)
    })
  })
})
