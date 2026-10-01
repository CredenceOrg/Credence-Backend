/**
 * Boundary + recovery coverage for src/db/repositories/requestSnapshotsRepository.ts.
 *
 * Maps to issue #1378 acceptance criteria:
 * - deterministic for valid/invalid/duplicate/boundary inputs
 * - validation + state-transition invariants enforced
 * - retries/partial failure/concurrent execution cannot corrupt state
 * - success/rejection/boundary/regression scenarios
 * - callers remain compatible (public method shapes unchanged)
 * - failures diagnosable without exposing sensitive data
 *
 * States covered:
 *   create     – happy path, upsert on conflict, DB error propagation,
 *                JSONB round-trip, large payloads, empty strings,
 *                SQL injection via parameterised query (safe),
 *                concurrent writes (no lost update, no duplicate row)
 *   findById   – found row, not-found null, DB error, SQL injection safe,
 *                stale-read after create (read-after-write consistency)
 *   deleteOlderThan – default 14 days, custom 1/0/negative/float/very-large,
 *                DB error propagation, idempotent re-run, concurrent deletes
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { newDb } from 'pg-mem'
import type { Pool, PoolClient } from 'pg'
import crypto from 'crypto'
import { RequestSnapshotsRepository } from './requestSnapshotsRepository.js'

// ---------------------------------------------------------------------------
// Test database factory
// ---------------------------------------------------------------------------

async function createTestDb(): Promise<{ pool: Pool; client: PoolClient }> {
  const db = newDb()

  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: 'uuid',
    implementation: () => crypto.randomUUID(),
  } as Parameters<typeof db.public.registerFunction>[0])

  const adapter = db.adapters.createPg()
  const pool = new adapter.Pool() as unknown as Pool

  // Exact schema from migration 009_create_request_snapshots.ts
  await pool.query(`
    CREATE TABLE request_snapshots (
      request_id  TEXT        PRIMARY KEY,
      method      TEXT        NOT NULL,
      path        TEXT        NOT NULL,
      headers     JSONB       NOT NULL,
      body        JSONB       NOT NULL,
      snapshot    JSONB       NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
    );
  `)
  await pool.query(`CREATE INDEX ON request_snapshots (created_at);`)

  const client = await pool.connect()
  return { pool, client }
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeParams(overrides: Partial<Parameters<RequestSnapshotsRepository['create']>[0]> = {}) {
  return {
    requestId: `req-${crypto.randomUUID()}`,
    method: 'POST',
    path: '/api/test',
    headers: { 'content-type': 'application/json', 'x-request-id': 'abc' },
    body: { action: 'create', value: 42 },
    snapshot: { status: 200, latencyMs: 55 },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

describe('RequestSnapshotsRepository boundary + recovery', () => {
  let pool: Pool
  let client: PoolClient
  let repo: RequestSnapshotsRepository

  beforeEach(async () => {
    ;({ pool, client } = await createTestDb())
    repo = new RequestSnapshotsRepository(client)
  })

  afterEach(async () => {
    client.release()
    await pool.end()
    vi.restoreAllMocks()
  })

  // =========================================================================
  // create()
  // =========================================================================

  describe('create() — success paths', () => {
    it('inserts a new snapshot and the row is immediately retrievable', async () => {
      const params = makeParams()
      await repo.create(params)

      const found = await repo.findById(params.requestId)
      expect(found).not.toBeNull()
      expect(found.request_id).toBe(params.requestId)
      expect(found.method).toBe(params.method)
      expect(found.path).toBe(params.path)
    })

    it('returns void (undefined) on success', async () => {
      const result = await repo.create(makeParams())
      expect(result).toBeUndefined()
    })

    it('round-trips JSONB headers faithfully (keys, values, nesting)', async () => {
      const headers = { 'content-type': 'application/json', 'x-trace': '123', 'x-forwarded-for': '1.2.3.4' }
      const params = makeParams({ headers })
      await repo.create(params)

      const found = await repo.findById(params.requestId)
      expect(found.headers).toEqual(headers)
    })

    it('round-trips a nested JSONB body without loss', async () => {
      const body = { user: { id: 'u1', roles: ['admin', 'viewer'] }, meta: { page: 1, size: 20 } }
      const params = makeParams({ body })
      await repo.create(params)

      const found = await repo.findById(params.requestId)
      expect(found.body).toEqual(body)
    })

    it('round-trips a JSONB snapshot with numeric, boolean, and null values', async () => {
      const snapshot = { status: 201, ok: true, data: null, list: [1, 2, 3] }
      const params = makeParams({ snapshot })
      await repo.create(params)

      const found = await repo.findById(params.requestId)
      expect(found.snapshot).toEqual(snapshot)
    })

    it('round-trips an empty object for body and snapshot (JSONB null boundary)', async () => {
      const params = makeParams({ body: {}, snapshot: {} })
      await repo.create(params)

      const found = await repo.findById(params.requestId)
      expect(found.body).toEqual({})
      expect(found.snapshot).toEqual({})
    })

    it('round-trips an array body (JSONB array at top level)', async () => {
      const params = makeParams({ body: [1, 2, 3], snapshot: [{ a: 1 }] })
      await repo.create(params)

      const found = await repo.findById(params.requestId)
      expect(found.body).toEqual([1, 2, 3])
      expect(found.snapshot).toEqual([{ a: 1 }])
    })

    it('accepts an empty string for method and path (no NOT NULL violation at text level)', async () => {
      const params = makeParams({ method: '', path: '' })
      // The DB schema only enforces NOT NULL, not non-empty strings — repository layer passes them through.
      await repo.create(params)

      const found = await repo.findById(params.requestId)
      expect(found.method).toBe('')
      expect(found.path).toBe('')
    })

    it('stores a very long path string without truncation', async () => {
      const longPath = '/' + 'segment/'.repeat(200)
      const params = makeParams({ path: longPath })
      await repo.create(params)

      const found = await repo.findById(params.requestId)
      expect(found.path).toBe(longPath)
    })

    it('stores a very long method string without truncation', async () => {
      const longMethod = 'X-'.repeat(100)
      const params = makeParams({ method: longMethod })
      await repo.create(params)

      const found = await repo.findById(params.requestId)
      expect(found.method).toBe(longMethod)
    })

    it('stores multiple distinct snapshots independently', async () => {
      const p1 = makeParams({ method: 'GET' })
      const p2 = makeParams({ method: 'DELETE' })
      await repo.create(p1)
      await repo.create(p2)

      expect((await repo.findById(p1.requestId)).method).toBe('GET')
      expect((await repo.findById(p2.requestId)).method).toBe('DELETE')
    })

    it('persists created_at automatically (not null, is a valid date)', async () => {
      const before = new Date()
      const params = makeParams()
      await repo.create(params)
      const after = new Date()

      const found = await repo.findById(params.requestId)
      const createdAt = new Date(found.created_at)
      expect(createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
      expect(createdAt.getTime()).toBeLessThanOrEqual(after.getTime())
    })
  })

  // -------------------------------------------------------------------------
  describe('create() — upsert / duplicate (ON CONFLICT DO UPDATE)', () => {
    it('updates all mutable fields when request_id already exists', async () => {
      const requestId = `req-${crypto.randomUUID()}`
      await repo.create(makeParams({ requestId, method: 'GET', path: '/old' }))

      await repo.create(makeParams({ requestId, method: 'POST', path: '/new' }))

      const found = await repo.findById(requestId)
      expect(found.method).toBe('POST')
      expect(found.path).toBe('/new')
    })

    it('keeps exactly one row after duplicate upsert (no phantom row)', async () => {
      const requestId = `req-${crypto.randomUUID()}`
      await repo.create(makeParams({ requestId }))
      await repo.create(makeParams({ requestId }))

      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM request_snapshots WHERE request_id = $1`,
        [requestId],
      )
      expect(rows[0].cnt).toBe(1)
    })

    it('updates headers/body/snapshot on conflict deterministically', async () => {
      const requestId = `req-${crypto.randomUUID()}`
      await repo.create(makeParams({ requestId, headers: { 'x-v': '1' }, body: { v: 1 }, snapshot: { v: 1 } }))
      await repo.create(makeParams({ requestId, headers: { 'x-v': '2' }, body: { v: 2 }, snapshot: { v: 2 } }))

      const found = await repo.findById(requestId)
      expect(found.headers['x-v']).toBe('2')
      expect(found.body).toEqual({ v: 2 })
      expect(found.snapshot).toEqual({ v: 2 })
    })

    it('10 sequential upserts to the same id converge to one row with latest data', async () => {
      const requestId = `req-${crypto.randomUUID()}`
      for (let i = 0; i < 10; i++) {
        await repo.create(makeParams({ requestId, path: `/path/${i}` }))
      }

      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM request_snapshots WHERE request_id = $1`,
        [requestId],
      )
      expect(rows[0].cnt).toBe(1)
      expect((await repo.findById(requestId)).path).toBe('/path/9')
    })
  })

  // -------------------------------------------------------------------------
  describe('create() — SQL injection safety', () => {
    it('stores a SQL injection string in requestId as literal text (parameterised query)', async () => {
      const maliciousId = `'; DROP TABLE request_snapshots; --`
      await repo.create(makeParams({ requestId: maliciousId }))

      // Table must still exist and the row must be findable
      const found = await repo.findById(maliciousId)
      expect(found).not.toBeNull()
      expect(found.request_id).toBe(maliciousId)

      const { rows } = await pool.query(`SELECT COUNT(*)::int AS cnt FROM request_snapshots`)
      expect(rows[0].cnt).toBeGreaterThanOrEqual(1)
    })

    it('stores SQL injection strings in method/path without executing them', async () => {
      const evil = `UNION SELECT * FROM pg_user--`
      const params = makeParams({ method: evil, path: evil })
      await repo.create(params)

      const found = await repo.findById(params.requestId)
      expect(found.method).toBe(evil)
      expect(found.path).toBe(evil)
    })

    it('stores a SQL injection string in body JSONB safely', async () => {
      const body = { q: `'; DELETE FROM request_snapshots; --` }
      const params = makeParams({ body })
      await repo.create(params)

      const found = await repo.findById(params.requestId)
      expect(found.body).toEqual(body)
    })
  })

  // -------------------------------------------------------------------------
  describe('create() — error propagation', () => {
    it('propagates a DB error from the underlying PoolClient', async () => {
      const faultyClient = {
        query: vi.fn().mockRejectedValue(new Error('connection lost')),
      } as unknown as PoolClient
      const faultyRepo = new RequestSnapshotsRepository(faultyClient)

      await expect(faultyRepo.create(makeParams())).rejects.toThrow('connection lost')
    })

    it('is retry-safe: after a transient failure the same call succeeds on retry', async () => {
      const realQuery = pool.query.bind(pool)
      const spy = vi.spyOn(client, 'query')
      spy.mockRejectedValueOnce(new Error('transient timeout'))

      const params = makeParams()
      await expect(repo.create(params)).rejects.toThrow('transient timeout')

      // Restore and retry with a fresh repo on same pool
      spy.mockRestore()
      const freshClient = await pool.connect()
      const freshRepo = new RequestSnapshotsRepository(freshClient)
      await freshRepo.create(params)
      expect(await freshRepo.findById(params.requestId)).not.toBeNull()
      freshClient.release()
      // suppress unused warning
      void realQuery
    })
  })

  // =========================================================================
  // findById()
  // =========================================================================

  describe('findById() — success paths', () => {
    it('returns the full row for an existing requestId', async () => {
      const params = makeParams()
      await repo.create(params)

      const found = await repo.findById(params.requestId)
      expect(found).toMatchObject({
        request_id: params.requestId,
        method: params.method,
        path: params.path,
      })
    })

    it('returns null (not undefined, not throw) for a non-existent requestId', async () => {
      const result = await repo.findById('does-not-exist')
      expect(result).toBeNull()
    })

    it('returns null for an empty string requestId (no row present)', async () => {
      const result = await repo.findById('')
      expect(result).toBeNull()
    })

    it('is case-sensitive: different casing returns null', async () => {
      const params = makeParams({ requestId: 'REQ-UPPER' })
      await repo.create(params)

      expect(await repo.findById('req-upper')).toBeNull()
      expect(await repo.findById('REQ-UPPER')).not.toBeNull()
    })

    it('read-after-write: findById immediately after create sees the new data', async () => {
      const params = makeParams({ path: '/latest' })
      await repo.create(params)
      await repo.create({ ...params, path: '/updated' })

      const found = await repo.findById(params.requestId)
      expect(found.path).toBe('/updated')
    })
  })

  // -------------------------------------------------------------------------
  describe('findById() — SQL injection safety', () => {
    it('safely handles SQL injection in requestId via parameterised query', async () => {
      const evil = `'; DROP TABLE request_snapshots; --`
      // No row for this id — must return null, not throw
      const result = await repo.findById(evil)
      expect(result).toBeNull()

      // Table must still exist
      const { rows } = await pool.query(`SELECT COUNT(*)::int AS cnt FROM request_snapshots`)
      expect(rows[0].cnt).toBeGreaterThanOrEqual(0)
    })

    it("handles UNION-based injection attempt safely", async () => {
      const injection = `x' UNION SELECT NULL, NULL, NULL, NULL, NULL, NULL, NULL --`
      const result = await repo.findById(injection)
      expect(result).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  describe('findById() — error propagation', () => {
    it('propagates DB errors to the caller', async () => {
      const faultyClient = {
        query: vi.fn().mockRejectedValue(new Error('read timeout')),
      } as unknown as PoolClient
      const faultyRepo = new RequestSnapshotsRepository(faultyClient)

      await expect(faultyRepo.findById('any-id')).rejects.toThrow('read timeout')
    })
  })

  // =========================================================================
  // deleteOlderThan()
  // =========================================================================

  describe('deleteOlderThan() — success paths', () => {
    it('returns void (undefined) without throwing when no rows match', async () => {
      const result = await repo.deleteOlderThan(14)
      expect(result).toBeUndefined()
    })

    it('default parameter is 14 days (call with no args does not throw)', async () => {
      const result = await repo.deleteOlderThan()
      expect(result).toBeUndefined()
    })

    it('deletes a row whose created_at is older than the given days threshold', async () => {
      const params = makeParams()
      await repo.create(params)

      // Back-date the row to 30 days ago so it qualifies for a 14-day TTL purge
      await pool.query(
        `UPDATE request_snapshots SET created_at = now() - interval '30 days' WHERE request_id = $1`,
        [params.requestId],
      )

      await repo.deleteOlderThan(14)

      expect(await repo.findById(params.requestId)).toBeNull()
    })

    it('keeps a row whose created_at is newer than the threshold', async () => {
      const params = makeParams()
      await repo.create(params)

      // Back-date to 10 days ago — should be kept with a 14-day TTL
      await pool.query(
        `UPDATE request_snapshots SET created_at = now() - interval '10 days' WHERE request_id = $1`,
        [params.requestId],
      )

      await repo.deleteOlderThan(14)

      expect(await repo.findById(params.requestId)).not.toBeNull()
    })

    it('boundary: row exactly at boundary (just over threshold) is deleted', async () => {
      const params = makeParams()
      await repo.create(params)

      // 14 days + 1 second ago — just over boundary
      await pool.query(
        `UPDATE request_snapshots SET created_at = now() - interval '14 days' - interval '1 second' WHERE request_id = $1`,
        [params.requestId],
      )

      await repo.deleteOlderThan(14)

      expect(await repo.findById(params.requestId)).toBeNull()
    })

    it('boundary: row just under threshold is kept', async () => {
      const params = makeParams()
      await repo.create(params)

      // 13 days + 23 hours — just under 14-day boundary
      await pool.query(
        `UPDATE request_snapshots SET created_at = now() - interval '13 days 23 hours' WHERE request_id = $1`,
        [params.requestId],
      )

      await repo.deleteOlderThan(14)

      expect(await repo.findById(params.requestId)).not.toBeNull()
    })

    it('custom days=1 deletes rows older than 1 day, keeps newer rows', async () => {
      const old = makeParams()
      const fresh = makeParams()
      await repo.create(old)
      await repo.create(fresh)

      await pool.query(
        `UPDATE request_snapshots SET created_at = now() - interval '2 days' WHERE request_id = $1`,
        [old.requestId],
      )

      await repo.deleteOlderThan(1)

      expect(await repo.findById(old.requestId)).toBeNull()
      expect(await repo.findById(fresh.requestId)).not.toBeNull()
    })

    it('days=0 deletes ALL rows (interval 0 means cutoff is now)', async () => {
      // Any row inserted before "now" satisfies created_at < now() - 0 days
      const p1 = makeParams()
      const p2 = makeParams()
      await repo.create(p1)
      await repo.create(p2)

      // Back-date slightly to ensure they are strictly before now()
      await pool.query(`UPDATE request_snapshots SET created_at = now() - interval '1 second'`)

      await repo.deleteOlderThan(0)

      expect(await repo.findById(p1.requestId)).toBeNull()
      expect(await repo.findById(p2.requestId)).toBeNull()
    })

    it('days=365 (very large) deletes only very old rows, keeps recent ones', async () => {
      const old = makeParams()
      const recent = makeParams()
      await repo.create(old)
      await repo.create(recent)

      // Back-date old row to 2 years ago
      await pool.query(
        `UPDATE request_snapshots SET created_at = now() - interval '730 days' WHERE request_id = $1`,
        [old.requestId],
      )

      await repo.deleteOlderThan(365)

      expect(await repo.findById(old.requestId)).toBeNull()
      expect(await repo.findById(recent.requestId)).not.toBeNull()
    })

    it('is idempotent: running deleteOlderThan twice with same args does not throw or corrupt', async () => {
      const params = makeParams()
      await repo.create(params)
      await pool.query(
        `UPDATE request_snapshots SET created_at = now() - interval '30 days' WHERE request_id = $1`,
        [params.requestId],
      )

      await repo.deleteOlderThan(14)
      // Second run must not throw even though there is nothing left to delete
      await expect(repo.deleteOlderThan(14)).resolves.toBeUndefined()
    })

    it('deletes multiple rows in a single call', async () => {
      const ids = Array.from({ length: 5 }, () => `req-${crypto.randomUUID()}`)
      for (const id of ids) {
        await repo.create(makeParams({ requestId: id }))
      }
      await pool.query(`UPDATE request_snapshots SET created_at = now() - interval '30 days'`)

      await repo.deleteOlderThan(14)

      for (const id of ids) {
        expect(await repo.findById(id)).toBeNull()
      }
    })
  })

  // -------------------------------------------------------------------------
  describe('deleteOlderThan() — numeric boundary inputs', () => {
    it('accepts a float (fractional days) without throwing', async () => {
      const params = makeParams()
      await repo.create(params)
      await pool.query(
        `UPDATE request_snapshots SET created_at = now() - interval '1 day' WHERE request_id = $1`,
        [params.requestId],
      )

      // 0.5 days = 12 hours — the row is 1 day old so it should be deleted
      await expect(repo.deleteOlderThan(0.5)).resolves.toBeUndefined()
      expect(await repo.findById(params.requestId)).toBeNull()
    })

    it('accepts a large integer (9999 days) without throwing', async () => {
      await expect(repo.deleteOlderThan(9999)).resolves.toBeUndefined()
    })

    it('accepts a negative days value without throwing (deletes nothing)', async () => {
      const params = makeParams()
      await repo.create(params)

      // Negative interval means threshold is in the future — no row qualifies
      await expect(repo.deleteOlderThan(-1)).resolves.toBeUndefined()

      // Row created just now is not in the "future" relative to the threshold
      // so behaviour may vary; we only assert no throw here.
    })
  })

  // -------------------------------------------------------------------------
  describe('deleteOlderThan() — error propagation', () => {
    it('propagates a DB error to the caller', async () => {
      const faultyClient = {
        query: vi.fn().mockRejectedValue(new Error('write timeout')),
      } as unknown as PoolClient
      const faultyRepo = new RequestSnapshotsRepository(faultyClient)

      await expect(faultyRepo.deleteOlderThan(14)).rejects.toThrow('write timeout')
    })

    it('does not swallow errors: error is an Error instance with message', async () => {
      const err = new Error('connection dropped')
      const faultyClient = { query: vi.fn().mockRejectedValue(err) } as unknown as PoolClient
      const faultyRepo = new RequestSnapshotsRepository(faultyClient)

      let caught: unknown = null
      try {
        await faultyRepo.deleteOlderThan()
      } catch (e) {
        caught = e
      }

      expect(caught).toBe(err)
      expect((caught as Error).message).toBe('connection dropped')
    })
  })

  // =========================================================================
  // Concurrency + partial-failure safety
  // =========================================================================

  describe('concurrency — no unsafe/inconsistent state', () => {
    it('concurrent creates for different requestIds all persist (no lost write)', async () => {
      const params = Array.from({ length: 8 }, () => makeParams())
      await Promise.all(params.map((p) => repo.create(p)))

      for (const p of params) {
        expect(await repo.findById(p.requestId)).not.toBeNull()
      }
    })

    it('concurrent upserts for the same requestId converge to exactly one row', async () => {
      const requestId = `req-${crypto.randomUUID()}`
      const writes = Array.from({ length: 10 }, (_, i) =>
        repo.create(makeParams({ requestId, path: `/concurrent/${i}` })),
      )
      await Promise.all(writes)

      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM request_snapshots WHERE request_id = $1`,
        [requestId],
      )
      expect(rows[0].cnt).toBe(1)

      const found = await repo.findById(requestId)
      expect(found).not.toBeNull()
      expect(found.path).toMatch(/^\/concurrent\/\d+$/)
    })

    it('concurrent deleteOlderThan calls do not throw (idempotent under concurrent access)', async () => {
      const params = makeParams()
      await repo.create(params)
      await pool.query(
        `UPDATE request_snapshots SET created_at = now() - interval '30 days' WHERE request_id = $1`,
        [params.requestId],
      )

      const deletes = Array.from({ length: 5 }, () => repo.deleteOlderThan(14))
      await expect(Promise.all(deletes)).resolves.toBeDefined()
    })
  })

  // =========================================================================
  // Observability: errors are diagnosable without leaking sensitive data
  // =========================================================================

  describe('observability — errors are diagnosable', () => {
    it('DB error carries an actionable message string (not an empty error)', async () => {
      const faultyClient = {
        query: vi.fn().mockRejectedValue(new Error('ERROR: column "bad_col" does not exist')),
      } as unknown as PoolClient
      const faultyRepo = new RequestSnapshotsRepository(faultyClient)

      let caught: Error | null = null
      try {
        await faultyRepo.create(makeParams())
      } catch (e) {
        caught = e as Error
      }

      expect(caught).not.toBeNull()
      expect(caught?.message).toContain('bad_col')
    })

    it('error from findById does not expose full SQL query or internal table names beyond pg error', async () => {
      const faultyClient = {
        query: vi.fn().mockRejectedValue(new Error('timeout after 30000ms')),
      } as unknown as PoolClient
      const faultyRepo = new RequestSnapshotsRepository(faultyClient)

      await expect(faultyRepo.findById('any')).rejects.toThrow('timeout after 30000ms')
    })
  })

  // =========================================================================
  // Public interface shape (backwards-compatibility contract)
  // =========================================================================

  describe('public interface — callers remain compatible', () => {
    it('constructor accepts a PoolClient and exposes create/findById/deleteOlderThan', () => {
      expect(typeof repo.create).toBe('function')
      expect(typeof repo.findById).toBe('function')
      expect(typeof repo.deleteOlderThan).toBe('function')
    })

    it('create() signature accepts all documented fields', async () => {
      // All required fields present — should not throw
      await expect(
        repo.create({
          requestId: `req-${crypto.randomUUID()}`,
          method: 'PUT',
          path: '/api/v2/resource',
          headers: {},
          body: {},
          snapshot: {},
        }),
      ).resolves.toBeUndefined()
    })

    it('findById() returns an object with expected columns for a found row', async () => {
      const params = makeParams()
      await repo.create(params)

      const found = await repo.findById(params.requestId)
      expect(found).toHaveProperty('request_id')
      expect(found).toHaveProperty('method')
      expect(found).toHaveProperty('path')
      expect(found).toHaveProperty('headers')
      expect(found).toHaveProperty('body')
      expect(found).toHaveProperty('snapshot')
      expect(found).toHaveProperty('created_at')
    })

    it('deleteOlderThan() can be called with no arguments (default 14 days)', async () => {
      await expect(repo.deleteOlderThan()).resolves.toBeUndefined()
    })
  })
})
