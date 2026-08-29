import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  RateLimitOverrideService,
  type ActorInfo,
} from './service.js'
import {
  InMemoryTenantRateLimitOverridesRepository,
  PostgresTenantRateLimitOverridesRepository,
} from '../../db/repositories/tenantRateLimitOverridesRepository.js'
import { AuditLogService, AuditAction } from '../audit/index.js'
import { ValidationError, NotFoundError } from '../../lib/errors.js'

describe('RateLimitOverrideService', () => {
  let repository: InMemoryTenantRateLimitOverridesRepository
  let auditLogService: AuditLogService
  let service: RateLimitOverrideService

  const actor: ActorInfo = {
    id: 'admin-101',
    email: 'admin@credence.org',
    tenantId: 'tenant-admin',
    ipAddress: '192.168.1.50',
    requestId: 'req-abc-123',
  }

  beforeEach(() => {
    repository = new InMemoryTenantRateLimitOverridesRepository()
    auditLogService = new AuditLogService()
    service = new RateLimitOverrideService(repository, auditLogService)
  })

  describe('setOverride - Positive & Audit Trail', () => {
    it('creates a new rate limit override and logs audit entry with actor, tenant, old/new values, reason, timestamp', async () => {
      const logSpy = vi.spyOn(auditLogService, 'logAction')

      const result = await service.setOverride(
        'tenant-corp-x',
        5000,
        60,
        'Black Friday promo surge approved by SecOps',
        actor,
      )

      expect(result.tenantId).toBe('tenant-corp-x')
      expect(result.rateLimit).toBe(5000)
      expect(result.windowSize).toBe(60)

      expect(logSpy).toHaveBeenCalledWith(
        actor.tenantId,
        actor.id,
        actor.email,
        AuditAction.SET_RATE_LIMIT_OVERRIDE,
        'tenant-corp-x',
        undefined,
        {
          targetTenantId: 'tenant-corp-x',
          oldRateLimit: null,
          newRateLimit: 5000,
          oldWindowSize: null,
          newWindowSize: 60,
          reason: 'Black Friday promo surge approved by SecOps',
        },
        'success',
        undefined,
        actor.ipAddress,
        actor.requestId,
      )

      const stored = await repository.findByTenantId('tenant-corp-x')
      expect(stored?.rateLimit).toBe(5000)
    })

    it('updates an existing rate limit override and logs audit entry capturing previous old values', async () => {
      await service.setOverride(
        'tenant-corp-x',
        5000,
        60,
        'Initial override',
        actor,
      )

      const logSpy = vi.spyOn(auditLogService, 'logAction')

      const updated = await service.setOverride(
        'tenant-corp-x',
        12000,
        120,
        'Tier upgrade to Enterprise Extra',
        actor,
      )

      expect(updated.rateLimit).toBe(12000)
      expect(updated.windowSize).toBe(120)

      expect(logSpy).toHaveBeenCalledWith(
        actor.tenantId,
        actor.id,
        actor.email,
        AuditAction.SET_RATE_LIMIT_OVERRIDE,
        'tenant-corp-x',
        undefined,
        {
          targetTenantId: 'tenant-corp-x',
          oldRateLimit: 5000,
          newRateLimit: 12000,
          oldWindowSize: 60,
          newWindowSize: 120,
          reason: 'Tier upgrade to Enterprise Extra',
        },
        'success',
        undefined,
        actor.ipAddress,
        actor.requestId,
      )
    })
  })

  describe('setOverride - Negative Tests', () => {
    it('fails when reason is missing or less than 3 characters, throwing typed ValidationError and logging failure', async () => {
      const logSpy = vi.spyOn(auditLogService, 'logAction')

      await expect(
        service.setOverride('tenant-corp-x', 5000, 60, '', actor),
      ).rejects.toThrow(ValidationError)

      expect(logSpy).toHaveBeenCalledWith(
        actor.tenantId,
        actor.id,
        actor.email,
        AuditAction.SET_RATE_LIMIT_OVERRIDE,
        'tenant-corp-x',
        undefined,
        expect.objectContaining({ reason: '' }),
        'failure',
        'Override reason is required and must be at least 3 characters',
        actor.ipAddress,
        actor.requestId,
      )

      const stored = await repository.findByTenantId('tenant-corp-x')
      expect(stored).toBeNull()
    })

    it('fails when rateLimit is invalid (zero or negative), throwing typed ValidationError and logging failure', async () => {
      const logSpy = vi.spyOn(auditLogService, 'logAction')

      await expect(
        service.setOverride('tenant-corp-x', -100, 60, 'Valid reason string', actor),
      ).rejects.toThrow(ValidationError)

      expect(logSpy).toHaveBeenCalledWith(
        actor.tenantId,
        actor.id,
        actor.email,
        AuditAction.SET_RATE_LIMIT_OVERRIDE,
        'tenant-corp-x',
        undefined,
        expect.objectContaining({ requestedRateLimit: -100 }),
        'failure',
        'rateLimit must be a positive integer',
        actor.ipAddress,
        actor.requestId,
      )
    })

    it('fails when windowSize is invalid (zero or negative), throwing typed ValidationError and logging failure', async () => {
      const logSpy = vi.spyOn(auditLogService, 'logAction')

      await expect(
        service.setOverride('tenant-corp-x', 5000, 0, 'Valid reason string', actor),
      ).rejects.toThrow(ValidationError)

      expect(logSpy).toHaveBeenCalledWith(
        actor.tenantId,
        actor.id,
        actor.email,
        AuditAction.SET_RATE_LIMIT_OVERRIDE,
        'tenant-corp-x',
        undefined,
        expect.objectContaining({ requestedWindowSize: 0 }),
        'failure',
        'windowSize must be a positive integer in seconds',
        actor.ipAddress,
        actor.requestId,
      )
    })
  })

  describe('removeOverride - Positive & Audit Trail', () => {
    it('removes an override and logs audit entry with actor, tenant, old values, reason, timestamp', async () => {
      await service.setOverride('tenant-corp-x', 5000, 60, 'Initial override', actor)

      const logSpy = vi.spyOn(auditLogService, 'logAction')

      await service.removeOverride('tenant-corp-x', 'Campaign ended, reverting limit', actor)

      expect(logSpy).toHaveBeenCalledWith(
        actor.tenantId,
        actor.id,
        actor.email,
        AuditAction.REMOVE_RATE_LIMIT_OVERRIDE,
        'tenant-corp-x',
        undefined,
        {
          targetTenantId: 'tenant-corp-x',
          oldRateLimit: 5000,
          oldWindowSize: 60,
          reason: 'Campaign ended, reverting limit',
        },
        'success',
        undefined,
        actor.ipAddress,
        actor.requestId,
      )

      const stored = await repository.findByTenantId('tenant-corp-x')
      expect(stored).toBeNull()
    })
  })

  describe('removeOverride - Negative Tests', () => {
    it('fails when removing non-existent override, throwing typed NotFoundError and logging failure', async () => {
      const logSpy = vi.spyOn(auditLogService, 'logAction')

      await expect(
        service.removeOverride('tenant-nonexistent', 'Attempt removal', actor),
      ).rejects.toThrow(NotFoundError)

      expect(logSpy).toHaveBeenCalledWith(
        actor.tenantId,
        actor.id,
        actor.email,
        AuditAction.REMOVE_RATE_LIMIT_OVERRIDE,
        'tenant-nonexistent',
        undefined,
        expect.objectContaining({ targetTenantId: 'tenant-nonexistent' }),
        'failure',
        'Rate limit override for tenant tenant-nonexistent not found',
        actor.ipAddress,
        actor.requestId,
      )
    })

    it('fails when removal reason is missing, throwing typed ValidationError and logging failure', async () => {
      await service.setOverride('tenant-corp-x', 5000, 60, 'Initial override', actor)
      const logSpy = vi.spyOn(auditLogService, 'logAction')

      await expect(
        service.removeOverride('tenant-corp-x', '   ', actor),
      ).rejects.toThrow(ValidationError)

      expect(logSpy).toHaveBeenCalledWith(
        actor.tenantId,
        actor.id,
        actor.email,
        AuditAction.REMOVE_RATE_LIMIT_OVERRIDE,
        'tenant-corp-x',
        undefined,
        expect.objectContaining({ reason: '   ' }),
        'failure',
        'Override removal reason is required and must be at least 3 characters',
        actor.ipAddress,
        actor.requestId,
      )
    })
  })

  describe('PostgresTenantRateLimitOverridesRepository', () => {
    it('executes SQL queries correctly for findByTenantId, upsert, delete, listAll', async () => {
      const mockDb = {
        query: vi
          .fn()
          .mockResolvedValueOnce({
            rows: [
              {
                id: 1,
                tenant_id: 't-1',
                rate_limit: 1000,
                window_size: 60,
                reason: 'test reason',
                created_at: new Date(),
                updated_at: new Date(),
              },
            ],
          })
          .mockResolvedValueOnce({
            rows: [
              {
                id: 1,
                tenant_id: 't-1',
                rate_limit: 1000,
                window_size: 60,
                reason: 'test reason',
                created_at: new Date(),
                updated_at: new Date(),
              },
            ],
          })
          .mockResolvedValueOnce({ rowCount: 1 })
          .mockResolvedValueOnce({ rows: [] }),
      }

      const pgRepo = new PostgresTenantRateLimitOverridesRepository(mockDb as any)
      const found = await pgRepo.findByTenantId('t-1')
      expect(found?.rateLimit).toBe(1000)

      const upserted = await pgRepo.upsert('t-1', 1000, 60, 'test reason')
      expect(upserted.tenantId).toBe('t-1')

      const deleted = await pgRepo.delete('t-1')
      expect(deleted).toBe(true)

      const list = await pgRepo.listAll()
      expect(list).toEqual([])
    })
  })
})
