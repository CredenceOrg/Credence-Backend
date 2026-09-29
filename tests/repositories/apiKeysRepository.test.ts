/**
 * Boundary and recovery tests for `ApiKeysRepository`.
 *
 * These tests run against a deterministic in-process `Queryable` instead of a
 * live database or `pg-mem`:
 *
 * - every statement is captured verbatim, so security-relevant guard clauses
 *   (the `active = true` / `cardinality(scopes) > 0` eligibility filter and the
 *   `owner_id` scoping on mutations) can be asserted directly;
 * - every failure mode can be injected on demand, which is what lets us pin the
 *   *recovery* behaviour: failures must be propagated, never converted into a
 *   "not found" / "no keys" result that a caller could mistake for valid data.
 *
 * Nothing here touches timers or shared state, so the suite is deterministic.
 *
 * Covered surface:
 *   createApiKey        – happy path, duplicate, empty RETURNING, transport error
 *   findByHashAndPrefix – hit / miss, eligibility filters, fail-closed lookup
 *   updateLastUsedAt    – owner scoping, failure propagation
 *   revokeApiKey        – hit / miss, owner isolation, compatibility, failure
 *   listByOwner         – empty result, ordering, hash redaction, failure
 *   deleteAll           – statement shape, failure propagation
 */

import { describe, it, expect } from 'vitest'
import { ApiKeysRepository } from '../../src/db/repositories/apiKeysRepository.js'
import type { Queryable } from '../../src/db/repositories/queryable.js'
import type { StoredApiKey } from '../../src/services/apiKeys.js'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type SqlRow = Record<string, unknown>

interface CapturedQuery {
  sql: string
  params: readonly unknown[]
}

type Responder = (sql: string, params: readonly unknown[]) => SqlRow[] | Promise<SqlRow[]>

/**
 * Build a fake `Queryable` that records every statement it receives and answers
 * from the supplied `responder`. `onQuery` swaps the responder mid-test so a
 * single case can exercise a sequence of outcomes.
 */
function createFakeDb(responder: Responder = () => []) {
  const calls: CapturedQuery[] = []
  let respond = responder

  const db = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      // Collapse formatting whitespace so assertions can match on substrings.
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params })
      const rows = await respond(calls[calls.length - 1]!.sql, params)
      return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] }
    },
  } as unknown as Queryable

  return {
    db,
    calls,
    onQuery(next: Responder): void {
      respond = next
    },
  }
}

function setup(responder?: Responder) {
  const fake = createFakeDb(responder)
  return { ...fake, repo: new ApiKeysRepository(fake.db) }
}

const HASHLESS_PREFIX = 'abcdefgh'
const HASHED_KEY = 'a'.repeat(64)
const CREATED_AT = new Date('2026-01-01T00:00:00.000Z')

/** A `RETURNING` row shaped exactly like the `api_keys` table. */
function apiKeyRow(overrides: SqlRow = {}): SqlRow {
  return {
    id: '42',
    hashed_key: HASHED_KEY,
    prefix: HASHLESS_PREFIX,
    scopes: ['read'],
    tier: 'free',
    owner_id: 'owner-1',
    created_at: CREATED_AT,
    last_used_at: null,
    active: true,
    ...overrides,
  }
}

/** Valid `createApiKey` input; the `id` is assigned by the database. */
function keyInput(overrides: Partial<Omit<StoredApiKey, 'id'>> = {}): Omit<StoredApiKey, 'id'> {
  return {
    hashedKey: HASHED_KEY,
    prefix: HASHLESS_PREFIX,
    scopes: ['read'],
    scope: 'read',
    tier: 'free',
    ownerId: 'owner-1',
    createdAt: CREATED_AT,
    lastUsedAt: null,
    active: true,
    ...overrides,
  }
}

/** Postgres unique-violation, as raised by the `api_keys.hashed_key` constraint. */
function duplicateKeyError(): Error & { code: string } {
  const err = new Error(
    'duplicate key value violates unique constraint "api_keys_hashed_key_key"',
  ) as Error & { code: string }
  err.code = '23505'
  return err
}

// ---------------------------------------------------------------------------
// createApiKey()
// ---------------------------------------------------------------------------

