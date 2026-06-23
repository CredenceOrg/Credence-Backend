import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FeatureFlagService } from './index.js'
import type { Queryable } from '../../db/repositories/queryable.js'

const mockOutboxCreate = vi.fn().mockResolvedValue(BigInt(1))
vi.mock('../../db/outbox/repository.js', () => ({
  OutboxRepository: vi.fn().mockImplementation(
    function () {
      return { create: mockOutboxCreate }
    },
  ),
}))

function makeFlagRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'flag-1',
    key: 'test-flag',
    description: 'Test feature flag',
    default_enabled: false,
    rollout_percent: 0,
    created_at: new Date('2025-01-01'),
    updated_at: new Date('2025-01-01'),
    ...overrides,
  }
}

function makeOverrideRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'override-1',
    flag_id: 'flag-1',
    tenant_id: 'tenant-1',
    enabled: true,
    created_at: new Date('2025-01-01'),
    updated_at: new Date('2025-01-01'),
    ...overrides,
  }
}

const defaultActor = {
  id: 'admin-1',
  email: 'admin@test.com',
  tenantId: 'tenant-admin',
}

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

  describe('isEnabled', () => {
    it('returns false for unknown flag', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [] } as any)

      const result = await service.isEnabled('unknown-flag', 'tenant-1')

      expect(result).toBe(false)
    })

    it('returns override value when override exists', async () => {
      vi.mocked(mockDb.query)
        .mockResolvedValueOnce({ rows: [makeOverrideRow({ enabled: true })] } as any)

      const result = await service.isEnabled('test-flag', 'tenant-1')

      expect(result).toBe(true)
    })

    it('returns false override when override disables', async () => {
      vi.mocked(mockDb.query)
        .mockResolvedValueOnce({ rows: [makeOverrideRow({ enabled: false })] } as any)

      const result = await service.isEnabled('test-flag', 'tenant-1')

      expect(result).toBe(false)
    })

    it('falls back to default_enabled when no override or rollout', async () => {
      vi.mocked(mockDb.query)
        .mockResolvedValueOnce({ rows: [] } as any)
        .mockResolvedValueOnce({ rows: [makeFlagRow({ default_enabled: true })] } as any)

      const result = await service.isEnabled('test-flag', 'tenant-1')

      expect(result).toBe(true)
    })

    it('uses rollout percent when set and no override', async () => {
      vi.mocked(mockDb.query)
        .mockResolvedValueOnce({ rows: [] } as any)
        .mockResolvedValueOnce({ rows: [makeFlagRow({ rollout_percent: 100 })] } as any)

      const result = await service.isEnabled('test-flag', 'tenant-1', 'user-1')

      expect(result).toBe(true)
    })

    it('rollout percent of 0 with default false returns false', async () => {
      vi.mocked(mockDb.query)
        .mockResolvedValueOnce({ rows: [] } as any)
        .mockResolvedValueOnce({ rows: [makeFlagRow({ rollout_percent: 0, default_enabled: false })] } as any)

      const result = await service.isEnabled('test-flag', 'tenant-1', 'user-1')

      expect(result).toBe(false)
    })

    it('rollout percent of 100 returns true', async () => {
      vi.mocked(mockDb.query)
        .mockResolvedValueOnce({ rows: [] } as any)
        .mockResolvedValueOnce({ rows: [makeFlagRow({ rollout_percent: 100 })] } as any)

      const result = await service.isEnabled('test-flag', 'tenant-1', 'user-1')

      expect(result).toBe(true)
    })

    it('returns deterministic results for the same user', async () => {
      vi.mocked(mockDb.query)
        .mockResolvedValue({ rows: [] } as any)

      const flagRow = makeFlagRow({ rollout_percent: 50 })
      vi.mocked(mockDb.query)
        .mockResolvedValueOnce({ rows: [] } as any)
        .mockResolvedValueOnce({ rows: [flagRow] } as any)

      const result1 = await service.isEnabled('test-flag', 'tenant-1', 'user-42')
      // Reset and re-mock for second call
      vi.mocked(mockDb.query)
        .mockReset()
        .mockResolvedValue({ rows: [] } as any)

      const result2 = await service.isEnabled('test-flag', 'tenant-1', 'user-42')

      expect(result1).toBe(result2)
    })

    it('uses tenantId for rollout when userId is not provided', async () => {
      vi.mocked(mockDb.query)
        .mockResolvedValueOnce({ rows: [] } as any)
        .mockResolvedValueOnce({ rows: [makeFlagRow({ rollout_percent: 50 })] } as any)

      const result = await service.isEnabled('test-flag', 'tenant-1')

      expect(typeof result).toBe('boolean')
    })

    it('produces roughly correct rollout distribution', async () => {
      const flagKey = 'rollout-test'
      const rolloutPercent = 30
      const totalUsers = 1000

      const flagRow = makeFlagRow({ key: flagKey, rollout_percent: rolloutPercent })

      let enabled = 0
      for (let i = 0; i < totalUsers; i++) {
        const svc = new FeatureFlagService(
          { query: vi.fn() },
          { logAction: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
        )
        vi.mocked(svc['db'].query)
          .mockResolvedValueOnce({ rows: [] } as any)
          .mockResolvedValueOnce({ rows: [flagRow] } as any)

        const result = await svc.isEnabled(flagKey, 'tenant-1', `user-${i}`)
        if (result) enabled++
      }

      expect(enabled).toBeGreaterThan(200)
      expect(enabled).toBeLessThan(400)
    })
  })

  describe('getFlag', () => {
    it('returns null for unknown flag', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [] } as any)

      const result = await service.getFlag('unknown')

      expect(result).toBeNull()
    })

    it('returns flag from db', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [makeFlagRow()] } as any)

      const result = await service.getFlag('test-flag')

      expect(result).not.toBeNull()
      expect(result!.key).toBe('test-flag')
      expect(result!.defaultEnabled).toBe(false)
      expect(result!.rolloutPercent).toBe(0)
    })

    it('caches flag after first fetch', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [makeFlagRow()] } as any)

      await service.getFlag('test-flag')
      await service.getFlag('test-flag')

      expect(mockDb.query).toHaveBeenCalledTimes(1)
    })
  })

  describe('listFlags', () => {
    it('returns all flags ordered by key', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({
        rows: [
          makeFlagRow({ key: 'beta', id: 'f1' }),
          makeFlagRow({ key: 'alpha', id: 'f2' }),
        ],
      } as any)

      const flags = await service.listFlags()

      expect(flags).toHaveLength(2)
      expect(mockDb.query).toHaveBeenCalledWith(
        'SELECT * FROM feature_flags ORDER BY key',
      )
    })

    it('caches list results', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [makeFlagRow()] } as any)

      await service.listFlags()
      await service.listFlags()

      expect(mockDb.query).toHaveBeenCalledTimes(1)
    })
  })

  describe('listFlagsWithOverrides', () => {
    it('returns flags with overrides and effectiveEnabled', async () => {
      vi.mocked(mockDb.query)
        .mockResolvedValueOnce({ rows: [makeFlagRow({ key: 'flag-a', id: 'f1', default_enabled: false })] } as any)
        .mockResolvedValueOnce({ rows: [makeOverrideRow({ flag_id: 'f1', enabled: true })] } as any)

      const results = await service.listFlagsWithOverrides('tenant-1')

      expect(results).toHaveLength(1)
      expect(results[0].override).not.toBeNull()
      expect(results[0].effectiveEnabled).toBe(true)
    })

    it('computes effectiveEnabled from rollout when no override', async () => {
      vi.mocked(mockDb.query)
        .mockResolvedValueOnce({ rows: [makeFlagRow({ key: 'flag-a', id: 'f1', rollout_percent: 100 })] } as any)
        .mockResolvedValueOnce({ rows: [] } as any)

      const results = await service.listFlagsWithOverrides('tenant-1')

      expect(results[0].override).toBeNull()
      expect(results[0].effectiveEnabled).toBe(true)
    })
  })

  describe('getOverride', () => {
    it('returns null when no override exists', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [] } as any)

      const result = await service.getOverride('test-flag', 'tenant-1')

      expect(result).toBeNull()
    })

    it('returns override when exists', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [makeOverrideRow()] } as any)

      const result = await service.getOverride('test-flag', 'tenant-1')

      expect(result).not.toBeNull()
      expect(result!.enabled).toBe(true)
      expect(result!.tenantId).toBe('tenant-1')
    })

    it('caches override', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [makeOverrideRow()] } as any)

      await service.getOverride('test-flag', 'tenant-1')
      await service.getOverride('test-flag', 'tenant-1')

      expect(mockDb.query).toHaveBeenCalledTimes(1)
    })
  })

  describe('createFlag', () => {
    it('creates and returns a flag', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [makeFlagRow()] } as any)

      const flag = await service.createFlag('test-flag', 'desc', true, 50, defaultActor)

      expect(flag.key).toBe('test-flag')
      expect(flag.defaultEnabled).toBe(false)
      expect(flag.rolloutPercent).toBe(0)
    })

    it('rejects invalid rollout percent', async () => {
      await expect(
        service.createFlag('test-flag', 'desc', false, 150, defaultActor),
      ).rejects.toThrow('rolloutPercent must be between 0 and 100')
    })

    it('writes audit log', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [makeFlagRow()] } as any)

      await service.createFlag('test-flag', 'desc', true, 50, defaultActor)

      expect(mockAudit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'CREATE_FLAG',
          resourceType: 'feature_flag',
          actorId: 'admin-1',
        }),
      )
    })

    it('invalidates cache after creation', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [makeFlagRow()] } as any)

      await service.listFlags()
      await service.createFlag('new-flag', 'desc', false, 0, defaultActor)

      vi.mocked(mockDb.query).mockResolvedValue({ rows: [makeFlagRow({ key: 'new-flag' })] } as any)
      const flags = await service.listFlags()

      expect(mockDb.query).toHaveBeenCalledTimes(3)
    })
  })

  describe('updateFlag', () => {
    it('updates flag fields', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [makeFlagRow({ description: 'updated', default_enabled: true })] } as any)

      const flag = await service.updateFlag('test-flag', { description: 'updated', defaultEnabled: true }, defaultActor)

      expect(flag.description).toBe('updated')
      expect(flag.defaultEnabled).toBe(true)
    })

    it('rejects invalid rollout percent', async () => {
      await expect(
        service.updateFlag('test-flag', { rolloutPercent: -1 }, defaultActor),
      ).rejects.toThrow('rolloutPercent must be between 0 and 100')
    })

    it('throws when no fields provided', async () => {
      await expect(
        service.updateFlag('test-flag', {}, defaultActor),
      ).rejects.toThrow('No fields to update')
    })

    it('throws when flag not found', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [] } as any)

      await expect(
        service.updateFlag('unknown', { description: 'x' }, defaultActor),
      ).rejects.toThrow("Feature flag 'unknown' not found")
    })

    it('writes audit log', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [makeFlagRow()] } as any)

      await service.updateFlag('test-flag', { description: 'updated' }, defaultActor)

      expect(mockAudit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'UPDATE_FLAG',
          resourceType: 'feature_flag',
        }),
      )
    })
  })

  describe('setOverride', () => {
    it('creates a new override', async () => {
      vi.mocked(mockDb.query)
        .mockResolvedValueOnce({ rows: [makeFlagRow()] } as any)
        .mockResolvedValueOnce({ rows: [makeOverrideRow()] } as any)

      const override = await service.setOverride('test-flag', 'tenant-1', true, defaultActor)

      expect(override).not.toBeNull()
      expect(override.enabled).toBe(true)
      expect(override.tenantId).toBe('tenant-1')
    })

    it('throws when flag not found', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [] } as any)

      await expect(
        service.setOverride('unknown', 'tenant-1', true, defaultActor),
      ).rejects.toThrow("Feature flag 'unknown' not found")
    })

    it('writes audit log', async () => {
      vi.mocked(mockDb.query)
        .mockResolvedValueOnce({ rows: [makeFlagRow()] } as any)
        .mockResolvedValueOnce({ rows: [makeOverrideRow()] } as any)

      await service.setOverride('test-flag', 'tenant-1', true, defaultActor)

      expect(mockAudit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'SET_FLAG_OVERRIDE',
          resourceType: 'feature_flag_override',
        }),
      )
    })

    it('invalidates override cache', async () => {
      vi.mocked(mockDb.query)
        .mockResolvedValueOnce({ rows: [makeOverrideRow()] } as any)
        .mockResolvedValueOnce({ rows: [makeFlagRow()] } as any)
        .mockResolvedValueOnce({ rows: [makeOverrideRow()] } as any)
        .mockResolvedValueOnce({ rows: [makeOverrideRow({ enabled: false })] } as any)

      await service.getOverride('test-flag', 'tenant-1')
      await service.setOverride('test-flag', 'tenant-1', false, defaultActor)

      const override = await service.getOverride('test-flag', 'tenant-1')

      expect(override).not.toBeNull()
      expect(override!.enabled).toBe(false)
      expect(mockDb.query).toHaveBeenCalledTimes(4)
    })
  })

  describe('removeOverride', () => {
    it('removes an override and returns void', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [{ id: 'override-1' }] } as any)

      await expect(
        service.removeOverride('test-flag', 'tenant-1', defaultActor),
      ).resolves.toBeUndefined()
    })

    it('throws when override not found', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [] } as any)

      await expect(
        service.removeOverride('unknown', 'tenant-1', defaultActor),
      ).rejects.toThrow("Override not found for flag 'unknown' and tenant 'tenant-1'")
    })

    it('writes audit log', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [{ id: 'override-1' }] } as any)

      await service.removeOverride('test-flag', 'tenant-1', defaultActor)

      expect(mockAudit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'REMOVE_FLAG_OVERRIDE',
          resourceType: 'feature_flag_override',
        }),
      )
    })
  })

  describe('cache invalidation via outbox', () => {
    it('emits outbox event on createFlag', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [makeFlagRow()] } as any)

      await service.createFlag('test-flag', 'desc', false, 0, defaultActor)

      expect(mockOutboxCreate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          aggregateType: 'feature_flag',
          eventType: 'feature_flag_created',
          aggregateId: 'test-flag',
        }),
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
})
