import { pool } from '../../db/pool.js'
import {
  InMemoryAuditLogsRepository,
  PostgresAuditLogsRepository,
  type AuditLogPurgeResult,
  type AuditLogRepository,
} from '../../db/repositories/auditLogsRepository.js'
import {
  InMemoryAuditChainVerificationRepository,
  PostgresAuditChainVerificationRepository,
  type AuditChainVerificationRepository,
} from '../../db/repositories/auditChainVerificationRepository.js'
import { toChainVerificationState } from './chainStatus.js'
import { logger } from '../../utils/logger.js'
import { redact } from '../../observability/redaction.js'
import { LogEventType } from '../../observability/logSchemas.js'
import { computeRowHash } from '../../db/repositories/auditLogsRepository.js'
import type {
  AuditChainVerificationState,
  AuditLogEntry,
  AuditLogFilters,
  AuditLogInput,
  AuditStatus,
  ChainVerificationResult,
  ChainRepairAuthorization,
  ChainRepairMarker,
} from './types.js'
import { AuditAction } from './types.js'

/**
 * Audit log service for tracking admin actions.
 *
 * All entries are hash-chained: each row stores the SHA-256 of the preceding row
 * so that any tampering (mutation or deletion) is detectable by walking the chain.
 *
 * In production, this would write to a database or centralized logging system.
 */
export class AuditLogService {
  constructor(
    private readonly repository: AuditLogRepository = new InMemoryAuditLogsRepository(),
    private readonly chainStatusRepository: AuditChainVerificationRepository = new InMemoryAuditChainVerificationRepository(),
  ) {}

  /**
   * Log an admin action.
   *
   * The underlying repository computes the hash chain (prev_hash + row_hash)
   * inside the same transaction as the INSERT, so the chain is always consistent.
   * 
   * @param tenantId - Tenant ID for multi-tenant isolation (required)
   * @param adminId - ID of the admin performing the action
   * @param adminEmail - Email of the admin
   * @param action - Type of action being performed
   * @param targetUserId - ID of the target user (if applicable)
   * @param targetUserEmail - Email of the target user
   * @param details - Additional details about the action
   * @param status - Whether the action succeeded or failed
   * @param errorMessage - Error message if action failed
   * @param ipAddress - IP address of the requester
   * @returns The created audit log entry (including prevHash and rowHash)
   */
  async logAction(
    inputOrTenantId: AuditLogInput | string,
    actorId?: string,
    actorEmail?: string,
    action?: AuditAction | string,
    targetUserId?: string,
    targetUserEmail?: string,
    details?: Record<string, unknown>,
    status?: AuditStatus,
    errorMessage?: string,
    ipAddress?: string,
    requestId?: string,
  ): Promise<AuditLogEntry> {
    if (typeof inputOrTenantId !== 'string') {
      const entry = await this.repository.append(inputOrTenantId)
      this.logAuditEvent(entry)
      return entry
    }

    const tenantId = inputOrTenantId
    const effectiveAction = action ?? 'UNKNOWN_ACTION'
    const resourceType =
      effectiveAction === AuditAction.LIST_USERS || effectiveAction === AuditAction.EXPORT_AUDIT_LOGS
        ? 'admin_user'
        : effectiveAction === AuditAction.ROTATE_SIGNING_KEY
          ? 'system'
          : 'user'

    const mappedDetails: Record<string, unknown> = {
      ...(details ?? {}),
      ...(targetUserEmail ? { targetUserEmail } : {}),
    }

    const entry = await this.repository.append({
      tenantId,
      actorId: actorId ?? 'unknown',
      actorEmail: actorEmail ?? 'unknown@unknown',
      action: effectiveAction,
      resourceType,
      resourceId: targetUserId ?? actorId ?? 'unknown',
      details: mappedDetails,
      status,
      errorMessage,
      ipAddress,
      requestId,
    })
    this.logAuditEvent(entry)
    return entry
  }

  /**
   * Emit a schema-validated structured log line for a recorded audit entry.
   *
   * Every audit log line must carry tenantId so log aggregation can be
   * scoped per tenant; the allowlist schema for AUDIT_LOG_RECORDED drops
   * anything else (e.g. actorEmail, details) that isn't explicitly listed.
   */
  private logAuditEvent(entry: AuditLogEntry): void {
    const payload = {
      eventType: LogEventType.AUDIT_LOG_RECORDED,
      tenantId: entry.tenantId,
      action: entry.action,
      resourceType: entry.resourceType,
      status: entry.status,
      requestId: entry.requestId,
    }
    const redacted = redact(payload, { eventType: LogEventType.AUDIT_LOG_RECORDED })

    if (entry.status === 'failure') {
      logger.warn(redacted)
    } else {
      logger.info(redacted)
    }
  }