describe('ApiKeysRepository.createApiKey()', () => {
  it('inserts the key and maps the RETURNING row to a StoredApiKey', async () => {
    const { repo, calls } = setup(() => [apiKeyRow()])

    const created = await repo.createApiKey(keyInput())

    expect(created).toEqual({
      id: '42',
      hashedKey: HASHED_KEY,
      prefix: HASHLESS_PREFIX,
      scope: 'read',
      scopes: ['read'],
      tier: 'free',
      ownerId: 'owner-1',
      createdAt: CREATED_AT,
      lastUsedAt: null,
      active: true,
    })
    expect(calls).toHaveLength(1)
  })

  it('regression: emits a well-formed INSERT statement', async () => {
    // A previous revision shipped `IINSERT INTO api_keys …`, which Postgres
    // rejects at parse time — every key creation failed. Pin the statement so
    // the typo cannot come back unnoticed.
    const { repo, calls } = setup(() => [apiKeyRow()])

    await repo.createApiKey(keyInput())

    expect(calls[0]!.sql.startsWith('INSERT INTO api_keys')).toBe(true)
    expect(calls[0]!.sql).not.toMatch(/IINSERT/i)
    expect(calls[0]!.sql).toContain('RETURNING')
  })

  it('binds the parameters in column order', async () => {
    const { repo, calls } = setup(() => [apiKeyRow()])
    const input = keyInput({
      scopes: ['trust:read', 'bond:read'],
      tier: 'enterprise',
      ownerId: 'owner-9',
    })

    await repo.createApiKey(input)

    expect(calls[0]!.params).toEqual([
      input.hashedKey,
      input.prefix,
      input.scopes,
      input.tier,
      input.ownerId,
      input.createdAt,
      input.lastUsedAt,
      input.active,
    ])
  })

  it('boundary: stringifies an id delivered as a number', async () => {
    const { repo } = setup(() => [apiKeyRow({ id: Number.MAX_SAFE_INTEGER })])

    const created = await repo.createApiKey(keyInput())

    expect(created.id).toBe(String(Number.MAX_SAFE_INTEGER))
  })

  it('boundary: preserves a null lastUsedAt for a never-used key', async () => {
    const { repo } = setup(() => [apiKeyRow({ last_used_at: null })])

    const created = await repo.createApiKey(keyInput())

    expect(created.lastUsedAt).toBeNull()
  })

  it('boundary: derives the deprecated singular scope from the first granted scope', async () => {
    const { repo } = setup(() => [apiKeyRow({ scopes: ['payouts:write', 'trust:read'] })])

    const created = await repo.createApiKey(keyInput({ scopes: ['payouts:write', 'trust:read'] }))

    expect(created.scope).toBe('payouts:write')
    expect(created.scopes).toEqual(['payouts:write', 'trust:read'])
  })

  it('duplicate: propagates the unique violation instead of returning a partial record', async () => {
    const violation = duplicateKeyError()
    const { repo, calls } = setup(() => {
      throw violation
    })

    await expect(repo.createApiKey(keyInput())).rejects.toBe(violation)
    expect(calls).toHaveLength(1)
  })

  it('recovery: rejects when the database returns no RETURNING row', async () => {
    const { repo } = setup(() => [])

    await expect(repo.createApiKey(keyInput())).rejects.toThrow('api_keys insert returned no row')
  })

  it('recovery: surfaces a transport failure after a single attempt', async () => {
    const { repo, calls } = setup(() => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:5432')
    })

    await expect(repo.createApiKey(keyInput())).rejects.toThrow('ECONNREFUSED')
    expect(calls).toHaveLength(1)
  })

  it('concurrency: simultaneous creates of the same key persist exactly one row', async () => {
    // Enforce the unique constraint the way Postgres would: the second insert
    // of the same `hashed_key` is rejected rather than silently upserted.
    const persisted = new Map<string, SqlRow>()
    const { repo, calls } = setup((_sql, params) => {
      const hashedKey = params[0] as string
      if (persisted.has(hashedKey)) throw duplicateKeyError()
      const row = apiKeyRow({ id: String(persisted.size + 1), hashed_key: hashedKey })
      persisted.set(hashedKey, row)
      return [row]
    })

    const outcomes = await Promise.allSettled([
      repo.createApiKey(keyInput()),
      repo.createApiKey(keyInput()),
    ])

    expect(outcomes.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(persisted.size).toBe(1)
    expect(calls).toHaveLength(2)

    const rejected = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult
    expect((rejected.reason as { code?: string }).code).toBe('23505')
  })
})

// ---------------------------------------------------------------------------
// findByHashAndPrefix()
// ---------------------------------------------------------------------------

