import { randomUUID, createHash } from 'node:crypto'
import type { Queryable } from './queryable.js'
import type {
  AuditLogEntry,
  AuditLogFilters,
  AuditLogInput,
  AuditStatus,
  TopTalkerEntry,
  TopTalkersReport,
} from '../../services/audit/types.js'
import { decodeCursor, encodeCursor } from '../../lib/pagination.js'
import {
  DEFAULT_TOP_TALKERS_LIMIT,
  MAX_TOP_TALKERS_LIMIT,
  DEFAULT_TOP_TALKERS_WINDOW_MINUTES,
} from '../../config/constants.js'

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
  request_id: string | null
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
  requestId: row.request_id ?? undefined,
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
  requestId: string = '',
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
    requestId,
  ].join('|')

  return createHash('sha256').update(input, 'utf8').digest('hex')
}

const resolveActorId = (input: AuditLogInput): string =>
  input.actorId ??
  (input as unknown as { actor_id?: string }).actor_id ??
  (input as unknown as { adminId?: string }).adminId ??
  'unknown'

const resolveActorEmail = (input: AuditLogInput): string =>
  input.actorEmail ??
  (input as unknown as { actor_email?: string }).actor_email ??
  (input as unknown as { adminEmail?: string }).adminEmail ??
  'unknown@unknown'

/**
 * Result of a retention purge operation on audit log entries.
 */
export interface AuditLogPurgeResult {
  /** Number of expired entries identified before the purge. */
  expiredCount: number
  /** Number of entries actually deleted. */
  deletedCount: number
  /** Whether the operation was a dry run (no actual deletions). */
  dryRun: boolean
  /** The TTL threshold in days that was used. */
  ttlDays: number
  /** Optional tenant ID scope applied to the purge. */
  tenantId?: string
}

export interface AuditLogRepository {
  append(input: AuditLogInput): Promise<AuditLogEntry>
  appendBatch(inputs: AuditLogInput[]): Promise<AuditLogEntry[]>
  query(filters?: AuditLogFilters, limit?: number, cursor?: string): Promise<{ logs: AuditLogEntry[]; hasNextPage: boolean; nextCursor?: string }>
  getTopTalkers(limit?: number, windowMinutes?: number, now?: Date): Promise<TopTalkersReport>
  getAll(): Promise<AuditLogEntry[]>
  clear(): Promise<void>
  /**
   * Purge audit log entries older than the specified number of days.
   *
   * Security: this operation is tenant-scoped. When `tenantId` is provided,
   * only entries belonging to that tenant are purged; otherwise all tenants
   * are included (requires privileged access).
   *
   * @param olderThanDays - Delete entries with `occurred_at` earlier than
   *   NOW() - olderThanDays days. A value of 0 means "keep forever" and
   *   returns zero counts without deleting anything.
   * @param options - Optional controls for batch size, tenant scoping, and
   *   dry-run mode.
   */
  purgeExpired(
    olderThanDays: number,
    options?: { batchSize?: number; tenantId?: string; dryRun?: boolean }
  ): Promise<AuditLogPurgeResult>
}

export class PostgresAuditLogsRepository implements AuditLogRepository {
  constructor(private readonly db: Queryable) {}

