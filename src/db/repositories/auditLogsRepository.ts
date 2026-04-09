import { randomUUID } from 'node:crypto'
import type { Queryable } from './queryable.js'
import type {
  AuditLogEntry,
  AuditLogFilters,
  AuditLogInput,
  AuditStatus,
} from '../../services/audit/types.js'

type AuditLogRow = {
  id: string
  occurred_at: Date | string
  actor_id: string
  actor_email: string
  action: string
  resource_type: string
  resource_id: string
  details_json: Record<string, unknown> | null
  status: AuditStatus
  ip_address: string | null
  error_message: string | null
}

const toDate = (value: Date | string): Date =>
  value instanceof Date ? value : new Date(value)

const cloneDetails = (details: Record<string, unknown>): Record<string, unknown> =>
  JSON.parse(JSON.stringify(details)) as Record<string, unknown>

const cloneEntry = (entry: AuditLogEntry): AuditLogEntry => ({
  ...entry,
  details: cloneDetails(entry.details),
})

const mapAuditLog = (row: AuditLogRow): AuditLogEntry => ({
  id: row.id,
  timestamp: toDate(row.occurred_at).toISOString(),
  actorId: row.actor_id,
  actorEmail: row.actor_email,
  adminId: row.actor_id,
  adminEmail: row.actor_email,
  action: row.action,
  resourceType: row.resource_type,
  resourceId: row.resource_id,
  targetUserId: row.resource_id,
  targetUserEmail:
    typeof (row.details_json ?? {}).targetUserEmail === 'string'
      ? ((row.details_json ?? {}).targetUserEmail as string)
      : undefined,
  details: row.details_json ?? {},
  status: row.status,
  ipAddress: row.ip_address ?? undefined,
  errorMessage: row.error_message ?? undefined,
})

const applyFilters = (
  filters: AuditLogFilters | undefined,
  whereClauses: string[],
  params: unknown[],
): void => {
  if (!filters) return

  if (filters.action) {
    params.push(filters.action)
    whereClauses.push(`action = $${params.length}`)
  }
  if (filters.actorId ?? filters.adminId) {
    params.push(filters.actorId ?? filters.adminId)
    whereClauses.push(`actor_id = $${params.length}`)
  }
  if (filters.resourceId ?? filters.targetUserId) {
    params.push(filters.resourceId ?? filters.targetUserId)
    whereClauses.push(`resource_id = $${params.length}`)
  }
  if (filters.resourceType) {
    params.push(filters.resourceType)
    whereClauses.push(`resource_type = $${params.length}`)
  }
  if (filters.status) {
    params.push(filters.status)
    whereClauses.push(`status = $${params.length}`)
  }
  if (filters.from) {
    params.push(filters.from)
    whereClauses.push(`occurred_at >= $${params.length}`)
  }
  if (filters.to) {
    params.push(filters.to)
    whereClauses.push(`occurred_at <= $${params.length}`)
  }
}

export interface AuditLogRepository {
  append(input: AuditLogInput): Promise<AuditLogEntry>
  query(filters?: AuditLogFilters, limit?: number, offset?: number): Promise<{ logs: AuditLogEntry[]; total: number }>
  getAll(): Promise<AuditLogEntry[]>
  clear(): Promise<void>
}

export class PostgresAuditLogsRepository implements AuditLogRepository {
  constructor(private readonly db: Queryable) {}

  async append(input: AuditLogInput): Promise<AuditLogEntry> {
    const id = randomUUID()
    const result = await this.db.query<AuditLogRow>(
      `
      INSERT INTO audit_logs (
        id,
        actor_id,
        actor_email,
        action,
        resource_type,
        resource_id,
        details_json,
        status,
        ip_address,
        error_message
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
      RETURNING
        id,
        occurred_at,
        actor_id,
        actor_email,
        action,
        resource_type,
        resource_id,
        details_json,
        status,
        ip_address,
        error_message
      `,
      [
        id,
        input.actorId,
        input.actorEmail,
        input.action,
        input.resourceType,
        input.resourceId,
        JSON.stringify(input.details ?? {}),
        input.status ?? 'success',
        input.ipAddress ?? null,
        input.errorMessage ?? null,
      ],
    )

    return mapAuditLog(result.rows[0])
  }