  /**
   * Append a batch of audit log entries while maintaining actor_id integrity.
   *
   * @param inputs - Array of audit log input objects
   * @returns Array of created audit log entries
   */
  async appendBatch(inputs: AuditLogInput[]): Promise<AuditLogEntry[]> {
    return this.repository.appendBatch(inputs)
  }

  /**
   * Log a batch of audit actions.
   * Alias for appendBatch.
   */
  async logBatch(inputs: AuditLogInput[]): Promise<AuditLogEntry[]> {
    return this.appendBatch(inputs)
  }

  /**
   * Get audit logs with optional filtering
   * 
   * SECURITY: Tenant scoping is DENY-BY-DEFAULT. Either tenantId or allowSuperScope must be provided.
   * 
   * @param filters - Optional filters for action, adminId, targetUserId, etc.
   * @param limit - Maximum number of logs to return (default: 100)
   * @param cursor - Pagination cursor
   * @param options - Additional options for tenant scoping
   * @returns Array of matching audit log entries and pagination metadata
   */
  async getLogs(
    tenantId: string | undefined,
    filters: AuditLogFilters = {},
    limit = 100,
    cursor?: string,
    options?: { allowSuperScope?: boolean }
  ): Promise<{ logs: AuditLogEntry[]; hasNextPage: boolean; nextCursor?: string }> {
    // SECURITY: Enforce tenant scoping - deny by default
    if (!tenantId && !options?.allowSuperScope) {
      throw new Error(
        'Tenant scoping required: either provide tenantId or explicitly enable allowSuperScope for privileged access'
      )
    }

    const effectiveTenantId = options?.allowSuperScope ? (filters.tenantId || tenantId) : tenantId
    return this.repository.query({ ...filters, tenantId: effectiveTenantId }, limit, cursor)
  }

  /**
   * Get all audit logs (for testing)
   * @returns All audit log entries
   */
  async getAllLogs(): Promise<AuditLogEntry[]> {
    return this.repository.getAll()
  }

  /**
   * Clear all logs (for testing)
   */
  async clearLogs(): Promise<void> {
    await this.repository.clear()
  }

  /**
   * Persist the audit chain verifier's last run result for operator visibility.
   */
  async saveChainVerificationStatus(result: ChainVerificationResult): Promise<AuditChainVerificationState> {
    return this.chainStatusRepository.saveStatus(toChainVerificationState(result))
  }

  /**
   * Read the durable last-run verifier state (null when the verifier has never run).
   */
  async getChainVerificationStatus(): Promise<AuditChainVerificationState | null> {
    return this.chainStatusRepository.getStatus()
  }

  /**
   * Reset persisted verifier state (for testing).
   */
  async clearChainVerificationStatus(): Promise<void> {
    await this.chainStatusRepository.clear()
  }

