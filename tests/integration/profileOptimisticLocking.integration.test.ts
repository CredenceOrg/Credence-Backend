/**
 * Integration tests for optimistic locking on identity profile updates.
 *
 * These tests use testcontainers to spin up a real postgres:16-alpine
 * container. If TEST_DATABASE_URL is set that connection is used instead
 * (CI mode). When Docker is unavailable and TEST_DATABASE_URL is unset the
 * suite falls back to pg-mem and is skipped — the schema uses
 * PostgreSQL-specific functions (gen_random_uuid, NOW()) not supported by
 * pg-mem.
 *
 * Scenarios covered:
 *  1. Sequential updates succeed and increment the version on each write.
 *  2. A stale-version update (lost update) is rejected with OptimisticLockError.
 *  3. Two concurrent writers: the second one always loses and gets the error.
 *  4. Caller can retry after re-fetching the current version.
 *  5. Updating a non-existent address throws a plain Error (not OptimisticLockError).
 *  6. The un-versioned `update()` helper bypasses the lock and always wins.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { createTestDatabase, type TestDatabase } from './testDatabase.js'
import { createSchema } from '../../src/db/schema.js'
import { IdentitiesRepository } from '../../src/db/repositories/identitiesRepository.js'
import { OptimisticLockError } from '../../src/lib/errors.js'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let testDb: TestDatabase
let pool: Pool

function isRealPostgres(db: TestDatabase): boolean {
  return !db.connectionString.startsWith('pg-mem://')
}

/** Builds a repository instance that skips the tenant-context assertion. */
function makeRepo(): IdentitiesRepository {
  return new IdentitiesRepository(pool, { skipTenantCheck: true })
}

beforeAll(async () => {
  testDb = await createTestDatabase()

  if (!isRealPostgres(testDb)) {
    return
  }

  pool = testDb.pool
  await createSchema(pool)
}, 60_000)

beforeEach(async () => {
  if (!isRealPostgres(testDb)) return
  // Wipe only the identities table (and anything that cascades from it).
  await pool.query(
    'TRUNCATE TABLE attestations, bonds, score_history RESTART IDENTITY CASCADE',
  )
  await pool.query('DELETE FROM identities')
})

