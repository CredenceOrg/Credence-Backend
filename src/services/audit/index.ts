import { pool } from '../../db/pool.js'
import {
  InMemoryAuditLogsRepository,
  PostgresAuditLogsRepository,
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
import type {
  AuditChainVerificationState,
  AuditLogEntry,
  AuditLogFilters,
  AuditLogInput,
  AuditStatus,
  ChainVerificationResult,
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
  TopTalkerEntry,
  TopTalkersReport,
} from './types.js'
export * from './serviceAccountAudit.js'

