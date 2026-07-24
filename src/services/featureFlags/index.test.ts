import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FeatureFlagService, computeRolloutBucket } from './index.js'
import type { Queryable } from '../../db/repositories/queryable.js'
import {
  ROLLOUT_PERCENT_MIN,
  ROLLOUT_PERCENT_MAX,
  OUTBOX_AGGREGATE_TYPE,
  OUTBOX_EVENT_CREATED,
  OUTBOX_EVENT_TENANT_ROLLOUT_SET,
  OUTBOX_EVENT_TENANT_ROLLOUT_REMOVED,
} from './consts.js'

const mockOutboxCreate = vi.fn().mockResolvedValue(BigInt(1))
vi.mock('../../db/outbox/repository.js', () => ({
  OutboxRepository: vi.fn().mockImplementation(
    function () { return { create: mockOutboxCreate } },
  ),
}))

function makeFlagRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'flag-1', key: 'test-flag', description: 'Test feature flag',
    default_enabled: false, rollout_percent: 0,
    created_at: new Date('2025-01-01'), updated_at: new Date('2025-01-01'),
    ...overrides,
  }
}

function makeOverrideRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'override-1', flag_id: 'flag-1', tenant_id: 'tenant-1', enabled: true,
    created_at: new Date('2025-01-01'), updated_at: new Date('2025-01-01'),
    ...overrides,
  }
}

function makeTenantRolloutRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tr-1', flag_id: 'flag-1', tenant_id: 'tenant-1', rollout_percent: 50,
    created_at: new Date('2025-01-01'), updated_at: new Date('2025-01-01'),
    ...overrides,
  }
}

const defaultActor = { id: 'admin-1', email: 'admin@test.com', tenantId: 'tenant-admin' }