  async query(filters?: AuditLogFilters, limit = 100, offset = 0): Promise<{ logs: AuditLogEntry[]; total: number }> {
    const whereClauses: string[] = []
    const params: unknown[] = []
    applyFilters(filters, whereClauses, params)

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''

    const totalResult = await this.db.query<{ total: string }>(
      `SELECT COUNT(*)::TEXT AS total FROM audit_logs ${whereSql}`,
      params,
    )

    params.push(limit)
    const limitIdx = params.length
    params.push(offset)
    const offsetIdx = params.length

    const rowsResult = await this.db.query<AuditLogRow>(
      `
      SELECT
        id,
        occurred_at,
        actor_id,
        actor_email,
        action,
        resource_type,
        resource_id,
        details_json,
        status,
        ip_address,
        error_message
      FROM audit_logs
      ${whereSql}
      ORDER BY occurred_at DESC, id DESC
      LIMIT $${limitIdx}
      OFFSET $${offsetIdx}
      `,
      params,
    )

    return {
      logs: rowsResult.rows.map(mapAuditLog),
      total: Number(totalResult.rows[0]?.total ?? 0),
    }
  }

  async getAll(): Promise<AuditLogEntry[]> {
    const result = await this.query(undefined, Number.MAX_SAFE_INTEGER, 0)
    return result.logs
  }

  async clear(): Promise<void> {
    await this.db.query('DELETE FROM audit_logs')
  }
}

export class InMemoryAuditLogsRepository implements AuditLogRepository {
  private logs: Readonly<AuditLogEntry>[] = []

  async append(input: AuditLogInput): Promise<AuditLogEntry> {
    const entry: AuditLogEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      actorId: input.actorId,
      actorEmail: input.actorEmail,
      adminId: input.actorId,
      adminEmail: input.actorEmail,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      targetUserId: input.resourceId,
      targetUserEmail:
        typeof (input.details ?? {}).targetUserEmail === 'string'
          ? ((input.details ?? {}).targetUserEmail as string)
          : undefined,
      details: cloneDetails(input.details ?? {}),
      status: input.status ?? 'success',
      ipAddress: input.ipAddress,
      errorMessage: input.errorMessage,
    }

    const frozen = Object.freeze(cloneEntry(entry))
    this.logs.push(frozen)
    return cloneEntry(frozen)
  }

  async query(filters?: AuditLogFilters, limit = 100, offset = 0): Promise<{ logs: AuditLogEntry[]; total: number }> {
    let filtered = this.logs

    if (filters?.action) {
      filtered = filtered.filter((log) => log.action === filters.action)
    }

    const actorId = filters?.actorId ?? filters?.adminId
    if (actorId) {
      filtered = filtered.filter((log) => log.actorId === actorId)
    }

    const resourceId = filters?.resourceId ?? filters?.targetUserId
    if (resourceId) {
      filtered = filtered.filter((log) => log.resourceId === resourceId)
    }

    if (filters?.resourceType) {
      filtered = filtered.filter((log) => log.resourceType === filters.resourceType)
    }

    if (filters?.status) {
      filtered = filtered.filter((log) => log.status === filters.status)
    }

    if (filters?.from) {
      const fromTime = new Date(filters.from).getTime()
      filtered = filtered.filter((log) => new Date(log.timestamp).getTime() >= fromTime)
    }

    if (filters?.to) {
      const toTime = new Date(filters.to).getTime()
      filtered = filtered.filter((log) => new Date(log.timestamp).getTime() <= toTime)
    }

    const ordered = [...filtered].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    )

    return {
      logs: ordered.slice(offset, offset + limit).map(cloneEntry),
      total: ordered.length,
    }
  }

  async getAll(): Promise<AuditLogEntry[]> {
    return this.logs.map(cloneEntry)
  }

  async clear(): Promise<void> {
    this.logs = []
  }
}