  /**
   * Verify the complete chain in deterministic sequence order.
   *
   * Verification fails closed for missing fields, broken links, malformed
   * details, and row-hash mismatches. The first broken sequence is reported so
   * operators can stop at the earliest trustworthy boundary.
   */
  async verifyChain(): Promise<ChainVerificationResult> {
    const checkedAt = new Date().toISOString()
    const violations: ChainVerificationResult['violations'] = []
    let logs: AuditLogEntry[]
    try {
      logs = await this.repository.getAll()
    } catch (error) {
      return {
        valid: false,
        rowsChecked: 0,
        firstViolationSeq: 1,
        violationCount: 1,
        violations: [{
          seq: 1,
          id: 'unreadable-chain',
          expectedPrevHash: null,
          actualPrevHash: null,
          expectedRowHash: '',
          actualRowHash: null,
          type: 'missing_row',
        }],
        checkedAt,
      }
    }

    const ordered = [...logs].sort((a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id))
    let previousHash: string | null = null
    let expectedSeq = ordered.length > 0 ? 1 : 0
    for (const entry of ordered) {
      const seq = entry.seq ?? expectedSeq
      const detailsJson = JSON.stringify(entry.details ?? {})
      const expectedHash = computeRowHash(
        previousHash,
        entry.id,
        entry.timestamp,
        entry.actorId,
        String(entry.action),
        entry.resourceType,
        entry.resourceId,
        detailsJson,
        entry.status,
        entry.tenantId,
        entry.requestId ?? '',
      )
      if (seq !== expectedSeq) {
        violations.push({
          seq: expectedSeq,
          id: entry.id,
          expectedPrevHash: previousHash,
          actualPrevHash: entry.prevHash ?? null,
          expectedRowHash: expectedHash,
          actualRowHash: entry.rowHash ?? null,
          type: 'missing_row',
        })
      }
      if ((entry.prevHash ?? null) !== previousHash) {
        violations.push({
          seq,
          id: entry.id,
          expectedPrevHash: previousHash,
          actualPrevHash: entry.prevHash ?? null,
          expectedRowHash: expectedHash,
          actualRowHash: entry.rowHash ?? null,
          type: 'prev_hash_mismatch',
        })
      }
      if (!entry.rowHash || entry.rowHash !== expectedHash) {
        violations.push({
          seq,
          id: entry.id,
          expectedPrevHash: previousHash,
          actualPrevHash: entry.prevHash ?? null,
          expectedRowHash: expectedHash,
          actualRowHash: entry.rowHash ?? null,
          type: 'row_hash_mismatch',
        })
      }
      previousHash = entry.rowHash ?? null
      expectedSeq = seq + 1
    }
    const first = violations[0]
    const result: ChainVerificationResult = {
      valid: violations.length === 0,
      rowsChecked: ordered.length,
      lastCheckedSeq: ordered.length > 0 ? (ordered[ordered.length - 1].seq ?? ordered.length) : 0,
      firstViolationSeq: first?.seq,
      firstViolationId: first?.id,
      violationCount: violations.length,
      violations,
      checkedAt,
    }
    await this.saveChainVerificationStatus(result)
    return result
  }

  /**
   * Append an explicit, non-destructive repair marker. Historical rows are
   * never overwritten; the marker records the operator authorization and reason.
   */
  async requestChainRepair(
    tenantId: string,
    authorization: ChainRepairAuthorization,
  ): Promise<ChainRepairMarker> {
    if (!tenantId || !authorization.operatorId || !authorization.approvedBy ||
        !authorization.authorizationRef || !authorization.reason) {
      throw new Error('Explicit repair authorization, approval, reference, and reason are required')
    }
    const marker = await this.logAction({
      tenantId,
      actorId: authorization.operatorId,
      actorEmail: `${authorization.operatorId}@repair.invalid`,
      action: AuditAction.CHAIN_REPAIR_REQUESTED,
      resourceType: 'audit_chain',
      resourceId: authorization.authorizationRef,
      details: {
        approvedBy: authorization.approvedBy,
        authorizationRef: authorization.authorizationRef,
        reason: authorization.reason,
        mode: 'append-only-marker',
      },
      status: 'success',
    })
    return { marker, authorization }
  }

