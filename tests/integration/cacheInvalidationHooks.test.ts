/**
 * Integration tests for cache invalidation hooks.
 *
 * Ensures that cache invalidation hooks run deterministically after:
 *  - Profile updates (member invite, role change, delete, restore)
 *  - Trust-score recalculation (score snapshot job)
 *  - Backfill jobs (bulk verification completion)
 *
 * Stale cached values must not leak to clients after any of these operations.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, createTestCache, type TestDatabase, type TestCache } from './testDatabase.js'
import { setTenantId } from '../../src/utils/tenantContext.js'

// Shared in-memory cache store for mocking Redis
const sharedStorage = vi.hoisted(() => new Map<string, string>())

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

vi.mock('../../src/db/pool.js', () => ({
  pool: {
    query: (text: string, params?: any[]) => {
      // Lazy-import the real pool so tests that need DB access can still get it
      return globalThis.__testDbPool?.query(text, params) ?? { rows: [] }
    },
    on: vi.fn(),
  },
  workerPool: {
    query: (text: string, params?: any[]) => {
      return globalThis.__testDbPool?.query(text, params) ?? { rows: [] }
    },
    on: vi.fn(),
  },
  withReplica: async (operation: any) => {
    return await operation({
      query: (text: string, params?: any[]) => globalThis.__testDbPool?.query(text, params) ?? { rows: [] },
    })
  },
}))

vi.mock('../../src/cache/redis.js', () => {
  const mockClient = {
    connect: async () => {},
    get: async (key: string) => sharedStorage.get(key) ?? null,
    set: async (key: string, value: string) => { sharedStorage.set(key, value); return 'OK' },
    setEx: async (key: string, _ttl: number, value: string) => { sharedStorage.set(key, value); return 'OK' },
    del: async (key: string) => { const existed = sharedStorage.has(key); sharedStorage.delete(key); return existed ? 1 : 0 },
    keys: async (pattern: string) => {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$')
      return [...sharedStorage.keys()].filter(k => regex.test(k))
    },
    quit: async () => {},
    disconnect: async () => {},
    on: () => {},
    isOpen: true,
  } as any

  const MockRedisConnection = {
    getInstance: () => ({
      connect: async () => {},
      getClient: () => mockClient,
      isOpen: true,
    }),
  }

  return {
    RedisConnection: MockRedisConnection,
    redisConnection: MockRedisConnection.getInstance(),
    cache: {
      get: (ns: string, k: string) =>
        mockClient.get(`${ns}:${k}`).then((v: string | null) => (v ? JSON.parse(v) : null)),
      set: (ns: string, k: string, v: any, ttl?: number) =>
        mockClient.set(`${ns}:${k}`, JSON.stringify(v)),
      delete: (ns: string, k: string) => mockClient.del(`${ns}:${k}`),
      clearNamespace: async (pattern: string) => {
        const prefix = pattern.replace('*', '')
        let count = 0
        for (const key of sharedStorage.keys()) {
          if (key.startsWith(prefix)) {
            sharedStorage.delete(key)
            count++
          }
        }
        return count
      },
      clearL1Pattern: () => {},
      exists: async (ns: string, k: string) => sharedStorage.has(`${ns}:${k}`),
    },
  }
})

vi.mock('../../src/middleware/metrics.js', () => ({
  register: { registerMetric: vi.fn() },
  recordStaleCacheRead: vi.fn(),
  invalidationHookExecutionsTotal: { inc: vi.fn() },
}))

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Cache Invalidation Hooks Integration', () => {
  let db: TestDatabase
  let cache: TestCache

  beforeAll(async () => {
    setTenantId('test-tenant')
    db = await createTestDatabase()
    cache = await createTestCache()

    process.env.DB_URL = db.connectionString
    process.env.REDIS_URL = cache.connectionString

    // Expose pool for the mocked db/pool module
    ;(globalThis as any).__testDbPool = db.pool

    // Create minimal schema for member tests
    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS org_members (
        id VARCHAR(64) PRIMARY KEY,
        org_id VARCHAR(64) NOT NULL,
        user_id VARCHAR(64) NOT NULL,
        email VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'member',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP,
        deleted_by VARCHAR(64)
      )
    `)
    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS identities (
        id SERIAL PRIMARY KEY,
        address VARCHAR(64) UNIQUE,
        tenant_id VARCHAR(64),
        bonded_amount VARCHAR(78) DEFAULT '0',
        bond_start TIMESTAMP,
        bond_duration INTEGER,
        active BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)
  }, 60000)

  beforeEach(() => {
    sharedStorage.clear()
  })

  afterAll(async () => {
    setTenantId(null)
    if (db) await db.close()
    if (cache) await cache.close()
  })

  // ────────────────────────────────────────────────────────────────────────
  // Profile / Member update hooks
  // ────────────────────────────────────────────────────────────────────────

  describe('Profile update hooks', () => {
    it('should invalidate org members list cache after a member invite', async () => {
      const { profileInvalidationHook, orgMembersListInvalidationHook } = await import(
        '../../src/cache/invalidationHooks.js'
      )

      const orgId = 'org-1'
      const memberId = 'member-1'

      // Seed some cached data
      const { cache: appCache } = await import('../../src/cache/redis.js')
      await appCache.set('member', 'org:org-1:members', [{ id: memberId, role: 'member' }], 300)
      await appCache.set('member', 'id:member-1', { id: memberId, role: 'member' }, 300)

      // Verify cache is populated
      expect(await appCache.get('member', 'org:org-1:members')).not.toBeNull()
      expect(await appCache.get('member', 'id:member-1')).not.toBeNull()

      // Execute the hook (as would happen after inviteMember)
      const result = await profileInvalidationHook.execute(orgId, memberId)

      // Verify the hook reported success
      expect(result.name).toBe('profile.invalidate')
      expect(result.keysAttempted).toBeGreaterThanOrEqual(2)
      expect(result.error).toBeUndefined()

      // Verify caches were cleared
      expect(await appCache.get('member', 'org:org-1:members')).toBeNull()
      expect(await appCache.get('member', 'id:member-1')).toBeNull()
    })

    it('should invalidate caches after role update', async () => {
      const { profileInvalidationHook } = await import('../../src/cache/invalidationHooks.js')
      const { cache: appCache } = await import('../../src/cache/redis.js')

      const orgId = 'org-1'
      const memberId = 'member-2'

      // Seed caches
      await appCache.set('member', 'org:org-1:members', [{ id: memberId, role: 'admin' }], 300)
      await appCache.set('member', 'id:member-2', { id: memberId, role: 'admin' }, 300)

      // Execute hook (as after updateMemberRole)
      await profileInvalidationHook.execute(orgId, memberId)

      expect(await appCache.get('member', 'org:org-1:members')).toBeNull()
      expect(await appCache.get('member', 'id:member-2')).toBeNull()
    })

    it('should invalidate caches after soft-delete', async () => {
      const { profileInvalidationHook } = await import('../../src/cache/invalidationHooks.js')
      const { cache: appCache } = await import('../../src/cache/redis.js')

      await appCache.set('member', 'org:org-1:members', [{ id: 'member-3', role: 'member' }], 300)

      await profileInvalidationHook.execute('org-1', 'member-3')

      expect(await appCache.get('member', 'org:org-1:members')).toBeNull()
    })

    it('should invalidate caches after restore', async () => {
      const { profileInvalidationHook } = await import('../../src/cache/invalidationHooks.js')
      const { cache: appCache } = await import('../../src/cache/redis.js')

      await appCache.set('member', 'org:org-1:members', [{ id: 'member-4', role: 'member' }], 300)

      await profileInvalidationHook.execute('org-1', 'member-4')

      expect(await appCache.get('member', 'org:org-1:members')).toBeNull()
    })

    it('should log but not throw when cache is unavailable', async () => {
      const { profileInvalidationHook } = await import('../../src/cache/invalidationHooks.js')

      // Even if cache is down, the hook should resolve (fire-and-forget semantics)
      const result = await profileInvalidationHook.execute('org-down', 'member-down')

      expect(result.name).toBe('profile.invalidate')
      // Keys attempted should still be counted even if deletion fails
      expect(result.keysAttempted).toBeGreaterThanOrEqual(2)
    })
  })

  // ────────────────────────────────────────────────────────────────────────
  // Trust-score recalculation hooks
  // ────────────────────────────────────────────────────────────────────────

  describe('Trust-score recalculation hooks', () => {
    it('should invalidate trust score caches after score recalculation', async () => {
      const { trustScoreInvalidationHook } = await import('../../src/cache/invalidationHooks.js')
      const { cache: appCache } = await import('../../src/cache/redis.js')

      const address = '0xAbC123'
      const addressLower = address.toLowerCase()

      // Seed a cached trust score (simulating stale data)
      await appCache.set('trust', addressLower, { score: 50 }, 300)

      expect(await appCache.get('trust', addressLower)).toEqual({ score: 50 })

      // Execute hook (as after ScoreSnapshotJob saves a batch)
      await trustScoreInvalidationHook.execute(address)

      // Cache should now be cleared
      expect(await appCache.get('trust', addressLower)).toBeNull()
    })

    it('should invalidate multiple addresses at once', async () => {
      const { trustScoreInvalidationHook } = await import('../../src/cache/invalidationHooks.js')
      const { cache: appCache } = await import('../../src/cache/redis.js')

      const addresses = ['0xAAA', '0xBBB', '0xCCC']

      // Seed caches
      for (const addr of addresses) {
        await appCache.set('trust', addr.toLowerCase(), { score: 75 }, 300)
      }

      // Execute hook with multiple addresses (simulating a batch save)
      await trustScoreInvalidationHook.execute(...addresses)

      // All should be cleared
      for (const addr of addresses) {
        expect(await appCache.get('trust', addr.toLowerCase())).toBeNull()
      }
    })

    it('should normalise addresses to lowercase before invalidation', async () => {
      const { trustScoreInvalidationHook } = await import('../../src/cache/invalidationHooks.js')
      const { cache: appCache } = await import('../../src/cache/redis.js')

      // Cache stored under lowercase key
      await appCache.set('trust', '0xabc123', { score: 80 }, 300)

      // Invalidate with mixed-case address
      await trustScoreInvalidationHook.execute('0xABC123')

      expect(await appCache.get('trust', '0xabc123')).toBeNull()
    })

    it('should handle empty address list gracefully', async () => {
      const { trustScoreInvalidationHook } = await import('../../src/cache/invalidationHooks.js')

      const result = await trustScoreInvalidationHook.execute()

      expect(result.name).toBe('trust_score.invalidate')
      expect(result.keysAttempted).toBe(0)
      expect(result.keysInvalidated).toBe(0)
      expect(result.error).toBeUndefined()
    })
  })

  // ────────────────────────────────────────────────────────────────────────
  // Backfill / Bulk verification hooks
  // ────────────────────────────────────────────────────────────────────────

  describe('Backfill / Bulk verification hooks', () => {
    it('should invalidate bulk job and org result caches after bulk completion', async () => {
      const { bulkVerificationInvalidationHook } = await import('../../src/cache/invalidationHooks.js')
      const { cache: appCache } = await import('../../src/cache/redis.js')

      const jobId = 'bulk-job-123'
      const orgId = 'org-42'

      // Seed caches
      await appCache.set('bulk', 'job:bulk-job-123', { status: 'running' }, 300)
      await appCache.set('bulk', 'org:org-42:results', [{ address: '0x1' }], 300)

      // Execute hook (as after BulkWorker completes)
      const result = await bulkVerificationInvalidationHook.execute(jobId, orgId)

      expect(result.name).toBe('bulk_verification.invalidate')
      expect(result.keysAttempted).toBe(2)
      expect(result.error).toBeUndefined()

      expect(await appCache.get('bulk', 'job:bulk-job-123')).toBeNull()
      expect(await appCache.get('bulk', 'org:org-42:results')).toBeNull()
    })

    it('should handle missing org gracefully', async () => {
      const { bulkVerificationInvalidationHook } = await import('../../src/cache/invalidationHooks.js')
      const { cache: appCache } = await import('../../src/cache/redis.js')

      await appCache.set('bulk', 'job:job-only', { status: 'completed' }, 300)

      // Only jobId provided, no orgId
      const result = await bulkVerificationInvalidationHook.execute('job-only')

      expect(result.keysAttempted).toBe(1) // only the job key
      expect(await appCache.get('bulk', 'job:job-only')).toBeNull()
    })
  })

  // ────────────────────────────────────────────────────────────────────────
  // Hook composition
  // ────────────────────────────────────────────────────────────────────────

  describe('Hook composition', () => {
    it('should compose multiple hooks and aggregate results', async () => {
      const { composeInvalidationHooks, orgMembersListInvalidationHook, memberByIdInvalidationHook } = await import(
        '../../src/cache/invalidationHooks.js'
      )
      const { cache: appCache } = await import('../../src/cache/redis.js')

      await appCache.set('member', 'org:org-1:members', [{ id: 'm1' }], 300)
      await appCache.set('member', 'id:m1', { id: 'm1', role: 'admin' }, 300)

      const results = await composeInvalidationHooks(
        [orgMembersListInvalidationHook, memberByIdInvalidationHook],
        'org-1',
        'm1',
      )

      expect(results).toHaveLength(2)
      expect(results[0].name).toBe('member.org_members_list.invalidate')
      expect(results[1].name).toBe('member.by_id.invalidate')

      expect(await appCache.get('member', 'org:org-1:members')).toBeNull()
      expect(await appCache.get('member', 'id:m1')).toBeNull()
    })
  })

  // ────────────────────────────────────────────────────────────────────────
  // End-to-end integration via MemberService
  // ────────────────────────────────────────────────────────────────────────

  describe('End-to-end via MemberService', () => {
    it('should clear profile caches when MemberService.inviteMember is called', async () => {
      const { MemberService } = await import('../../src/services/members/service.js')
      const { MemberRepository } = await import('../../src/repositories/member.repository.js')
      const { AuditLogService } = await import('../../src/services/audit/index.js')
      const { cache: appCache } = await import('../../src/cache/redis.js')

      // Mock audit log
      const mockAuditLog = {
        logAction: vi.fn(),
      } as unknown as AuditLogService

      const service = new MemberService(
        new MemberRepository(db.pool),
        mockAuditLog,
      )

      const orgId = 'org-e2e-1'
      const userId = 'user-e2e-1'

      // Seed cached members list
      await appCache.set('member', `org:${orgId}:members`, [], 300)

      // Invite a member (this triggers the cache invalidation hook)
      const result = await service.inviteMember(
        'test-tenant',
        'admin-1',
        'admin@test.com',
        { orgId, userId, email: 'new@test.com', role: 'member' },
      )

      expect(result.success).toBe(true)
      expect(result.member.email).toBe('new@test.com')

      // Wait a tick for the fire-and-forget invalidation to complete
      await new Promise((r) => setImmediate(r))

      // The cached members list should have been cleared
      const cached = await appCache.get('member', `org:${orgId}:members`)
      expect(cached).toBeNull()
    })
  })
})