describe('ApiKeysRepository.findByHashAndPrefix()', () => {
  it('returns the mapped key when an active, scoped key matches', async () => {
    const { repo } = setup(() => [apiKeyRow({ scopes: ['attestations:write'] })])

    const found = await repo.findByHashAndPrefix(HASHED_KEY, HASHLESS_PREFIX)

    expect(found).not.toBeNull()
    expect(found!.id).toBe('42')
    expect(found!.hashedKey).toBe(HASHED_KEY)
    expect(found!.scopes).toEqual(['attestations:write'])
    expect(found!.scope).toBe('attestations:write')
  })

  it('boundary: returns null when no row matches', async () => {
    const { repo } = setup(() => [])

    await expect(repo.findByHashAndPrefix(HASHED_KEY, HASHLESS_PREFIX)).resolves.toBeNull()
  })

  it('invariant: only active keys carrying at least one scope are eligible', async () => {
    const { repo, calls } = setup(() => [])

    await repo.findByHashAndPrefix(HASHED_KEY, HASHLESS_PREFIX)

    expect(calls[0]!.sql).toContain('active = true')
    expect(calls[0]!.sql).toContain('cardinality(scopes) > 0')
  })

  it('binds hashedKey and prefix in the documented order', async () => {
    const { repo, calls } = setup(() => [])

    await repo.findByHashAndPrefix('hash-value', 'prefix-value')

    expect(calls[0]!.params).toEqual(['hash-value', 'prefix-value'])
  })

  it('boundary: maps a never-used key to a null lastUsedAt', async () => {
    const { repo } = setup(() => [apiKeyRow({ last_used_at: null })])

    const found = await repo.findByHashAndPrefix(HASHED_KEY, HASHLESS_PREFIX)

    expect(found!.lastUsedAt).toBeNull()
  })

  it('recovery: rejects (fails closed) when the lookup fails', async () => {
    // Must never resolve to a key on failure — an authentication lookup that
    // cannot reach the store has to fail, not silently succeed or return a
    // stale/permissive record.
    const { repo } = setup(() => {
      throw new Error('terminating connection due to administrator command')
    })

    await expect(repo.findByHashAndPrefix(HASHED_KEY, HASHLESS_PREFIX)).rejects.toThrow(
      'terminating connection',
    )
  })
})

// ---------------------------------------------------------------------------
// updateLastUsedAt()
// ---------------------------------------------------------------------------

describe('ApiKeysRepository.updateLastUsedAt()', () => {
  it('issues an owner-scoped UPDATE with both parameters', async () => {
    const { repo, calls } = setup(() => [])

    await repo.updateLastUsedAt('42', 'owner-1')

    expect(calls[0]!.sql).toContain('UPDATE api_keys SET last_used_at = current_timestamp')
    expect(calls[0]!.sql).toContain('WHERE id = $1 AND owner_id = $2')
    expect(calls[0]!.params).toEqual(['42', 'owner-1'])
  })

  it('recovery: propagates a failure so usage tracking cannot pass silently', async () => {
    const { repo } = setup(() => {
      throw new Error('deadlock detected')
    })

    await expect(repo.updateLastUsedAt('42', 'owner-1')).rejects.toThrow('deadlock detected')
  })
})

// ---------------------------------------------------------------------------
// revokeApiKey()
// ---------------------------------------------------------------------------

