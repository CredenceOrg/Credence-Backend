import type { Queryable } from './queryable.js'

export interface TenantRateLimitOverride {
  id?: number
  tenantId: string
  rateLimit: number
  windowSize: number
  reason?: string
  createdAt?: string
  updatedAt?: string
}

export interface TenantRateLimitOverridesRepository {
  findByTenantId(tenantId: string): Promise<TenantRateLimitOverride | null>
  upsert(tenantId: string, rateLimit: number, windowSize: number, reason?: string): Promise<TenantRateLimitOverride>
  delete(tenantId: string): Promise<boolean>
  listAll(): Promise<TenantRateLimitOverride[]>
  clear(): Promise<void>
}

type Row = {
  id: number
  tenant_id: string
  rate_limit: number
  window_size: number
  reason: string | null
  created_at: Date | string
  updated_at: Date | string
}

/**
 * Validation invariants:
 * - tenantId must be a non-empty string (trimmed).
 * - rateLimit must be a positive, finite integer.
 * - windowSize must be a positive, finite integer.
 * These are enforced in both the Postgres and in-memory implementations
 * so that invalid input fails fast and deterministically rather than
 * silently corrupting rate-limit state.
 */
export class TenantRateLimitValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TenantRateLimitValidationError'
  }
}

function normalizeTenantId(tenantId: unknown): string {
  if (typeof tenantId !== 'string') {
    throw new TenantRateLimitValidationError('tenantId must be a non-empty string')
  }
  const trimmed = tenantId.trim()
  if (trimmed.length === 0) {
    throw new TenantRateLimitValidationError('tenantId must be a non-empty string')
  }
  return trimmed
}

function normalizePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new TenantRateLimitValidationError(`${field} must be a positive integer`)
  }
  return value
}

function normalizeReason(reason: unknown): string | undefined {
  if (reason === undefined || reason === null) return undefined
  if (typeof reason !== 'string') {
    throw new TenantRateLimitValidationError('reason must be a string when provided')
  }
  const trimmed = reason.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

const mapRow = (row: Row): TenantRateLimitOverride => ({
  id: row.id,
  tenantId: row.tenant_id,
  rateLimit: Number(row.rate_limit),
  windowSize: Number(row.window_size),
  reason: row.reason ?? undefined,
  createdAt: new Date(row.created_at).toISOString(),
  updatedAt: new Date(row.updated_at).toISOString(),
})

export class PostgresTenantRateLimitOverridesRepository implements TenantRateLimitOverridesRepository {
  constructor(private readonly db: Queryable) {}

  async findByTenantId(tenantId: string): Promise<TenantRateLimitOverride | null> {
    const normalized = normalizeTenantId(tenantId)
    const result = await this.db.query<Row>(
      `SELECT id, tenant_id, rate_limit, window_size, reason, created_at, updated_at
       FROM tenant_rate_limit_overrides
       WHERE tenant_id = $1 LIMIT 1`,
      [normalized]
    )
    return result.rows[0] ? mapRow(result.rows[0]) : null
  }

  async upsert(tenantId: string, rateLimit: number, windowSize: number, reason?: string): Promise<TenantRateLimitOverride> {
    const normalizedTenantId = normalizeTenantId(tenantId)
    const normalizedRateLimit = normalizePositiveInteger(rateLimit, 'rateLimit')
    const normalizedWindowSize = normalizePositiveInteger(windowSize, 'windowSize')
    const normalizedReason = normalizeReason(reason)

    const result = await this.db.query<Row>(
      `INSERT INTO tenant_rate_limit_overrides (tenant_id, rate_limit, window_size, reason, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (tenant_id)
       DO UPDATE SET
         rate_limit = EXCLUDED.rate_limit,
         window_size = EXCLUDED.window_size,
         reason = EXCLUDED.reason,
         updated_at = NOW()
       RETURNING id, tenant_id, rate_limit, window_size, reason, created_at, updated_at`,
      [normalizedTenantId, normalizedRateLimit, normalizedWindowSize, normalizedReason ?? null]
    )
    return mapRow(result.rows[0])
  }

  async delete(tenantId: string): Promise<boolean> {
    const normalized = normalizeTenantId(tenantId)
    const result = await this.db.query(
      `DELETE FROM tenant_rate_limit_overrides WHERE tenant_id = $1`,
      [normalized]
    )
    return (result.rowCount ?? 0) > 0
  }

  async listAll(): Promise<TenantRateLimitOverride[]> {
    const result = await this.db.query<Row>(
      `SELECT id, tenant_id, rate_limit, window_size, reason, created_at, updated_at
       FROM tenant_rate_limit_overrides ORDER BY tenant_id ASC`
    )
    return result.rows.map(mapRow)
  }

  async clear(): Promise<void> {
    await this.db.query(`DELETE FROM tenant_rate_limit_overrides`)
  }
}

export class InMemoryTenantRateLimitOverridesRepository implements TenantRateLimitOverridesRepository {
  private overrides = new Map<string, TenantRateLimitOverride>()
  private idCounter = 1

  async findByTenantId(tenantId: string): Promise<TenantRateLimitOverride | null> {
    const normalized = normalizeTenantId(tenantId)
    const item = this.overrides.get(normalized)
    return item ? { ...item } : null
  }

  async upsert(tenantId: string, rateLimit: number, windowSize: number, reason?: string): Promise<TenantRateLimitOverride> {
    const normalizedTenantId = normalizeTenantId(tenantId)
    const normalizedRateLimit = normalizePositiveInteger(rateLimit, 'rateLimit')
    const normalizedWindowSize = normalizePositiveInteger(windowSize, 'windowSize')
    const normalizedReason = normalizeReason(reason)

    const now = new Date().toISOString()
    const existing = this.overrides.get(normalizedTenantId)
    const item: TenantRateLimitOverride = {
      id: existing?.id ?? this.idCounter++,
      tenantId: normalizedTenantId,
      rateLimit: normalizedRateLimit,
      windowSize: normalizedWindowSize,
      reason: normalizedReason,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    this.overrides.set(normalizedTenantId, item)
    return { ...item }
  }

  async delete(tenantId: string): Promise<boolean> {
    const normalized = normalizeTenantId(tenantId)
    return this.overrides.delete(normalized)
  }

  async listAll(): Promise<TenantRateLimitOverride[]> {
    return Array.from(this.overrides.values()).map((item) => ({ ...item }))
  }

  async clear(): Promise<void> {
    this.overrides.clear()
    this.idCounter = 1
  }
}