afterAll(async () => {
  await testDb?.close()
})

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function seedIdentity(
  address: string,
  displayName: string | null = null,
): Promise<ReturnType<InstanceType<typeof IdentitiesRepository>['create']>> {
  const repo = makeRepo()
  return repo.create({ address, displayName })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('optimistic locking — profile updates', () => {
  it('new identity starts at version 1', async () => {
    if (!isRealPostgres(testDb)) return

    const identity = await seedIdentity('GADDR_VERSION_SEED')
    expect(identity.version).toBe(1)
  })

  it('sequential updates each increment the version', async () => {
    if (!isRealPostgres(testDb)) return

    const repo = makeRepo()
    const created = await seedIdentity('GADDR_SEQ', 'initial name')

    // First update: expect version 1 → 2
    const v2 = await repo.updateWithOptimisticLocking('GADDR_SEQ', {
      displayName: 'updated once',
      expectedVersion: 1,
    })
    expect(v2.version).toBe(2)
    expect(v2.displayName).toBe('updated once')

    // Second update: expect version 2 → 3
    const v3 = await repo.updateWithOptimisticLocking('GADDR_SEQ', {
      displayName: 'updated twice',
      expectedVersion: 2,
    })
    expect(v3.version).toBe(3)
    expect(v3.displayName).toBe('updated twice')

    // Confirm current state in DB
    const current = await repo.findByAddress('GADDR_SEQ')
    expect(current?.version).toBe(3)
    expect(current?.displayName).toBe('updated twice')

    // Baseline for void — suppress unused-var
    void created
  })

  it('stale version is rejected with OptimisticLockError', async () => {
    if (!isRealPostgres(testDb)) return

    const repo = makeRepo()
    await seedIdentity('GADDR_STALE', 'original')

    // Advance to version 2 by a successful write
    await repo.updateWithOptimisticLocking('GADDR_STALE', {
      displayName: 'first writer wins',
      expectedVersion: 1,
    })

    // A second writer that still holds version 1 must be rejected
    await expect(
      repo.updateWithOptimisticLocking('GADDR_STALE', {
        displayName: 'second writer lost',
        expectedVersion: 1,
      }),
    ).rejects.toThrow(OptimisticLockError)
  })

  it('OptimisticLockError carries the correct address and expectedVersion', async () => {
    if (!isRealPostgres(testDb)) return

    const repo = makeRepo()
    await seedIdentity('GADDR_ERRPROPS', 'test')

    // Advance the version so that expectedVersion=1 is stale
    await repo.updateWithOptimisticLocking('GADDR_ERRPROPS', {
      displayName: 'bump version',
      expectedVersion: 1,
    })

    let caught: OptimisticLockError | undefined
    try {
      await repo.updateWithOptimisticLocking('GADDR_ERRPROPS', {
        displayName: 'lost',
        expectedVersion: 1,
      })
    } catch (err) {
      caught = err as OptimisticLockError
    }

    expect(caught).toBeInstanceOf(OptimisticLockError)
    expect(caught?.resourceAddress).toBe('GADDR_ERRPROPS')
    expect(caught?.expectedVersion).toBe(1)
    expect(caught?.status).toBe(409)
    expect(caught?.code).toBe('optimistic_lock_conflict')
  })

  it('concurrent writers: first wins, second gets OptimisticLockError', async () => {
    if (!isRealPostgres(testDb)) return

    const repoA = makeRepo()
    const repoB = makeRepo()

    await seedIdentity('GADDR_CONCURRENT', 'shared profile')

    // Both clients read version=1 at the "same time" (both have expectedVersion=1)
    const writerA = repoA.updateWithOptimisticLocking('GADDR_CONCURRENT', {
      displayName: 'writer A wins',
      expectedVersion: 1,
    })

    const writerB = repoB.updateWithOptimisticLocking('GADDR_CONCURRENT', {
      displayName: 'writer B loses',
      expectedVersion: 1,
    })

    // Run both in parallel.  Postgres serialises the two UPDATE statements so
    // exactly one succeeds and the other sees zero affected rows.
    const results = await Promise.allSettled([writerA, writerB])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      OptimisticLockError,
    )

    // The winner bumped the version to 2
    const current = await makeRepo().findByAddress('GADDR_CONCURRENT')
    expect(current?.version).toBe(2)
  })

  it('caller can retry after re-fetching the current version', async () => {
    if (!isRealPostgres(testDb)) return

    const repo = makeRepo()
    await seedIdentity('GADDR_RETRY', 'before')

    // Simulate another writer advancing the version
    await repo.updateWithOptimisticLocking('GADDR_RETRY', {
      displayName: 'intermediate',
      expectedVersion: 1,
    })

    // Original caller tries with stale version
    let result
    try {
      result = await repo.updateWithOptimisticLocking('GADDR_RETRY', {
        displayName: 'final',
        expectedVersion: 1,
      })
    } catch (err) {
      expect(err).toBeInstanceOf(OptimisticLockError)

      // Re-fetch and retry with the current version
      const latest = await repo.findByAddress('GADDR_RETRY')
      expect(latest?.version).toBe(2)

      result = await repo.updateWithOptimisticLocking('GADDR_RETRY', {
        displayName: 'final (retry)',
        expectedVersion: latest!.version,
      })
    }

    expect(result?.displayName).toBe('final (retry)')
    expect(result?.version).toBe(3)
  })

  it('throws a plain Error (not OptimisticLockError) when address does not exist', async () => {
    if (!isRealPostgres(testDb)) return

    const repo = makeRepo()

    await expect(
      repo.updateWithOptimisticLocking('GADDR_NONEXISTENT', {
        displayName: 'ghost',
        expectedVersion: 1,
      }),
    ).rejects.toThrow('Identity not found: GADDR_NONEXISTENT')

    // Must NOT be an OptimisticLockError
    await expect(
      repo.updateWithOptimisticLocking('GADDR_NONEXISTENT', {
        displayName: 'ghost',
        expectedVersion: 1,
      }),
    ).rejects.not.toThrow(OptimisticLockError)
  })

  it('un-versioned update() always wins regardless of concurrent writes', async () => {
    if (!isRealPostgres(testDb)) return

    const repo = makeRepo()
    await seedIdentity('GADDR_UNVERSIONED', 'start')

    // Advance via optimistic-locking update
    await repo.updateWithOptimisticLocking('GADDR_UNVERSIONED', {
      displayName: 'locked update',
      expectedVersion: 1,
    })

    // Un-versioned update should not care about the version at all
    const result = await repo.update('GADDR_UNVERSIONED', {
      displayName: 'force overwrite',
    })

    expect(result?.displayName).toBe('force overwrite')
    // Version still increments because the SQL does `version = version + 1`
    expect(result?.version).toBe(3)
  })

  it('version is reflected in findByAddress after each write', async () => {
    if (!isRealPostgres(testDb)) return

    const repo = makeRepo()
    await seedIdentity('GADDR_FIND_VERSION', 'v1 name')

    const before = await repo.findByAddress('GADDR_FIND_VERSION')
    expect(before?.version).toBe(1)

    await repo.updateWithOptimisticLocking('GADDR_FIND_VERSION', {
      displayName: 'v2 name',
      expectedVersion: 1,
    })

    const after = await repo.findByAddress('GADDR_FIND_VERSION')
    expect(after?.version).toBe(2)
    expect(after?.displayName).toBe('v2 name')
  })
})
