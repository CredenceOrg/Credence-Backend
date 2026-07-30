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
    const result = await this.db.query<Row>(
      `SELECT id, tenant_id, rate_limit, window_size, reason, created_at, updated_at
       FROM tenant_rate_limit_overrides
       WHERE tenant_id = $1 LIMIT 1`,
      [tenantId]
    )
    return result.rows[0] ? mapRow(result.rows[0]) : null
  }

  async upsert(tenantId: string, rateLimit: number, windowSize: number, reason?: string): Promise<TenantRateLimitOverride> {
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
      [tenantId, rateLimit, windowSize, reason ?? null]
    )
    return mapRow(result.rows[0])
  }

  async delete(tenantId: string): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM tenant_rate_limit_overrides WHERE tenant_id = $1`,
      [tenantId]
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
    const item = this.overrides.get(tenantId)
    return item ? { ...item } : null
  }

  async upsert(tenantId: string, rateLimit: number, windowSize: number, reason?: string): Promise<TenantRateLimitOverride> {
    const now = new Date().toISOString()
    const existing = this.overrides.get(tenantId)
    const item: TenantRateLimitOverride = {
      id: existing?.id ?? this.idCounter++,
      tenantId,
      rateLimit,
      windowSize,
      reason,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    this.overrides.set(tenantId, item)
    return { ...item }
  }

  async delete(tenantId: string): Promise<boolean> {
    return this.overrides.delete(tenantId)
  }

  async listAll(): Promise<TenantRateLimitOverride[]> {
    return Array.from(this.overrides.values()).map((item) => ({ ...item }))
  }

  async clear(): Promise<void> {
    this.overrides.clear()
    this.idCounter = 1
  }
}
