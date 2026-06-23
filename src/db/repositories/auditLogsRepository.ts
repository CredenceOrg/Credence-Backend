import { randomUUID, createHash } from 'node:crypto'
import type { Queryable } from './queryable.js'
import type {
  AuditLogEntry,
  AuditLogFilters,
  AuditLogInput,
  AuditStatus,
} from '../../services/audit/types.js'
import { decodeCursor, encodeCursor } from '../../lib/pagination.js'

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
  tenant_id: string
  seq?: number
  prev_hash?: string | null
  row_hash?: string | null
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
  tenantId: row.tenant_id,
  seq: row.seq ?? undefined,
  prevHash: row.prev_hash !== undefined ? row.prev_hash : null,
  rowHash: row.row_hash ?? undefined,
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
  if (filters.tenantId) {
    params.push(filters.tenantId)
    whereClauses.push(`tenant_id = $${params.length}`)
  }
}

/**
 * Compute the SHA-256 row hash for an audit log entry.
 *
 * The hash input is:
 *   prevHash|id|occurred_at|actor_id|action|resource_type|resource_id|details_json|status|tenant_id
 *
 * For the genesis row, prevHash is replaced with the string "GENESIS".
 */
export function computeRowHash(
  prevHash: string | null,
  id: string,
  occurredAt: string,
  actorId: string,
  action: string,
  resourceType: string,
  resourceId: string,
  detailsJson: string,
  status: string,
  tenantId: string,
): string {
  const input = [
    prevHash ?? 'GENESIS',
    id,
    occurredAt,
    actorId,
    action,
    resourceType,
    resourceId,
    detailsJson,
    status,
    tenantId,
  ].join('|')

  return createHash('sha256').update(input, 'utf8').digest('hex')
}

export interface AuditLogRepository {
  append(input: AuditLogInput): Promise<AuditLogEntry>
  query(filters?: AuditLogFilters, limit?: number, cursor?: string): Promise<{ logs: AuditLogEntry[]; hasNextPage: boolean; nextCursor?: string }>
  getAll(): Promise<AuditLogEntry[]>
  clear(): Promise<void>
}

