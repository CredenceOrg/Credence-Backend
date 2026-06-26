import { createHash, randomUUID } from 'node:crypto'
import { pool } from '../../db/pool.js'
import type { Queryable } from '../../db/repositories/queryable.js'
import { OutboxRepository } from '../../db/outbox/repository.js'
import { auditLogService, AuditAction } from '../audit/index.js'
import type { AuditLogService } from '../audit/index.js'

export interface FeatureFlag {
  id: string
  key: string
  description: string
  defaultEnabled: boolean
  rolloutPercent: number
  createdAt: Date
  updatedAt: Date
}

export interface FeatureFlagOverride {
  id: string
  flagId: string
  tenantId: string
  enabled: boolean
  createdAt: Date
  updatedAt: Date
}

export interface FeatureFlagWithOverride extends FeatureFlag {
  override: FeatureFlagOverride | null
  effectiveEnabled: boolean
}

export interface ActorInfo {
  id: string
  email: string
  tenantId: string
  ipAddress?: string
}

export interface UpdateFlagInput {
  description?: string
  defaultEnabled?: boolean
  rolloutPercent?: number
}

interface RowFlag {
  id: string
  key: string
  description: string
  default_enabled: boolean
  rollout_percent: number
  created_at: Date
  updated_at: Date
}

interface RowOverride {
  id: string
  flag_id: string
  tenant_id: string
  enabled: boolean
  created_at: Date
  updated_at: Date
}

const FLAG_CACHE_PREFIX = 'feature_flag:'
const FLAG_LIST_CACHE_KEY = 'feature_flags:all'
const OVERRIDE_CACHE_PREFIX = 'feature_flag_override:'
const CACHE_TTL_MS = 30_000

