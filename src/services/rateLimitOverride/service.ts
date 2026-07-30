import {
  InMemoryTenantRateLimitOverridesRepository,
  PostgresTenantRateLimitOverridesRepository,
  type TenantRateLimitOverride,
  type TenantRateLimitOverridesRepository,
} from '../../db/repositories/tenantRateLimitOverridesRepository.js'
import { AuditLogService, AuditAction } from '../audit/index.js'
import { pool } from '../../db/pool.js'
import { ValidationError, NotFoundError } from '../../lib/errors.js'

export interface ActorInfo {
  id: string
  email: string
  tenantId: string
  ipAddress?: string
  requestId?: string
}

export class RateLimitOverrideService {
  constructor(
    private readonly repository: TenantRateLimitOverridesRepository = new InMemoryTenantRateLimitOverridesRepository(),
    private readonly auditLogService: AuditLogService = new AuditLogService(),
  ) {}

  /**
   * Set or update a per-tenant rate-limit override.
   * Mandates an audit trail entry recording actor, tenant, old/new value, reason, and timestamp.
   */
  async setOverride(
    tenantId: string,
    rateLimit: number,
    windowSize: number,
    reason: string,
    actor: ActorInfo,
  ): Promise<TenantRateLimitOverride> {
    if (!reason || typeof reason !== 'string' || reason.trim().length < 3) {
      await this.auditLogService.logAction(
        actor.tenantId,
        actor.id,
        actor.email,
        AuditAction.SET_RATE_LIMIT_OVERRIDE,
        tenantId,
        undefined,
        { targetTenantId: tenantId, requestedRateLimit: rateLimit, requestedWindowSize: windowSize, reason },
        'failure',
        'Override reason is required and must be at least 3 characters',
        actor.ipAddress,
        actor.requestId,
      )
      throw new ValidationError('Override reason is required and must be at least 3 characters')
    }

    if (rateLimit <= 0 || !Number.isInteger(rateLimit)) {
      await this.auditLogService.logAction(
        actor.tenantId,
        actor.id,
        actor.email,
        AuditAction.SET_RATE_LIMIT_OVERRIDE,
        tenantId,
        undefined,
        { targetTenantId: tenantId, requestedRateLimit: rateLimit, reason },
        'failure',
        'rateLimit must be a positive integer',
        actor.ipAddress,
        actor.requestId,
      )
      throw new ValidationError('rateLimit must be a positive integer')
    }

    if (windowSize <= 0 || !Number.isInteger(windowSize)) {
      await this.auditLogService.logAction(
        actor.tenantId,
        actor.id,
        actor.email,
        AuditAction.SET_RATE_LIMIT_OVERRIDE,
        tenantId,
        undefined,
        { targetTenantId: tenantId, requestedWindowSize: windowSize, reason },
        'failure',
        'windowSize must be a positive integer in seconds',
        actor.ipAddress,
        actor.requestId,
      )
      throw new ValidationError('windowSize must be a positive integer in seconds')
    }

    const existing = await this.repository.findByTenantId(tenantId)
    const oldRateLimit = existing?.rateLimit ?? null
    const oldWindowSize = existing?.windowSize ?? null

    const updated = await this.repository.upsert(tenantId, rateLimit, windowSize, reason.trim())

    await this.auditLogService.logAction(
      actor.tenantId,
      actor.id,
      actor.email,
      AuditAction.SET_RATE_LIMIT_OVERRIDE,
      tenantId,
      undefined,
      {
        targetTenantId: tenantId,
        oldRateLimit,
        newRateLimit: rateLimit,
        oldWindowSize,
        newWindowSize: windowSize,
        reason: reason.trim(),
      },
      'success',
      undefined,
      actor.ipAddress,
      actor.requestId,
    )

    return updated
  }

  /**
   * Remove a per-tenant rate-limit override.
   * Mandates an audit trail entry recording actor, tenant, old value, reason, and timestamp.
   */
  async removeOverride(
    tenantId: string,
    reason: string,
    actor: ActorInfo,
  ): Promise<void> {
    if (!reason || typeof reason !== 'string' || reason.trim().length < 3) {
      await this.auditLogService.logAction(
        actor.tenantId,
        actor.id,
        actor.email,
        AuditAction.REMOVE_RATE_LIMIT_OVERRIDE,
        tenantId,
        undefined,
        { targetTenantId: tenantId, reason },
        'failure',
        'Override removal reason is required and must be at least 3 characters',
        actor.ipAddress,
        actor.requestId,
      )
      throw new ValidationError('Override removal reason is required and must be at least 3 characters')
    }

    const existing = await this.repository.findByTenantId(tenantId)
    if (!existing) {
      await this.auditLogService.logAction(
        actor.tenantId,
        actor.id,
        actor.email,
        AuditAction.REMOVE_RATE_LIMIT_OVERRIDE,
        tenantId,
        undefined,
        { targetTenantId: tenantId, reason: reason.trim() },
        'failure',
        `Rate limit override for tenant ${tenantId} not found`,
        actor.ipAddress,
        actor.requestId,
      )
      throw new NotFoundError('Rate limit override', tenantId)
    }

    await this.repository.delete(tenantId)

    await this.auditLogService.logAction(
      actor.tenantId,
      actor.id,
      actor.email,
      AuditAction.REMOVE_RATE_LIMIT_OVERRIDE,
      tenantId,
      undefined,
      {
        targetTenantId: tenantId,
        oldRateLimit: existing.rateLimit,
        oldWindowSize: existing.windowSize,
        reason: reason.trim(),
      },
      'success',
      undefined,
      actor.ipAddress,
      actor.requestId,
    )
  }

  async getOverride(tenantId: string): Promise<TenantRateLimitOverride | null> {
    return this.repository.findByTenantId(tenantId)
  }

  async listOverrides(): Promise<TenantRateLimitOverride[]> {
    return this.repository.listAll()
  }
}

function createDefaultRepository(): TenantRateLimitOverridesRepository {
  if (process.env.DATABASE_URL) {
    return new PostgresTenantRateLimitOverridesRepository(pool)
  }
  return new InMemoryTenantRateLimitOverridesRepository()
}

export const rateLimitOverrideService = new RateLimitOverrideService(createDefaultRepository())
