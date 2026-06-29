import { createHash, randomUUID } from 'node:crypto'
import { pool } from '../../db/pool.js'
import type { Queryable } from '../../db/repositories/queryable.js'
import { OutboxRepository } from '../../db/outbox/repository.js'
import { auditLogService, AuditAction } from '../audit/index.js'
import type { AuditLogService } from '../audit/index.js'
import {
  FLAG_CACHE_PREFIX,
  FLAG_LIST_CACHE_KEY,
  OVERRIDE_CACHE_PREFIX,
  FLAG_CACHE_TTL_MS,
  ROLLOUT_PERCENT_MIN,
  ROLLOUT_PERCENT_MAX,
  ROLLOUT_HASH_HEX_CHARS,
  OUTBOX_AGGREGATE_TYPE,
  OUTBOX_EVENT_CREATED,
  OUTBOX_EVENT_UPDATED,
  OUTBOX_EVENT_OVERRIDE_UPDATED,
  OUTBOX_EVENT_OVERRIDE_REMOVED,
  OUTBOX_EVENT_TENANT_ROLLOUT_SET,
  OUTBOX_EVENT_TENANT_ROLLOUT_REMOVED,
} from './consts.js'

// ── Internal cache key for per-tenant rollouts ────────────────────────────────
const TENANT_ROLLOUT_CACHE_PREFIX = 'feature_flag_tenant_rollout:'

// ── DB row types ──────────────────────────────────────────────────────────────

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

interface RowTenantRollout {
  id: string
  flag_id: string
  tenant_id: string
  rollout_percent: number
  created_at: Date
  updated_at: Date
}

// ── Public types ──────────────────────────────────────────────────────────────

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

/**
 * Per-tenant rollout percentage record.
 *
 * Allows each tenant to see a flag rolled out at a different rate from the
 * global `rolloutPercent`.  User-level sticky bucketing (SHA-256 hash of
 * `flagKey:userId`) still applies within the tenant's percentage window.
 */
export interface FeatureFlagTenantRollout {
  id: string
  flagId: string
  tenantId: string
  rolloutPercent: number
  createdAt: Date
  updatedAt: Date
}