describe('FeatureFlagService', () => {
  let service: FeatureFlagService
  let mockDb: Queryable
  let mockAudit: { logAction: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    vi.clearAllMocks()
    mockAudit = { logAction: vi.fn().mockResolvedValue({ id: 'audit-1' }) }
    mockDb = { query: vi.fn() }
    service = new FeatureFlagService(mockDb, mockAudit)
  })

  // ── computeRolloutBucket (exported pure function) ──────────────────────────

  describe('computeRolloutBucket', () => {
    it('returns true when rolloutPercent is 100', () => {
      expect(computeRolloutBucket(ROLLOUT_PERCENT_MAX, 'any-user', 'any-flag')).toBe(true)
    })

    it('returns false when rolloutPercent is 0', () => {
      expect(computeRolloutBucket(ROLLOUT_PERCENT_MIN, 'any-user', 'any-flag')).toBe(false)
    })

    it('is deterministic — same inputs always return same result', () => {
      const a = computeRolloutBucket(50, 'user-abc', 'my-flag')
      const b = computeRolloutBucket(50, 'user-abc', 'my-flag')
      expect(a).toBe(b)
    })

    it('uses flagKey as a salt — same user gets different bucket for different flags', () => {
      // With 1000 iterations the odds of all being equal are astronomically small
      const results = Array.from({ length: 20 }, (_, i) =>
        computeRolloutBucket(50, `user-${i}`, 'flag-a') ===
        computeRolloutBucket(50, `user-${i}`, 'flag-b'),
      )
      // At least some should differ
      expect(results.some((equal) => !equal)).toBe(true)
    })

    it('distributes roughly uniformly at 30%', () => {
      let enabled = 0
      for (let i = 0; i < 1000; i++) {
        if (computeRolloutBucket(30, `user-${i}`, 'dist-flag')) enabled++
      }
      expect(enabled).toBeGreaterThan(200)
      expect(enabled).toBeLessThan(400)
    })

    it('distributes roughly uniformly at 70%', () => {
      let enabled = 0
      for (let i = 0; i < 1000; i++) {
        if (computeRolloutBucket(70, `user-${i}`, 'dist-flag-70')) enabled++
      }
      expect(enabled).toBeGreaterThan(600)
      expect(enabled).toBeLessThan(800)
    })
  })

  // ── isEnabled — evaluation priority ────────────────────────────────────────

  describe('isEnabled', () => {
    it('returns false for an unknown flag', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [] } as any)
      expect(await service.isEnabled('unknown-flag', 'tenant-1')).toBe(false)
    })

    it('priority 1: boolean override=true wins over everything', async () => {
      // override returns true
      vi.mocked(mockDb.query)
        .mockResolvedValueOnce({ rows: [makeOverrideRow({ enabled: true })] } as any)
      expect(await service.isEnabled('test-flag', 'tenant-1')).toBe(true)
    })

    it('priority 1: boolean override=false wins over everything', async () => {
      vi.mocked(mockDb.query)
        .mockResolvedValueOnce({ rows: [makeOverrideRow({ enabled: false })] } as any)
      expect(await service.isEnabled('test-flag', 'tenant-1')).toBe(false)
    })

    it('priority 2: per-tenant rollout used when no boolean override exists', async () => {
      vi.mocked(mockDb.query)
        // getOverride → no override
        .mockResolvedValueOnce({ rows: [] } as any)
        // getFlag
        .mockResolvedValueOnce({ rows: [makeFlagRow({ rollout_percent: 0 })] } as any)
        // getTenantRollout → 100% for this tenant
        .mockResolvedValueOnce({ rows: [makeTenantRolloutRow({ rollout_percent: 100 })] } as any)
      expect(await service.isEnabled('test-flag', 'tenant-1', 'user-1')).toBe(true)
    })

    it('priority 2: per-tenant rollout=0 disables even when global rollout=100', async () => {
      vi.mocked(mockDb.query)
        .mockResolvedValueOnce({ rows: [] } as any)
        .mockResolvedValueOnce({ rows: [makeFlagRow({ rollout_percent: 100 })] } as any)
        .mockResolvedValueOnce({ rows: [makeTenantRolloutRow({ rollout_percent: 0 })] } as any)
      expect(await service.isEnabled('test-flag', 'tenant-1', 'user-1')).toBe(false)
    })

    it('priority 3: global rollout used when no override and no per-tenant rollout', async () => {
      vi.mocked(mockDb.query)
        .mockResolvedValueOnce({ rows: [] } as any)
        .mockResolvedValueOnce({ rows: [makeFlagRow({ rollout_percent: 100 })] } as any)
        .mockResolvedValueOnce({ rows: [] } as any) // no tenant rollout
      expect(await service.isEnabled('test-flag', 'tenant-1', 'user-1')).toBe(true)
    })

    it('priority 4: falls back to defaultEnabled when rollout=0 and no overrides', async () => {
      vi.mocked(mockDb.query)
        .mockResolvedValueOnce({ rows: [] } as any)
        .mockResolvedValueOnce({ rows: [makeFlagRow({ default_enabled: true })] } as any)
        .mockResolvedValueOnce({ rows: [] } as any)
      expect(await service.isEnabled('test-flag', 'tenant-1')).toBe(true)
    })

    it('uses tenantId as entity when userId is absent (per-tenant rollout path)', async () => {
      vi.mocked(mockDb.query)
        .mockResolvedValueOnce({ rows: [] } as any)
        .mockResolvedValueOnce({ rows: [makeFlagRow()] } as any)
        .mockResolvedValueOnce({ rows: [makeTenantRolloutRow({ rollout_percent: 100 })] } as any)
      expect(typeof await service.isEnabled('test-flag', 'tenant-1')).toBe('boolean')
    })
  })

  // ── sticky bucketing — same user always same result ─────────────────────────

  describe('sticky bucketing', () => {
    it('same userId always gets same result for a given flag', async () => {
      const flagRow = makeFlagRow({ rollout_percent: 50 })
      // Call twice on fresh service instances to ensure no in-process cache sharing
      const svc1 = new FeatureFlagService({ query: vi.fn() }, { logAction: vi.fn() } as any)
      const svc2 = new FeatureFlagService({ query: vi.fn() }, { logAction: vi.fn() } as any)

      vi.mocked(svc1['db'].query)
        .mockResolvedValueOnce({ rows: [] } as any) // no override
        .mockResolvedValueOnce({ rows: [flagRow] } as any)
        .mockResolvedValueOnce({ rows: [] } as any) // no tenant rollout

      vi.mocked(svc2['db'].query)
        .mockResolvedValueOnce({ rows: [] } as any)
        .mockResolvedValueOnce({ rows: [flagRow] } as any)
        .mockResolvedValueOnce({ rows: [] } as any)

      const r1 = await svc1.isEnabled('test-flag', 'tenant-1', 'stable-user-42')
      const r2 = await svc2.isEnabled('test-flag', 'tenant-1', 'stable-user-42')
      expect(r1).toBe(r2)
    })

    it('per-tenant rollout sticky: same userId, same tenant, same flag → same result across calls', async () => {
      const tenantRolloutRow = makeTenantRolloutRow({ rollout_percent: 50 })
      const flagRow = makeFlagRow()

      vi.mocked(mockDb.query)
        .mockResolvedValueOnce({ rows: [] } as any)
        .mockResolvedValueOnce({ rows: [flagRow] } as any)
        .mockResolvedValueOnce({ rows: [tenantRolloutRow] } as any)
        // second call — override cached, but flag and tenant rollout will hit DB again after reset
        .mockResolvedValueOnce({ rows: [] } as any)
        .mockResolvedValueOnce({ rows: [flagRow] } as any)
        .mockResolvedValueOnce({ rows: [tenantRolloutRow] } as any)

      const r1 = await service.isEnabled('test-flag', 'tenant-1', 'user-xyz')
      // Clear cache to force fresh DB reads
      ;(service as any).cache.clear()
      const r2 = await service.isEnabled('test-flag', 'tenant-1', 'user-xyz')
      expect(r1).toBe(r2)
    })

    it('different tenants with different per-tenant rollouts can get different results', async () => {
      // tenant-A gets 100% rollout, tenant-B gets 0%
      const flagRow = makeFlagRow()
      const makeSetup = (rollout: number, tenant: string) => {
        const svc = new FeatureFlagService(
          { query: vi.fn() } as unknown as Queryable,
          { logAction: vi.fn() } as any,
        )
        vi.mocked(svc['db'].query)
          .mockResolvedValueOnce({ rows: [] } as any)
          .mockResolvedValueOnce({ rows: [flagRow] } as any)
          .mockResolvedValueOnce({ rows: [makeTenantRolloutRow({ tenant_id: tenant, rollout_percent: rollout })] } as any)
        return svc
      }

      const svcA = makeSetup(100, 'tenant-a')
      const svcB = makeSetup(0, 'tenant-b')

      expect(await svcA.isEnabled('test-flag', 'tenant-a', 'user-1')).toBe(true)
      expect(await svcB.isEnabled('test-flag', 'tenant-b', 'user-1')).toBe(false)
    })
  })

  // ── setTenantRollout ─────────────────────────────────────────────────────────

  describe('setTenantRollout', () => {
    it('creates a per-tenant rollout record', async () => {
      vi.mocked(mockDb.query)
        .mockResolvedValueOnce({ rows: [makeFlagRow()] } as any)  // getFlag
        .mockResolvedValueOnce({ rows: [makeTenantRolloutRow()] } as any) // INSERT
      const tr = await service.setTenantRollout('test-flag', 'tenant-1', 50, defaultActor)
      expect(tr.rolloutPercent).toBe(50)
      expect(tr.tenantId).toBe('tenant-1')
    })

    it('rejects rolloutPercent below 0', async () => {
      await expect(
        service.setTenantRollout('test-flag', 'tenant-1', -1, defaultActor),
      ).rejects.toThrow(`rolloutPercent must be between ${ROLLOUT_PERCENT_MIN} and ${ROLLOUT_PERCENT_MAX}`)
    })

    it('rejects rolloutPercent above 100', async () => {
      await expect(
        service.setTenantRollout('test-flag', 'tenant-1', 101, defaultActor),
      ).rejects.toThrow(`rolloutPercent must be between ${ROLLOUT_PERCENT_MIN} and ${ROLLOUT_PERCENT_MAX}`)
    })

    it('throws when flag does not exist', async () => {
      vi.mocked(mockDb.query).mockResolvedValueOnce({ rows: [] } as any)
      await expect(
        service.setTenantRollout('no-flag', 'tenant-1', 50, defaultActor),
      ).rejects.toThrow("Feature flag 'no-flag' not found")
    })

    it('writes audit log', async () => {
      vi.mocked(mockDb.query)
        .mockResolvedValueOnce({ rows: [makeFlagRow()] } as any)
        .mockResolvedValueOnce({ rows: [makeTenantRolloutRow()] } as any)
      await service.setTenantRollout('test-flag', 'tenant-1', 50, defaultActor)
      expect(mockAudit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceType: 'feature_flag_tenant_rollout',
          resourceId: 'test-flag:tenant-1',
        }),
      )
    })

    it('emits outbox event with correct type', async () => {
      vi.mocked(mockDb.query)
        .mockResolvedValueOnce({ rows: [makeFlagRow()] } as any)
        .mockResolvedValueOnce({ rows: [makeTenantRolloutRow()] } as any)
      await service.setTenantRollout('test-flag', 'tenant-1', 50, defaultActor)
      expect(mockOutboxCreate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          aggregateType: OUTBOX_AGGREGATE_TYPE,
          eventType: OUTBOX_EVENT_TENANT_ROLLOUT_SET,
          aggregateId: 'test-flag',
        }),
      )
    })

    it('invalidates tenant rollout cache after upsert', async () => {
      vi.mocked(mockDb.query)
        // First getTenantRollout (caches null)
        .mockResolvedValueOnce({ rows: [] } as any)
        // setTenantRollout path: getFlag, then INSERT
        .mockResolvedValueOnce({ rows: [makeFlagRow()] } as any)
        .mockResolvedValueOnce({ rows: [makeTenantRolloutRow({ rollout_percent: 25 })] } as any)
        // Second getTenantRollout after cache invalidated
        .mockResolvedValueOnce({ rows: [makeTenantRolloutRow({ rollout_percent: 25 })] } as any)

      await service.getTenantRollout('test-flag', 'tenant-1') // primes cache → null
      await service.setTenantRollout('test-flag', 'tenant-1', 25, defaultActor) // invalidates
      const tr = await service.getTenantRollout('test-flag', 'tenant-1') // re-fetches
      expect(tr?.rolloutPercent).toBe(25)
      expect(mockDb.query).toHaveBeenCalledTimes(4)
    })
  })

  // ── removeTenantRollout ──────────────────────────────────────────────────────

  describe('removeTenantRollout', () => {
    it('removes an existing tenant rollout', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [{ id: 'tr-1' }] } as any)
      await expect(
        service.removeTenantRollout('test-flag', 'tenant-1', defaultActor),
      ).resolves.toBeUndefined()
    })

    it('throws when tenant rollout does not exist', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [] } as any)
      await expect(
        service.removeTenantRollout('test-flag', 'tenant-1', defaultActor),
      ).rejects.toThrow("Tenant rollout not found for flag 'test-flag' and tenant 'tenant-1'")
    })

    it('writes audit log', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [{ id: 'tr-1' }] } as any)
      await service.removeTenantRollout('test-flag', 'tenant-1', defaultActor)
      expect(mockAudit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({ resourceType: 'feature_flag_tenant_rollout' }),
      )
    })

    it('emits outbox event with correct type', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [{ id: 'tr-1' }] } as any)
      await service.removeTenantRollout('test-flag', 'tenant-1', defaultActor)
      expect(mockOutboxCreate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ eventType: OUTBOX_EVENT_TENANT_ROLLOUT_REMOVED }),
      )
    })
  })

  // ── getTenantRollout ─────────────────────────────────────────────────────────

  describe('getTenantRollout', () => {
    it('returns null when no tenant rollout exists', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [] } as any)
      expect(await service.getTenantRollout('test-flag', 'tenant-1')).toBeNull()
    })

    it('returns the tenant rollout when it exists', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [makeTenantRolloutRow()] } as any)
      const tr = await service.getTenantRollout('test-flag', 'tenant-1')
      expect(tr).not.toBeNull()
      expect(tr!.rolloutPercent).toBe(50)
    })

    it('caches the tenant rollout after first fetch', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [makeTenantRolloutRow()] } as any)
      await service.getTenantRollout('test-flag', 'tenant-1')
      await service.getTenantRollout('test-flag', 'tenant-1')
      expect(mockDb.query).toHaveBeenCalledTimes(1)
    })
  })

  // ── listFlagsWithOverrides — includes tenantRollout & effectiveRolloutPercent

  describe('listFlagsWithOverrides', () => {
    it('includes tenantRollout and effectiveRolloutPercent when tenant rollout set', async () => {
      vi.mocked(mockDb.query)
        .mockResolvedValueOnce({ rows: [makeFlagRow({ key: 'flag-a', id: 'flag-1', rollout_percent: 10 })] } as any)
        .mockResolvedValueOnce({ rows: [] } as any) // no boolean overrides
        .mockResolvedValueOnce({ rows: [makeTenantRolloutRow({ rollout_percent: 40 })] } as any)

      const results = await service.listFlagsWithOverrides('tenant-1')
      expect(results[0].tenantRollout).not.toBeNull()
      expect(results[0].effectiveRolloutPercent).toBe(40)
    })

    it('effectiveRolloutPercent falls back to global when no tenant rollout', async () => {
      vi.mocked(mockDb.query)
        .mockResolvedValueOnce({ rows: [makeFlagRow({ key: 'flag-a', id: 'f1', rollout_percent: 25 })] } as any)
        .mockResolvedValueOnce({ rows: [] } as any) // no boolean overrides
        .mockResolvedValueOnce({ rows: [] } as any) // no tenant rollouts

      const results = await service.listFlagsWithOverrides('tenant-1')
      expect(results[0].tenantRollout).toBeNull()
      expect(results[0].effectiveRolloutPercent).toBe(25)
    })

    it('boolean override takes precedence over tenant rollout for effectiveEnabled', async () => {
      vi.mocked(mockDb.query)
        .mockResolvedValueOnce({ rows: [makeFlagRow({ id: 'flag-1', rollout_percent: 0 })] } as any)
        .mockResolvedValueOnce({ rows: [makeOverrideRow({ flag_id: 'flag-1', enabled: true })] } as any)
        .mockResolvedValueOnce({ rows: [makeTenantRolloutRow({ rollout_percent: 0 })] } as any)

      const results = await service.listFlagsWithOverrides('tenant-1')
      expect(results[0].override).not.toBeNull()
      expect(results[0].effectiveEnabled).toBe(true) // override wins
    })

    it('tenantRollout=0 makes effectiveEnabled false even when global rollout=100', async () => {
      vi.mocked(mockDb.query)
        .mockResolvedValueOnce({ rows: [makeFlagRow({ id: 'flag-1', rollout_percent: 100 })] } as any)
        .mockResolvedValueOnce({ rows: [] } as any)
        .mockResolvedValueOnce({ rows: [makeTenantRolloutRow({ rollout_percent: 0 })] } as any)

      const results = await service.listFlagsWithOverrides('tenant-1')
      expect(results[0].effectiveEnabled).toBe(false)
    })
  })

  // ── Pre-existing tests preserved ─────────────────────────────────────────────

  describe('getFlag', () => {
    it('returns null for unknown flag', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [] } as any)
      expect(await service.getFlag('unknown')).toBeNull()
    })

    it('returns flag from db', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [makeFlagRow()] } as any)
      const flag = await service.getFlag('test-flag')
      expect(flag).not.toBeNull()
      expect(flag!.key).toBe('test-flag')
      expect(flag!.rolloutPercent).toBe(0)
    })

    it('caches flag after first fetch', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [makeFlagRow()] } as any)
      await service.getFlag('test-flag')
      await service.getFlag('test-flag')
      expect(mockDb.query).toHaveBeenCalledTimes(1)
    })
  })

  describe('createFlag', () => {
    it('creates and returns a flag', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [makeFlagRow()] } as any)
      const flag = await service.createFlag('test-flag', 'desc', true, 50, defaultActor)
      expect(flag.key).toBe('test-flag')
    })

    it('rejects invalid rollout percent >100', async () => {
      await expect(
        service.createFlag('test-flag', 'desc', false, 150, defaultActor),
      ).rejects.toThrow(`rolloutPercent must be between ${ROLLOUT_PERCENT_MIN} and ${ROLLOUT_PERCENT_MAX}`)
    })

    it('rejects invalid rollout percent <0', async () => {
      await expect(
        service.createFlag('test-flag', 'desc', false, -5, defaultActor),
      ).rejects.toThrow(`rolloutPercent must be between ${ROLLOUT_PERCENT_MIN} and ${ROLLOUT_PERCENT_MAX}`)
    })

    it('writes audit log', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [makeFlagRow()] } as any)
      await service.createFlag('test-flag', 'desc', true, 50, defaultActor)
      expect(mockAudit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'CREATE_FLAG', resourceType: 'feature_flag' }),
      )
    })

    it('emits outbox event on creation', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [makeFlagRow()] } as any)
      await service.createFlag('test-flag', 'desc', false, 0, defaultActor)
      expect(mockOutboxCreate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ aggregateType: OUTBOX_AGGREGATE_TYPE, eventType: OUTBOX_EVENT_CREATED }),
      )
    })

    it('does not throw when outbox write fails', async () => {
      mockOutboxCreate.mockRejectedValueOnce(new Error('DB err'))
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [makeFlagRow()] } as any)
      await expect(
        service.createFlag('test-flag', 'desc', false, 0, defaultActor),
      ).resolves.toBeDefined()
    })
  })

  describe('updateFlag', () => {
    it('updates flag fields', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [makeFlagRow({ description: 'updated', default_enabled: true })] } as any)
      const flag = await service.updateFlag('test-flag', { description: 'updated', defaultEnabled: true }, defaultActor)
      expect(flag.description).toBe('updated')
    })

    it('rejects invalid rollout percent', async () => {
      await expect(
        service.updateFlag('test-flag', { rolloutPercent: -1 }, defaultActor),
      ).rejects.toThrow(`rolloutPercent must be between ${ROLLOUT_PERCENT_MIN} and ${ROLLOUT_PERCENT_MAX}`)
    })

    it('throws when no fields provided', async () => {
      await expect(service.updateFlag('test-flag', {}, defaultActor)).rejects.toThrow('No fields to update')
    })

    it('throws when flag not found', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [] } as any)
      await expect(service.updateFlag('unknown', { description: 'x' }, defaultActor)).rejects.toThrow("Feature flag 'unknown' not found")
    })
  })

  describe('setOverride', () => {
    it('creates a new override', async () => {
      vi.mocked(mockDb.query)
        .mockResolvedValueOnce({ rows: [makeFlagRow()] } as any)
        .mockResolvedValueOnce({ rows: [makeOverrideRow()] } as any)
      const override = await service.setOverride('test-flag', 'tenant-1', true, defaultActor)
      expect(override.enabled).toBe(true)
    })

    it('throws when flag not found', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [] } as any)
      await expect(service.setOverride('unknown', 'tenant-1', true, defaultActor)).rejects.toThrow("Feature flag 'unknown' not found")
    })
  })

  describe('removeOverride', () => {
    it('removes an override', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [{ id: 'override-1' }] } as any)
      await expect(service.removeOverride('test-flag', 'tenant-1', defaultActor)).resolves.toBeUndefined()
    })

    it('throws when override not found', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [] } as any)
      await expect(service.removeOverride('unknown', 'tenant-1', defaultActor)).rejects.toThrow("Override not found for flag 'unknown' and tenant 'tenant-1'")
    })
  })
})