  /**
   * Stream audit logs as an AsyncGenerator to avoid memory spikes
   * Applies date filtering and redacts sensitive information compliance policy
   * 
   * SECURITY: Tenant scoping is DENY-BY-DEFAULT. Either tenantId or allowSuperScope must be provided.
   * 
   * @param startDate - Start date (inclusive)
   * @param endDate - End date (inclusive)
   * @param tenantId - Tenant ID for scoped export (required unless allowSuperScope is true)
   * @param options - Additional options for tenant scoping
   */
  async *exportLogsStream(
    startDate: Date,
    endDate: Date,
    tenantId?: string,
    options?: {
      /** Allow super-admin to export across all tenants. Must be explicitly set to true. */
      allowSuperScope?: boolean
    }
  ): AsyncGenerator<AuditLogEntry> {
    this.assertExportScope(tenantId, options)

    const filters: AuditLogFilters = {
      from: startDate.toISOString(),
      to: endDate.toISOString(),
    }

    for await (const log of this.paginateLogs(tenantId, filters, options)) {
      yield this.redactLogEntry(log)
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  private assertExportScope(
    tenantId?: string,
    options?: { allowSuperScope?: boolean },
  ): void {
    if (!tenantId && !options?.allowSuperScope) {
      throw new Error(
        'Tenant scoping required: either provide tenantId or explicitly enable allowSuperScope for privileged access'
      )
    }
  }

  private async *paginateLogs(
    tenantId: string | undefined,
    filters: AuditLogFilters,
    options?: { allowSuperScope?: boolean },
    pageSize = 500,
  ): AsyncGenerator<AuditLogEntry> {
    let cursor: string | undefined
    while (true) {
      const page = await this.getLogs(tenantId, filters, pageSize, cursor, options)
      for (const log of page.logs) {
        yield log
      }
      if (!page.hasNextPage || !page.nextCursor) {
        break
      }
      cursor = page.nextCursor
    }
  }

  /**
   * Redact sensitive fields for compliance export
   */
  private redactLogEntry(entry: AuditLogEntry): AuditLogEntry {
    const redacted = { ...entry }
    
    // Mask emails: preserve first character and domain
    const maskEmail = (email: string) => {
      if (!email || !email.includes('@')) return '***@***'
      const [local, domain] = email.split('@')
      const maskedLocal = local.length > 1 ? `${local[0]}***` : '***'
      return `${maskedLocal}@${domain}`
    }

    if (redacted.adminEmail) {
      redacted.adminEmail = maskEmail(redacted.adminEmail)
    }
    if (redacted.targetUserEmail) {
      redacted.targetUserEmail = maskEmail(redacted.targetUserEmail)
    }

    // Mask IP address: mask last octet if IPv4
    if (redacted.ipAddress) {
      const parts = redacted.ipAddress.split('.')
      if (parts.length === 4) {
        parts[3] = '***'
        redacted.ipAddress = parts.join('.')
      }
    }

    return redacted
  }

  /**
   * Purge audit log entries older than the specified number of days.
   *
   * Enforces the retention policy by deleting entries whose `occurred_at`
   * timestamp is before the cutoff boundary (NOW() - olderThanDays days).
   *
   * Security: Tenant-scoped by default. When no tenant ID is provided and
   * allowSuperScope is not explicitly set, the call throws.
   *
   * @param olderThanDays - Retention window in days. Entries older than this are purged. 0 = keep forever.
   * @param options - Optional controls
   * @param options.batchSize - Max entries to delete per batch (default: 5000)
   * @param options.tenantId - Scope purge to a single tenant
   * @param options.dryRun - Count but don't delete
   * @param options.allowSuperScope - Allow cross-tenant purge (must be explicitly true)
   */
  async purgeExpired(
    olderThanDays: number,
    options?: {
      batchSize?: number
      tenantId?: string
      dryRun?: boolean
      allowSuperScope?: boolean
    }
  ): Promise<AuditLogPurgeResult> {
    if (!options?.tenantId && !options?.allowSuperScope) {
      throw new Error(
        'Tenant scoping required: either provide tenantId or explicitly enable allowSuperScope for privileged access'
      )
    }

    return this.repository.purgeExpired(olderThanDays, {
      batchSize: options?.batchSize,
      tenantId: options?.tenantId,
      dryRun: options?.dryRun,
    })
  }

  /**
   * Get top N talker tenants by request count in the last window (default: 1 hour).
   */
  async getTopTalkers(
    limit?: number,
    windowMinutes?: number,
    now?: Date,
  ) {
    return this.repository.getTopTalkers(limit, windowMinutes, now)
  }
}

function createRepository(): AuditLogRepository {
  const shouldUsePostgres = process.env.AUDIT_LOG_BACKEND === 'postgres'
  if (!shouldUsePostgres) {
    return new InMemoryAuditLogsRepository()
  }

  return new PostgresAuditLogsRepository(pool)
}

function createChainStatusRepository(): AuditChainVerificationRepository {
  const shouldUsePostgres = process.env.AUDIT_LOG_BACKEND === 'postgres'
  if (!shouldUsePostgres) {
    return new InMemoryAuditChainVerificationRepository()
  }

  return new PostgresAuditChainVerificationRepository(pool)
}

// Create a singleton instance
export const auditLogService = new AuditLogService(createRepository(), createChainStatusRepository())

export { AuditAction } from './types.js'
export type {
  AuditChainVerificationState,
  AuditLogEntry,
  AuditLogInput,
  AuditLogFilters,
  ChainVerificationResult,
  ChainRepairAuthorization,
  ChainRepairMarker,
  TopTalkerEntry,
  TopTalkersReport,
} from './types.js'
export type { AuditLogPurgeResult } from '../../db/repositories/auditLogsRepository.js'
export * from './serviceAccountAudit.js'