export interface FeatureFlagWithOverride extends FeatureFlag {
  override: FeatureFlagOverride | null
  /** Per-tenant rollout percentage override (null if not set). */
  tenantRollout: FeatureFlagTenantRollout | null
  effectiveEnabled: boolean
  /**
   * Effective rollout percentage used for evaluation:
   *   - tenantRollout.rolloutPercent if a per-tenant rollout is set, otherwise
   *   - the global flag rolloutPercent.
   */
  effectiveRolloutPercent: number
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

// ── Helpers ───────────────────────────────────────────────────────────────────

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

const mapTenantRollout = (row: RowTenantRollout): FeatureFlagTenantRollout => ({
  id: row.id,
  flagId: row.flag_id,
  tenantId: row.tenant_id,
  rolloutPercent: row.rollout_percent,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

/**
 * Deterministic rollout bucketing.
 *
 * Uses SHA-256(flagKey + ":" + entityId), takes the first
 * ROLLOUT_HASH_HEX_CHARS hex characters as a number, then applies modulo 100.
 * This guarantees:
 *   – same user + same flag → same bucket forever
 *   – roughly uniform distribution across users
 *   – no per-user state needs to be persisted
 *
 * @param rolloutPercent - Effective percent threshold (0–100)
 * @param entityId       - Sticky entity: userId when available, tenantId otherwise
 * @param flagKey        - Flag identifier (salt to prevent correlation across flags)
 */
export function computeRolloutBucket(
  rolloutPercent: number,
  entityId: string,
  flagKey: string,
): boolean {
  if (rolloutPercent >= ROLLOUT_PERCENT_MAX) return true
  if (rolloutPercent <= ROLLOUT_PERCENT_MIN) return false
  const hash = createHash('sha256')
    .update(`${flagKey}:${entityId}`)
    .digest('hex')
  const bucket = Number.parseInt(hash.substring(0, ROLLOUT_HASH_HEX_CHARS), 16) % 100
  return bucket < rolloutPercent
}

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

// ── Service ───────────────────────────────────────────────────────────────────

export class FeatureFlagService {
  private readonly cache: Map<string, CacheEntry<unknown>>
  private readonly outboxRepo: OutboxRepository

  constructor(
    private readonly db: Queryable = pool,
    private readonly audit: AuditLogService = auditLogService,
  ) {
    this.cache = new Map()
    this.outboxRepo = new OutboxRepository()
  }

  // ── Cache helpers ───────────────────────────────────────────────────────────

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
    this.cache.set(key, { value, expiresAt: Date.now() + FLAG_CACHE_TTL_MS })
  }

  private cacheDelete(key: string): void {
    this.cache.delete(key)
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Evaluate whether a feature flag is enabled for a given tenant and optional
   * user.
   *
   * Evaluation order (highest → lowest priority):
   *   1. Per-tenant boolean override  → returns override.enabled
   *   2. Per-tenant rollout percent   → sticky SHA-256 bucket check
   *   3. Global rollout percent       → sticky SHA-256 bucket check
   *   4. Flag.defaultEnabled          → static fallback
   *
   * When `userId` is provided the sticky bucket is keyed on the user; otherwise
   * it falls back to `tenantId` so tenant-level cohesion is preserved even
   * without a user context.
   */
  async isEnabled(flagKey: string, tenantId: string, userId?: string): Promise<boolean> {
    // Priority 1: boolean per-tenant override
    const override = await this.getOverride(flagKey, tenantId)
    if (override !== null) return override.enabled

    const flag = await this.getFlag(flagKey)
    if (!flag) return false

    const entityId = userId ?? tenantId

    // Priority 2: per-tenant rollout percentage
    const tenantRollout = await this.getTenantRollout(flagKey, tenantId)
    if (tenantRollout !== null) {
      return computeRolloutBucket(tenantRollout.rolloutPercent, entityId, flagKey)
    }

    // Priority 3: global rollout percentage
    if (flag.rolloutPercent > ROLLOUT_PERCENT_MIN) {
      return computeRolloutBucket(flag.rolloutPercent, entityId, flagKey)
    }

    // Priority 4: static default
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

    // Fetch boolean overrides for this tenant
    const overrideResult = await this.db.query<RowOverride>(
      `SELECT ffo.*
       FROM feature_flag_overrides ffo
       JOIN feature_flags ff ON ff.id = ffo.flag_id
       WHERE ffo.tenant_id = $1`,
      [tenantId],
    )
    const overrideMap = new Map(
      overrideResult.rows.map((r) => [r.flag_id, mapOverride(r)]),
    )

    // Fetch per-tenant rollout percentages for this tenant
    const rolloutResult = await this.db.query<RowTenantRollout>(
      `SELECT fftr.*
       FROM feature_flag_tenant_rollouts fftr
       JOIN feature_flags ff ON ff.id = fftr.flag_id
       WHERE fftr.tenant_id = $1`,
      [tenantId],
    )
    const tenantRolloutMap = new Map(
      rolloutResult.rows.map((r) => [r.flag_id, mapTenantRollout(r)]),
    )

    return flags.map((flag) => {
      const override = overrideMap.get(flag.id) ?? null
      const tenantRollout = tenantRolloutMap.get(flag.id) ?? null

      let effectiveEnabled: boolean
      const effectiveRolloutPercent =
        tenantRollout !== null ? tenantRollout.rolloutPercent : flag.rolloutPercent

      if (override !== null) {
        effectiveEnabled = override.enabled
      } else if (tenantRollout !== null) {
        effectiveEnabled = computeRolloutBucket(
          tenantRollout.rolloutPercent,
          tenantId,
          flag.key,
        )
      } else if (flag.rolloutPercent > ROLLOUT_PERCENT_MIN) {
        effectiveEnabled = computeRolloutBucket(flag.rolloutPercent, tenantId, flag.key)
      } else {
        effectiveEnabled = flag.defaultEnabled
      }

      return { ...flag, override, tenantRollout, effectiveEnabled, effectiveRolloutPercent }
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

  /**
   * Returns the per-tenant rollout percentage record for a flag, or null if
   * none has been configured.
   */
  async getTenantRollout(flagKey: string, tenantId: string): Promise<FeatureFlagTenantRollout | null> {
    const cacheKey = TENANT_ROLLOUT_CACHE_PREFIX + `${flagKey}:${tenantId}`
    const cached = this.cacheGet<FeatureFlagTenantRollout | null>(cacheKey)
    if (cached !== undefined) return cached

    const result = await this.db.query<RowTenantRollout>(
      `SELECT fftr.*
       FROM feature_flag_tenant_rollouts fftr
       JOIN feature_flags ff ON ff.id = fftr.flag_id
       WHERE ff.key = $1 AND fftr.tenant_id = $2`,
      [flagKey, tenantId],
    )
    const tenantRollout = result.rows.length > 0 ? mapTenantRollout(result.rows[0]) : null
    this.cacheSet(cacheKey, tenantRollout)
    return tenantRollout
  }

  async createFlag(
    key: string,
    description: string,
    defaultEnabled: boolean,
    rolloutPercent: number,
    actor: ActorInfo,
  ): Promise<FeatureFlag> {
    if (rolloutPercent < ROLLOUT_PERCENT_MIN || rolloutPercent > ROLLOUT_PERCENT_MAX) {
      throw new Error(`rolloutPercent must be between ${ROLLOUT_PERCENT_MIN} and ${ROLLOUT_PERCENT_MAX}`)
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
    await this.emitOutboxEvent(OUTBOX_EVENT_CREATED, flag.key, {
      ...flag,
      createdAt: flag.createdAt.toISOString(),
      updatedAt: flag.updatedAt.toISOString(),
    })
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
    if (
      updates.rolloutPercent !== undefined &&
      (updates.rolloutPercent < ROLLOUT_PERCENT_MIN || updates.rolloutPercent > ROLLOUT_PERCENT_MAX)
    ) {
      throw new Error(`rolloutPercent must be between ${ROLLOUT_PERCENT_MIN} and ${ROLLOUT_PERCENT_MAX}`)
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
    await this.emitOutboxEvent(OUTBOX_EVENT_UPDATED, flag.key, { updates })
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
    await this.emitOutboxEvent(OUTBOX_EVENT_OVERRIDE_UPDATED, flagKey, { tenantId, enabled })
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
    await this.emitOutboxEvent(OUTBOX_EVENT_OVERRIDE_REMOVED, flagKey, { tenantId })
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

  /**
   * Set (upsert) a per-tenant rollout percentage for a flag.
   *
   * This is distinct from a boolean override: it allows each tenant to receive
   * a different rollout fraction while still using the same sticky
   * SHA-256 user-id bucketing that the global rollout uses.
   *
   * A boolean override (setOverride) always takes precedence over a tenant
   * rollout.  Remove the boolean override first if you want the tenant rollout
   * to take effect.
   */
  async setTenantRollout(
    flagKey: string,
    tenantId: string,
    rolloutPercent: number,
    actor: ActorInfo,
  ): Promise<FeatureFlagTenantRollout> {
    if (rolloutPercent < ROLLOUT_PERCENT_MIN || rolloutPercent > ROLLOUT_PERCENT_MAX) {
      throw new Error(`rolloutPercent must be between ${ROLLOUT_PERCENT_MIN} and ${ROLLOUT_PERCENT_MAX}`)
    }

    const flag = await this.getFlag(flagKey)
    if (!flag) {
      throw new Error(`Feature flag '${flagKey}' not found`)
    }

    const result = await this.db.query<RowTenantRollout>(
      `INSERT INTO feature_flag_tenant_rollouts (flag_id, tenant_id, rollout_percent)
       VALUES ($1, $2, $3)
       ON CONFLICT (flag_id, tenant_id)
       DO UPDATE SET rollout_percent = $3, updated_at = NOW()
       RETURNING *`,
      [flag.id, tenantId, rolloutPercent],
    )
    const tenantRollout = mapTenantRollout(result.rows[0])

    this.invalidateTenantRolloutCache(flagKey, tenantId)
    await this.emitOutboxEvent(OUTBOX_EVENT_TENANT_ROLLOUT_SET, flagKey, {
      tenantId,
      rolloutPercent,
    })
    await this.audit.logAction({
      tenantId: actor.tenantId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: AuditAction.SET_FLAG_OVERRIDE,
      resourceType: 'feature_flag_tenant_rollout',
      resourceId: `${flagKey}:${tenantId}`,
      details: { flagKey, tenantId, rolloutPercent },
      ipAddress: actor.ipAddress,
    })

    return tenantRollout
  }

  /**
   * Remove a per-tenant rollout percentage for a flag.
   *
   * After removal the tenant falls back to the global rollout percent (or
   * default_enabled if that is also 0).
   */
  async removeTenantRollout(flagKey: string, tenantId: string, actor: ActorInfo): Promise<void> {
    const result = await this.db.query(
      `DELETE FROM feature_flag_tenant_rollouts fftr
       USING feature_flags ff
       WHERE ff.id = fftr.flag_id AND ff.key = $1 AND fftr.tenant_id = $2
       RETURNING fftr.id`,
      [flagKey, tenantId],
    )
    if (result.rows.length === 0) {
      throw new Error(`Tenant rollout not found for flag '${flagKey}' and tenant '${tenantId}'`)
    }

    this.invalidateTenantRolloutCache(flagKey, tenantId)
    await this.emitOutboxEvent(OUTBOX_EVENT_TENANT_ROLLOUT_REMOVED, flagKey, { tenantId })
    await this.audit.logAction({
      tenantId: actor.tenantId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: AuditAction.REMOVE_FLAG_OVERRIDE,
      resourceType: 'feature_flag_tenant_rollout',
      resourceId: `${flagKey}:${tenantId}`,
      details: { flagKey, tenantId },
      ipAddress: actor.ipAddress,
    })
  }

  // ── Cache invalidation ──────────────────────────────────────────────────────

  private invalidateFlagCache(key: string): void {
    this.cacheDelete(FLAG_CACHE_PREFIX + key)
    this.cacheDelete(FLAG_LIST_CACHE_KEY)
  }

  private invalidateOverrideCache(flagKey: string, tenantId: string): void {
    this.cacheDelete(OVERRIDE_CACHE_PREFIX + `${flagKey}:${tenantId}`)
    this.cacheDelete(FLAG_LIST_CACHE_KEY)
    this.cacheDelete(FLAG_CACHE_PREFIX + flagKey)
  }

  private invalidateTenantRolloutCache(flagKey: string, tenantId: string): void {
    this.cacheDelete(TENANT_ROLLOUT_CACHE_PREFIX + `${flagKey}:${tenantId}`)
    this.cacheDelete(FLAG_LIST_CACHE_KEY)
    this.cacheDelete(FLAG_CACHE_PREFIX + flagKey)
  }

  // ── Outbox helpers ──────────────────────────────────────────────────────────

  private async emitOutboxEvent(
    eventType: string,
    flagKey: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.outboxRepo.create(this.db as any, {
        aggregateType: OUTBOX_AGGREGATE_TYPE,
        aggregateId: flagKey,
        eventType,
        payload,
      })
    } catch {
      // Outbox write failures must not break the mutation
    }
  }
}