  async append(input: AuditLogInput): Promise<AuditLogEntry> {
    if (!input.tenantId) {
      throw new Error('AuditLogRepository.append requires tenantId for tenant isolation')
    }
    const id = randomUUID()
    const actorId = resolveActorId(input)
    const actorEmail = resolveActorEmail(input)
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
      WITH locked AS (
        SELECT true AS locked
        FROM pg_advisory_xact_lock(hashtext('audit_logs_append_lock'))
      ),
      prev AS (
        SELECT row_hash FROM audit_logs
        WHERE (SELECT locked FROM locked)
        ORDER BY seq DESC LIMIT 1
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
        request_id,
        prev_hash,
        row_hash
      )
      SELECT
        $1,
        ns.seq_val,
        $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12,
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
              $11 || '|' ||
              COALESCE($12, ''),
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
        request_id,
        seq,
        prev_hash,
        row_hash
      `,
      [
        id,
        actorId,
        actorEmail,
        input.action,
        input.resourceType,
        input.resourceId,
        detailsStr,
        statusVal,
        input.ipAddress ?? null,
        input.errorMessage ?? null,
        input.tenantId,
        input.requestId ?? null,
      ],
    )

    return mapAuditLog(result.rows[0])
  }

  async appendBatch(inputs: AuditLogInput[]): Promise<AuditLogEntry[]> {
    const n = inputs.length
    if (n === 0) return []
    if (n === 1) return [await this.append(inputs[0])]

    const params: unknown[] = []
    const ctes: string[] = []

    for (let i = 0; i < n; i++) {
      const input = inputs[i]
      const base = params.length
      params.push(
        randomUUID(),
        resolveActorId(input),
        resolveActorEmail(input),
        input.action,
        input.resourceType,
        input.resourceId,
        JSON.stringify(input.details ?? {}),
        input.status ?? 'success',
        input.ipAddress ?? null,
        input.errorMessage ?? null,
        input.tenantId,
        input.requestId ?? null,
      )

      const p = (offset: number) => `$${base + offset + 1}`
      const prevSrc = i === 0
        ? '(SELECT COALESCE(row_hash, \'GENESIS\') FROM audit_logs ORDER BY seq DESC LIMIT 1)'
        : `(SELECT row_hash FROM ins${i})`

      ctes.push(`ins${i + 1} AS (
  INSERT INTO audit_logs (
    id, seq, actor_id, actor_email, action, resource_type, resource_id,
    details_json, status, ip_address, error_message, tenant_id, request_id,
    prev_hash, row_hash
  )
  SELECT
    ${p(0)}::uuid,
    nextval('audit_logs_seq'),
    ${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)},
    ${p(6)}::jsonb, ${p(7)}, ${p(8)}, ${p(9)}, ${p(10)}, ${p(11)},
    COALESCE(${prevSrc}, 'GENESIS'),
    encode(
      sha256(
        convert_to(
          COALESCE(${prevSrc}, 'GENESIS') || '|' ||
          ${p(0)}::text || '|' ||
          NOW()::text || '|' ||
          ${p(1)} || '|' ||
          ${p(3)} || '|' ||
          ${p(4)} || '|' ||
          ${p(5)} || '|' ||
          ${p(6)} || '|' ||
          ${p(7)} || '|' ||
          ${p(10)} || '|' ||
          COALESCE(${p(11)}, ''),
          'UTF8'
        )
      ),
      'hex'
    )
  RETURNING
    id, occurred_at, actor_id, actor_email, action, resource_type, resource_id,
    details_json, status, ip_address, error_message, tenant_id, request_id,
    seq, prev_hash, row_hash
)`)
    }

    const selects = Array.from({ length: n }, (_, i) => `SELECT * FROM ins${i + 1}`)
    const sql = `WITH\n${ctes.join(',\n')}\n${selects.join('\nUNION ALL\n')}\nORDER BY seq ASC`

    const result = await this.db.query<AuditLogRow>(sql, params)
    return result.rows.map(mapAuditLog)
  }

  async query(filters?: AuditLogFilters, limit = 100, cursor?: string): Promise<{ logs: AuditLogEntry[]; hasNextPage: boolean; nextCursor?: string }> {
    if (!filters?.tenantId) {
      throw new Error('AuditLogRepository.query requires tenantId for tenant isolation')
    }
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
        request_id,
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

  async getTopTalkers(
    limit = DEFAULT_TOP_TALKERS_LIMIT,
    windowMinutes = DEFAULT_TOP_TALKERS_WINDOW_MINUTES,
    now = new Date(),
  ): Promise<TopTalkersReport> {
    const effectiveLimit = Math.min(Math.max(1, limit), MAX_TOP_TALKERS_LIMIT)
    const windowEnd = now
    const windowStart = new Date(now.getTime() - windowMinutes * 60 * 1000)

    const totalResult = await this.db.query<{ total: string | number }>(
      `SELECT COUNT(*)::int AS total FROM audit_logs WHERE occurred_at >= $1 AND occurred_at <= $2`,
      [windowStart.toISOString(), windowEnd.toISOString()],
    )
    const totalRequests = Number(totalResult.rows[0]?.total ?? 0)

    const topResult = await this.db.query<{
      tenant_id: string
      request_count: string | number
      last_request_at: Date | string
    }>(
      `
      SELECT
        tenant_id,
        COUNT(*)::int AS request_count,
        MAX(occurred_at) AS last_request_at
      FROM audit_logs
      WHERE occurred_at >= $1 AND occurred_at <= $2
      GROUP BY tenant_id
      ORDER BY request_count DESC, tenant_id ASC
      LIMIT $3
      `,
      [windowStart.toISOString(), windowEnd.toISOString(), effectiveLimit],
    )

    const topTalkers: TopTalkerEntry[] = topResult.rows.map((row) => {
      const count = Number(row.request_count)
      const pct = totalRequests > 0 ? Number(((count / totalRequests) * 100).toFixed(2)) : 0
      const lastAt = row.last_request_at ? new Date(row.last_request_at).toISOString() : undefined
      return {
        tenantId: row.tenant_id,
        requestCount: count,
        percentage: pct,
        lastRequestAt: lastAt,
      }
    })

    return {
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      windowMinutes,
      totalRequests,
      topTalkers,
    }
  }

  async getAll(): Promise<AuditLogEntry[]> {
    const result = await this.query(undefined, 1000000, undefined)
    return result.logs
  }

  async clear(): Promise<void> {
    await this.db.query('DELETE FROM audit_logs')
  }

  async purgeExpired(
    olderThanDays: number,
    options?: { batchSize?: number; tenantId?: string; dryRun?: boolean },
  ): Promise<AuditLogPurgeResult> {
    // 0 means keep forever — no purging
    if (olderThanDays === 0) {
      return { expiredCount: 0, deletedCount: 0, dryRun: options?.dryRun ?? false, ttlDays: 0, tenantId: options?.tenantId }
    }

    const batchSize = options?.batchSize ?? 5_000
    const dryRun = options?.dryRun ?? false
    const tenantId = options?.tenantId

    // Count expired entries
    const countParams: unknown[] = [olderThanDays]
    let countSql = `SELECT COUNT(*)::int AS cnt FROM audit_logs
       WHERE occurred_at < NOW() - ($1 || ' days')::interval`
    if (tenantId) {
      countParams.push(tenantId)
      countSql += ` AND tenant_id = $2`
    }

    const countResult = await this.db.query<{ cnt: number }>(countSql, countParams)
    const expiredCount = Number(countResult.rows[0]?.cnt ?? 0)

    if (dryRun || expiredCount === 0) {
      return { expiredCount, deletedCount: 0, dryRun, ttlDays: olderThanDays, tenantId }
    }

    // Delete in a batched CTE to avoid long-running transactions.
    // Loop with a guard: maxIterations = ceil(expiredCount/batchSize) + 1.
    // The +1 handles the final iteration where deleted < batchSize triggers
    // the break. If new rows expire between COUNT and the final DELETE, they
    // won't be captured this run — that's intentional; the next scheduled run
    // will pick them up.
    const deleteParams: unknown[] = [olderThanDays, batchSize]
    let orgFilter = ''
    if (tenantId) {
      deleteParams.push(tenantId)
      orgFilter = ` AND tenant_id = $3`
    }

    // Loop until no more expired rows or batch limit is reached in aggregate
    let totalDeleted = 0
    const maxIterations = Math.ceil(expiredCount / batchSize) + 1
    for (let i = 0; i < maxIterations; i++) {
      const result = await this.db.query<{ cnt: number }>(
        `WITH rows AS (
           SELECT id FROM audit_logs
           WHERE occurred_at < NOW() - ($1 || ' days')::interval${orgFilter}
           LIMIT $2
         )
         DELETE FROM audit_logs WHERE id IN (SELECT id FROM rows)
         RETURNING 1`,
        deleteParams,
      )
      const deleted = result.rowCount ?? 0
      totalDeleted += deleted
      if (deleted < batchSize) break
    }

    return {
      expiredCount,
      deletedCount: totalDeleted,
      dryRun: false,
      ttlDays: olderThanDays,
      tenantId,
    }
  }
}

export class InMemoryAuditLogsRepository implements AuditLogRepository {
  private logs: Readonly<AuditLogEntry>[] = []
  private seqCounter = 0

  async append(input: AuditLogInput): Promise<AuditLogEntry> {
    const id = randomUUID()
    const actorId = resolveActorId(input)
    const actorEmail = resolveActorEmail(input)
    const seq = ++this.seqCounter
    const occurredAt = input.occurredAt ?? new Date().toISOString()
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
      actorId,
      input.action as string,
      input.resourceType,
      input.resourceId,
      detailsStr,
      statusVal,
      input.tenantId,
      input.requestId ?? '',
    )

    const entry: AuditLogEntry = {
      id,
      timestamp: occurredAt,
      actorId,
      actorEmail,
      adminId: actorId,
      adminEmail: actorEmail,
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
      requestId: input.requestId,
      seq,
      prevHash,
      rowHash,
    }

    const frozen = Object.freeze(cloneEntry(entry))
    this.logs.push(frozen)
    return cloneEntry(frozen)
  }

  async appendBatch(inputs: AuditLogInput[]): Promise<AuditLogEntry[]> {
    const entries: AuditLogEntry[] = []
    for (const input of inputs) {
      const entry = await this.append(input)
      entries.push(entry)
    }
    return entries
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

  async getTopTalkers(
    limit = DEFAULT_TOP_TALKERS_LIMIT,
    windowMinutes = DEFAULT_TOP_TALKERS_WINDOW_MINUTES,
    now = new Date(),
  ): Promise<TopTalkersReport> {
    const effectiveLimit = Math.min(Math.max(1, limit), MAX_TOP_TALKERS_LIMIT)
    const windowEnd = now
    const windowStart = new Date(now.getTime() - windowMinutes * 60 * 1000)

    const matching = this.logs.filter((log) => {
      const t = new Date(log.timestamp).getTime()
      return t >= windowStart.getTime() && t <= windowEnd.getTime()
    })

    const totalRequests = matching.length
    const tenantMap = new Map<string, { count: number; lastAt: string }>()

    for (const log of matching) {
      const existing = tenantMap.get(log.tenantId)
      if (existing) {
        existing.count++
        if (log.timestamp > existing.lastAt) {
          existing.lastAt = log.timestamp
        }
      } else {
        tenantMap.set(log.tenantId, { count: 1, lastAt: log.timestamp })
      }
    }

    const sorted = Array.from(tenantMap.entries())
      .map(([tenantId, { count, lastAt }]) => ({
        tenantId,
        requestCount: count,
        percentage: totalRequests > 0 ? Number(((count / totalRequests) * 100).toFixed(2)) : 0,
        lastRequestAt: lastAt,
      }))
      .sort((a, b) => b.requestCount - a.requestCount || a.tenantId.localeCompare(b.tenantId))
      .slice(0, effectiveLimit)

    return {
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      windowMinutes,
      totalRequests,
      topTalkers: sorted,
    }
  }

  async getAll(): Promise<AuditLogEntry[]> {
    return this.logs.map(cloneEntry)
  }

  async clear(): Promise<void> {
    this.logs = []
    this.seqCounter = 0
  }

  async purgeExpired(
    olderThanDays: number,
    options?: { batchSize?: number; tenantId?: string; dryRun?: boolean },
  ): Promise<AuditLogPurgeResult> {
    // 0 means keep forever — no purging
    if (olderThanDays === 0) {
      return { expiredCount: 0, deletedCount: 0, dryRun: options?.dryRun ?? false, ttlDays: 0, tenantId: options?.tenantId }
    }

    const batchSize = options?.batchSize ?? 5_000
    const dryRun = options?.dryRun ?? false
    const tenantId = options?.tenantId
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000)

    // Find expired entries (occurred_at before cutoff)
    const expiredIndices: number[] = []
    for (let i = 0; i < this.logs.length; i++) {
      const entry = this.logs[i]
      if (new Date(entry.timestamp) < cutoff) {
        if (!tenantId || entry.tenantId === tenantId) {
          expiredIndices.push(i)
        }
      }
    }

    const expiredCount = expiredIndices.length

    if (dryRun || expiredCount === 0) {
      return { expiredCount, deletedCount: 0, dryRun, ttlDays: olderThanDays, tenantId }
    }

    // Delete up to batchSize entries (oldest first)
    const deleteCount = Math.min(expiredCount, batchSize)
    const indicesToDelete = new Set(expiredIndices.slice(0, deleteCount))
    this.logs = this.logs.filter((_, i) => !indicesToDelete.has(i))

    return {
      expiredCount,
      deletedCount: deleteCount,
      dryRun: false,
      ttlDays: olderThanDays,
      tenantId,
    }
  }
}