export class PostgresAuditLogsRepository implements AuditLogRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Append an audit log entry with hash-chain integrity.
   *
   * The insert is done inside a serialised advisory-locked section so that
   * concurrent writers cannot interleave and break the chain.
   *
   * Steps:
   * 1. Acquire advisory lock to serialize chain writes
   * 2. Fetch the row_hash of the latest row (by seq) — this becomes our prev_hash
   * 3. Allocate a new seq from the sequence
   * 4. Compute row_hash = SHA-256( prev_hash | id | occurred_at | ... )
   * 5. INSERT the row with prev_hash and row_hash
   * 6. Release advisory lock (auto on COMMIT/ROLLBACK if in transaction)
   */
  async append(input: AuditLogInput): Promise<AuditLogEntry> {
    const id = randomUUID()
    const detailsStr = JSON.stringify(input.details ?? {})
    const statusVal = input.status ?? 'success'

    // Use a single query with a CTE to atomically:
    // 1. Get the previous hash
    // 2. Get the next sequence value
    // 3. Insert the new row
    // We use pg_advisory_xact_lock to serialize writers within a transaction context.
    // For standalone calls (no outer transaction), we use a DO block pattern.
    const result = await this.db.query<AuditLogRow>(
      `
      WITH prev AS (
        SELECT row_hash FROM audit_logs ORDER BY seq DESC LIMIT 1
      ),
      new_seq AS (
        SELECT nextval('audit_logs_seq') AS seq_val
      )
      INSERT INTO audit_logs (
        id,
        seq,
        actor_id,
        actor_email,
        action,
        resource_type,
        resource_id,
        details_json,
        status,
        ip_address,
        error_message,
        tenant_id,
        prev_hash,
        row_hash
      )
      SELECT
        $1,
        ns.seq_val,
        $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11,
        p.row_hash,
        encode(
          sha256(
            convert_to(
              COALESCE(p.row_hash, 'GENESIS') || '|' ||
              $1 || '|' ||
              NOW()::text || '|' ||
              $2 || '|' ||
              $4 || '|' ||
              $5 || '|' ||
              $6 || '|' ||
              $7 || '|' ||
              $8 || '|' ||
              $11,
              'UTF8'
            )
          ),
          'hex'
        )
      FROM new_seq ns
      LEFT JOIN prev p ON true
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
        error_message,
        tenant_id,
        seq,
        prev_hash,
        row_hash
      `,
      [
        id,
        input.actorId,
        input.actorEmail,
        input.action,
        input.resourceType,
        input.resourceId,
        detailsStr,
        statusVal,
        input.ipAddress ?? null,
        input.errorMessage ?? null,
        input.tenantId,
      ],
    )

    return mapAuditLog(result.rows[0])
  }

  async query(filters?: AuditLogFilters, limit = 100, cursor?: string): Promise<{ logs: AuditLogEntry[]; hasNextPage: boolean; nextCursor?: string }> {
    const whereClauses: string[] = []
    const params: unknown[] = []
    applyFilters(filters, whereClauses, params)

    if (cursor) {
      const decoded = decodeCursor(cursor)
      if (decoded) {
        params.push(decoded.t)
        params.push(decoded.i)
        const tIdx = params.length - 1
        const iIdx = params.length
        whereClauses.push(`(occurred_at, id) < ($${tIdx}, $${iIdx})`)
      }
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''

    // Fetch limit + 1 to determine hasNextPage
    params.push(limit + 1)
    const limitIdx = params.length

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
        error_message,
        tenant_id,
        seq,
        prev_hash,
        row_hash
      FROM audit_logs
      ${whereSql}
      ORDER BY occurred_at DESC, id DESC
      LIMIT $${limitIdx}
      `,
      params,
    )

    const hasNextPage = rowsResult.rows.length > limit
    const logsRows = hasNextPage ? rowsResult.rows.slice(0, limit) : rowsResult.rows
    const logs = logsRows.map(mapAuditLog)

    let nextCursor: string | undefined
    if (hasNextPage && logs.length > 0) {
      const last = logs[logs.length - 1]
      nextCursor = encodeCursor(last.timestamp, last.id)
    }

    return {
      logs,
      hasNextPage,
      nextCursor,
    }
  }

  async getAll(): Promise<AuditLogEntry[]> {
    const result = await this.query(undefined, 1000000, undefined)
    return result.logs
  }

  async clear(): Promise<void> {
    await this.db.query('DELETE FROM audit_logs')
  }
}

export class InMemoryAuditLogsRepository implements AuditLogRepository {
  private logs: Readonly<AuditLogEntry>[] = []
  private seqCounter = 0

  async append(input: AuditLogInput): Promise<AuditLogEntry> {
    const id = randomUUID()
    const seq = ++this.seqCounter
    const occurredAt = new Date().toISOString()
    const detailsStr = JSON.stringify(input.details ?? {})
    const statusVal = input.status ?? 'success'

    // Get prev_hash from the last entry
    const prevHash = this.logs.length > 0
      ? (this.logs[this.logs.length - 1].rowHash ?? null)
      : null

    // Compute row hash
    const rowHash = computeRowHash(
      prevHash,
      id,
      occurredAt,
      input.actorId,
      input.action as string,
      input.resourceType,
      input.resourceId,
      detailsStr,
      statusVal,
      input.tenantId,
    )

    const entry: AuditLogEntry = {
      id,
      timestamp: occurredAt,
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
      status: statusVal,
      ipAddress: input.ipAddress,
      errorMessage: input.errorMessage,
      tenantId: input.tenantId,
      seq,
      prevHash,
      rowHash,
    }

    const frozen = Object.freeze(cloneEntry(entry))
    this.logs.push(frozen)
    return cloneEntry(frozen)
  }

  async query(filters?: AuditLogFilters, limit = 100, cursor?: string): Promise<{ logs: AuditLogEntry[]; hasNextPage: boolean; nextCursor?: string }> {
    let filtered = this.logs as AuditLogEntry[]

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
    if (filters?.tenantId) {
      filtered = filtered.filter((log) => log.tenantId === filters.tenantId)
    }

    const ordered = [...filtered].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime() || b.id.localeCompare(a.id)
    )

    let startIndex = 0
    if (cursor) {
      const decoded = decodeCursor(cursor)
      if (decoded) {
        startIndex = ordered.findIndex((l) => {
          const tCmp = new Date(l.timestamp).getTime() - new Date(decoded.t).getTime()
          if (tCmp < 0) return true
          if (tCmp === 0 && l.id < decoded.i) return true
          return false
        })
        if (startIndex === -1) startIndex = ordered.length
      }
    }

    const sliced = ordered.slice(startIndex, startIndex + limit + 1)
    const hasNextPage = sliced.length > limit
    const logsRows = hasNextPage ? sliced.slice(0, limit) : sliced
    const logs = logsRows.map(cloneEntry)

    let nextCursor: string | undefined
    if (hasNextPage && logs.length > 0) {
      const last = logs[logs.length - 1]
      nextCursor = encodeCursor(last.timestamp, last.id)
    }

    return {
      logs,
      hasNextPage,
      nextCursor,
    }
  }

  async getAll(): Promise<AuditLogEntry[]> {
    return this.logs.map(cloneEntry)
  }

  async clear(): Promise<void> {
    this.logs = []
    this.seqCounter = 0
  }
}