const mapFlag = (row: RowFlag): FeatureFlag => ({
  id: row.id,
  key: row.key,
  description: row.description,
  defaultEnabled: row.default_enabled,
  rolloutPercent: row.rollout_percent,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const mapOverride = (row: RowOverride): FeatureFlagOverride => ({
  id: row.id,
  flagId: row.flag_id,
  tenantId: row.tenant_id,
  enabled: row.enabled,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

function computeRolloutBucket(rolloutPercent: number, entityId: string, flagKey: string): boolean {
  if (rolloutPercent >= 100) return true
  if (rolloutPercent <= 0) return false
  const hash = createHash('sha256').update(`${flagKey}:${entityId}`).digest('hex')
  const bucket = Number.parseInt(hash.substring(0, 8), 16) % 100
  return bucket < rolloutPercent
}

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

export class FeatureFlagService {
  private cache: Map<string, CacheEntry<any>>
  private outboxRepo: OutboxRepository

  constructor(
    private readonly db: Queryable = pool,
    private readonly audit: AuditLogService = auditLogService,
  ) {
    this.cache = new Map()
    this.outboxRepo = new OutboxRepository()
  }

  private cacheGet<T>(key: string): T | undefined {
    const entry = this.cache.get(key)
    if (!entry) return undefined
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      return undefined
    }
    return entry.value as T
  }

  private cacheSet<T>(key: string, value: T): void {
    this.cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS })
  }

  private cacheDelete(key: string): void {
    this.cache.delete(key)
  }

  async isEnabled(flagKey: string, tenantId: string, userId?: string): Promise<boolean> {
    const override = await this.getOverride(flagKey, tenantId)
    if (override !== null) return override.enabled

    const flag = await this.getFlag(flagKey)
    if (!flag) return false

    if (flag.rolloutPercent > 0) {
      const entityId = userId ?? tenantId
      return computeRolloutBucket(flag.rolloutPercent, entityId, flagKey)
    }

    return flag.defaultEnabled
  }

  async getFlag(flagKey: string): Promise<FeatureFlag | null> {
    const cacheKey = FLAG_CACHE_PREFIX + flagKey
    const cached = this.cacheGet<FeatureFlag>(cacheKey)
    if (cached !== undefined) return cached

    const result = await this.db.query<RowFlag>(
      'SELECT * FROM feature_flags WHERE key = $1',
      [flagKey],
    )
    if (result.rows.length === 0) return null

    const flag = mapFlag(result.rows[0])
    this.cacheSet(cacheKey, flag)
    return flag
  }

  async listFlags(): Promise<FeatureFlag[]> {
    const cached = this.cacheGet<FeatureFlag[]>(FLAG_LIST_CACHE_KEY)
    if (cached !== undefined) return cached

    const result = await this.db.query<RowFlag>(
      'SELECT * FROM feature_flags ORDER BY key',
    )
    const flags = result.rows.map(mapFlag)
    this.cacheSet(FLAG_LIST_CACHE_KEY, flags)
    return flags
  }

  async listFlagsWithOverrides(tenantId: string): Promise<FeatureFlagWithOverride[]> {
    const flags = await this.listFlags()
    const result = await this.db.query<RowOverride>(
      `SELECT ffo.*
       FROM feature_flag_overrides ffo
       JOIN feature_flags ff ON ff.id = ffo.flag_id
       WHERE ffo.tenant_id = $1`,
      [tenantId],
    )
    const overrideMap = new Map(result.rows.map((r) => [r.flag_id, mapOverride(r)]))

    return flags.map((flag) => {
      const override = overrideMap.get(flag.id) ?? null
      let effectiveEnabled: boolean
      if (override !== null) {
        effectiveEnabled = override.enabled
      } else if (flag.rolloutPercent > 0) {
        effectiveEnabled = computeRolloutBucket(flag.rolloutPercent, tenantId, flag.key)
      } else {
        effectiveEnabled = flag.defaultEnabled
      }
      return { ...flag, override, effectiveEnabled }
    })
  }

  async getOverride(flagKey: string, tenantId: string): Promise<FeatureFlagOverride | null> {
    const cacheKey = OVERRIDE_CACHE_PREFIX + `${flagKey}:${tenantId}`
    const cached = this.cacheGet<FeatureFlagOverride | null>(cacheKey)
    if (cached !== undefined) return cached

    const result = await this.db.query<RowOverride>(
      `SELECT ffo.*
       FROM feature_flag_overrides ffo
       JOIN feature_flags ff ON ff.id = ffo.flag_id
       WHERE ff.key = $1 AND ffo.tenant_id = $2`,
      [flagKey, tenantId],
    )
    const override = result.rows.length > 0 ? mapOverride(result.rows[0]) : null
    this.cacheSet(cacheKey, override)
    return override
  }

  async createFlag(
    key: string,
    description: string,
    defaultEnabled: boolean,
    rolloutPercent: number,
    actor: ActorInfo,
  ): Promise<FeatureFlag> {
    if (rolloutPercent < 0 || rolloutPercent > 100) {
      throw new Error('rolloutPercent must be between 0 and 100')
    }

    const id = randomUUID()
    const result = await this.db.query<RowFlag>(
      `INSERT INTO feature_flags (id, key, description, default_enabled, rollout_percent)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, key, description, defaultEnabled, rolloutPercent],
    )
    const flag = mapFlag(result.rows[0])

    this.invalidateFlagCache(flag.key)
    await this.emitOutboxEvent('feature_flag_created', flag.key, { ...flag, createdAt: flag.createdAt.toISOString(), updatedAt: flag.updatedAt.toISOString() })
    await this.audit.logAction({
      tenantId: actor.tenantId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: AuditAction.CREATE_FLAG,
      resourceType: 'feature_flag',
      resourceId: flag.key,
      details: { key, description, defaultEnabled, rolloutPercent },
      ipAddress: actor.ipAddress,
    })

    return flag
  }

  async updateFlag(
    flagKey: string,
    updates: UpdateFlagInput,
    actor: ActorInfo,
  ): Promise<FeatureFlag> {
    if (updates.rolloutPercent !== undefined && (updates.rolloutPercent < 0 || updates.rolloutPercent > 100)) {
      throw new Error('rolloutPercent must be between 0 and 100')
    }

    const sets: string[] = []
    const params: unknown[] = []
    let idx = 1

    if (updates.description !== undefined) {
      sets.push(`description = $${idx++}`)
      params.push(updates.description)
    }
    if (updates.defaultEnabled !== undefined) {
      sets.push(`default_enabled = $${idx++}`)
      params.push(updates.defaultEnabled)
    }
    if (updates.rolloutPercent !== undefined) {
      sets.push(`rollout_percent = $${idx++}`)
      params.push(updates.rolloutPercent)
    }
    if (sets.length === 0) {
      throw new Error('No fields to update')
    }

    sets.push(`updated_at = NOW()`)
    params.push(flagKey)

    const result = await this.db.query<RowFlag>(
      `UPDATE feature_flags SET ${sets.join(', ')} WHERE key = $${idx} RETURNING *`,
      params,
    )
    if (result.rows.length === 0) {
      throw new Error(`Feature flag '${flagKey}' not found`)
    }
    const flag = mapFlag(result.rows[0])

    this.invalidateFlagCache(flag.key)
    await this.emitOutboxEvent('feature_flag_updated', flag.key, { updates })
    await this.audit.logAction({
      tenantId: actor.tenantId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: AuditAction.UPDATE_FLAG,
      resourceType: 'feature_flag',
      resourceId: flag.key,
      details: { updates },
      ipAddress: actor.ipAddress,
    })

    return flag
  }

  async setOverride(
    flagKey: string,
    tenantId: string,
    enabled: boolean,
    actor: ActorInfo,
  ): Promise<FeatureFlagOverride> {
    const flag = await this.getFlag(flagKey)
    if (!flag) {
      throw new Error(`Feature flag '${flagKey}' not found`)
    }

    const result = await this.db.query<RowOverride>(
      `INSERT INTO feature_flag_overrides (flag_id, tenant_id, enabled)
       VALUES ($1, $2, $3)
       ON CONFLICT (flag_id, tenant_id)
       DO UPDATE SET enabled = $3, updated_at = NOW()
       RETURNING *`,
      [flag.id, tenantId, enabled],
    )
    const override = mapOverride(result.rows[0])

    this.invalidateOverrideCache(flagKey, tenantId)
    await this.emitOutboxEvent('feature_flag_override_updated', flagKey, { tenantId, enabled })
    await this.audit.logAction({
      tenantId: actor.tenantId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: AuditAction.SET_FLAG_OVERRIDE,
      resourceType: 'feature_flag_override',
      resourceId: `${flagKey}:${tenantId}`,
      details: { flagKey, tenantId, enabled },
      ipAddress: actor.ipAddress,
    })

    return override
  }

  async removeOverride(flagKey: string, tenantId: string, actor: ActorInfo): Promise<void> {
    const result = await this.db.query(
      `DELETE FROM feature_flag_overrides ffo
       USING feature_flags ff
       WHERE ff.id = ffo.flag_id AND ff.key = $1 AND ffo.tenant_id = $2
       RETURNING ffo.id`,
      [flagKey, tenantId],
    )
    if (result.rows.length === 0) {
      throw new Error(`Override not found for flag '${flagKey}' and tenant '${tenantId}'`)
    }

    this.invalidateOverrideCache(flagKey, tenantId)
    await this.emitOutboxEvent('feature_flag_override_removed', flagKey, { tenantId })
    await this.audit.logAction({
      tenantId: actor.tenantId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: AuditAction.REMOVE_FLAG_OVERRIDE,
      resourceType: 'feature_flag_override',
      resourceId: `${flagKey}:${tenantId}`,
      details: { flagKey, tenantId },
      ipAddress: actor.ipAddress,
    })
  }

  private invalidateFlagCache(key: string): void {
    this.cacheDelete(FLAG_CACHE_PREFIX + key)
    this.cacheDelete(FLAG_LIST_CACHE_KEY)
  }

  private invalidateOverrideCache(flagKey: string, tenantId: string): void {
    this.cacheDelete(OVERRIDE_CACHE_PREFIX + `${flagKey}:${tenantId}`)
    this.cacheDelete(FLAG_LIST_CACHE_KEY)
    this.cacheDelete(FLAG_CACHE_PREFIX + flagKey)
  }

  private async emitOutboxEvent(
    eventType: string,
    flagKey: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.outboxRepo.create(this.db as any, {
        aggregateType: 'feature_flag',
        aggregateId: flagKey,
        eventType,
        payload,
      })
    } catch {
      // Outbox write failures must not break the mutation
    }
  }
}