describe('ApiKeysRepository.revokeApiKey()', () => {
  it('returns true when the owner-scoped UPDATE deactivates a row', async () => {
    const { repo, calls } = setup(() => [{ id: '42' }])

    await expect(repo.revokeApiKey('42', 'owner-1')).resolves.toBe(true)

    expect(calls[0]!.sql).toBe(
      'UPDATE api_keys SET active = false WHERE id = $1 AND owner_id = $2 RETURNING id',
    )
    expect(calls[0]!.params).toEqual(['42', 'owner-1'])
  })

  it('boundary: returns false when nothing matched (unknown id or already gone)', async () => {
    const { repo } = setup(() => [])

    await expect(repo.revokeApiKey('ghost-id', 'owner-1')).resolves.toBe(false)
  })

  it('permission: refuses to revoke a key owned by somebody else', async () => {
    // Emulate the row-level owner filter: only `owner-1` owns key 42.
    const { repo, calls } = setup((_sql, params) =>
      params[0] === '42' && params[1] === 'owner-1' ? [{ id: '42' }] : [],
    )

    await expect(repo.revokeApiKey('42', 'attacker')).resolves.toBe(false)
    await expect(repo.revokeApiKey('42', 'owner-1')).resolves.toBe(true)
    expect(calls).toHaveLength(2)
  })

  it('compatibility: revokes by id alone when no owner is supplied', async () => {
    const { repo, calls } = setup(() => [{ id: '42' }])

    await expect(repo.revokeApiKey('42')).resolves.toBe(true)

    expect(calls[0]!.sql).toBe('UPDATE api_keys SET active = false WHERE id = $1 RETURNING id')
    expect(calls[0]!.params).toEqual(['42'])
  })

  it('boundary: repeating a revoke is idempotent and never throws', async () => {
    // The row survives with `active = false`, so the UPDATE keeps matching;
    // the second call must not error or resurrect the key.
    const { repo } = setup(() => [{ id: '42' }])

    await expect(repo.revokeApiKey('42', 'owner-1')).resolves.toBe(true)
    await expect(repo.revokeApiKey('42', 'owner-1')).resolves.toBe(true)
  })

  it('recovery: rejects instead of reporting a successful revocation', async () => {
    // A failure must never resolve to `true` (a phantom revocation) nor to
    // `false` (which reads as "not found"); it has to surface.
    const { repo } = setup(() => {
      throw new Error('deadlock detected')
    })

    await expect(repo.revokeApiKey('42', 'owner-1')).rejects.toThrow('deadlock detected')
  })
})

// ---------------------------------------------------------------------------
// listByOwner()
// ---------------------------------------------------------------------------

describe('ApiKeysRepository.listByOwner()', () => {
  it('boundary: returns an empty array for an owner with no keys', async () => {
    const { repo } = setup(() => [])

    await expect(repo.listByOwner('owner-1')).resolves.toEqual([])
  })

  it('maps rows and preserves the order returned by the query', async () => {
    const newest = apiKeyRow({
      id: '2',
      prefix: 'bbbbbbbb',
      created_at: new Date('2026-02-01T00:00:00.000Z'),
    })
    const oldest = apiKeyRow({ id: '1', prefix: 'aaaaaaaa', created_at: CREATED_AT })
    const { repo, calls } = setup(() => [newest, oldest])

    const keys = await repo.listByOwner('owner-1')

    expect(keys.map((k) => k.id)).toEqual(['2', '1'])
    expect(keys[0]).toEqual({
      id: '2',
      prefix: 'bbbbbbbb',
      scope: 'read',
      scopes: ['read'],
      tier: 'free',
      ownerId: 'owner-1',
      createdAt: new Date('2026-02-01T00:00:00.000Z'),
      lastUsedAt: null,
      active: true,
    })
    expect(calls[0]!.sql).toContain('ORDER BY created_at DESC')
    expect(calls[0]!.params).toEqual(['owner-1'])
  })

  it('security: never selects the key hash', async () => {
    const { repo, calls } = setup(() => [])

    await repo.listByOwner('owner-1')

    expect(calls[0]!.sql).not.toContain('hashed_key')
  })

  it('boundary: maps a never-used key to a null lastUsedAt', async () => {
    const { repo } = setup(() => [apiKeyRow({ last_used_at: null })])

    const keys = await repo.listByOwner('owner-1')

    expect(keys[0]!.lastUsedAt).toBeNull()
  })

  it('recovery: rejects rather than reporting an empty list', async () => {
    // Resolving to `[]` on failure would tell an operator their keys vanished
    // and invite duplicate key creation.
    const { repo } = setup(() => {
      throw new Error('connection terminated unexpectedly')
    })

    await expect(repo.listByOwner('owner-1')).rejects.toThrow('connection terminated unexpectedly')
  })
})

// ---------------------------------------------------------------------------
// deleteAll()
// ---------------------------------------------------------------------------

describe('ApiKeysRepository.deleteAll()', () => {
  it('issues a single DELETE against api_keys', async () => {
    const { repo, calls } = setup(() => [])

    await repo.deleteAll()

    expect(calls).toEqual([{ sql: 'DELETE FROM api_keys', params: [] }])
  })

  it('recovery: propagates a failure', async () => {
    const { repo } = setup(() => {
      throw new Error('permission denied for table api_keys')
    })

    await expect(repo.deleteAll()).rejects.toThrow('permission denied')
  })
})
