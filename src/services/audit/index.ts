import { pool } from '../../db/pool.js'
import {
  InMemoryAuditLogsRepository,
  PostgresAuditLogsRepository,
  type AuditLogRepository,
} from '../../db/repositories/auditLogsRepository.js'
import type { AuditLogEntry, AuditLogFilters, AuditLogInput, AuditStatus } from './types.js'
import { AuditAction } from './types.js'

/**
 * Audit log service for tracking admin actions
 * In production, this would write to a database or centralized logging system
 */
export class AuditLogService {
  constructor(private readonly repository: AuditLogRepository) {}

  /**
   * Log an admin action
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
   * @returns The created audit log entry
   */
  async logAction(
    inputOrActorId: AuditLogInput | string,
    actorEmail?: string,
    action?: AuditAction | string,
    targetUserId?: string,
    targetUserEmail?: string,
    details?: Record<string, unknown>,
    status?: AuditStatus,
    errorMessage?: string,
    ipAddress?: string,
  ): Promise<AuditLogEntry> {
    if (typeof inputOrActorId !== 'string') {
      return this.repository.append(inputOrActorId)
    }

    const actorId = inputOrActorId
    const effectiveAction = action ?? 'UNKNOWN_ACTION'
    const resourceType =
      effectiveAction === AuditAction.LIST_USERS || effectiveAction === AuditAction.EXPORT_AUDIT_LOGS
        ? 'admin_user'
        : 'user'

    const mappedDetails: Record<string, unknown> = {
      ...(details ?? {}),
      ...(targetUserEmail ? { targetUserEmail } : {}),
    }

    return this.repository.append({
      actorId,
      actorEmail: actorEmail ?? 'unknown@unknown',
      action: effectiveAction,
      resourceType,
      resourceId: targetUserId ?? actorId,
      details: mappedDetails,
      status,
      errorMessage,
      ipAddress,
    })
  }

  /**
   * Get audit logs with optional filtering
   * 
   * SECURITY: Tenant scoping is DENY-BY-DEFAULT. Either tenantId or allowSuperScope must be provided.
   * 
   * @param filters - Optional filters for action, adminId, targetUserId, etc.
   * @param limit - Maximum number of logs to return (default: 100)
   * @param offset - Pagination offset (default: 0)
   * @param options - Additional options for tenant scoping
   * @returns Array of matching audit log entries and total count
   */
  async getLogs(
    filters?: AuditLogFilters,
    limit = 100,
    offset = 0
  ): Promise<{ logs: AuditLogEntry[]; total: number }> {
    return this.repository.query(filters, limit, offset)
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
    // SECURITY: Enforce tenant scoping - deny by default
    if (!tenantId && !options?.allowSuperScope) {
      throw new Error(
        'Tenant scoping required: either provide tenantId or explicitly enable allowSuperScope for privileged access'
      )
    }

    const startMs = startDate.getTime()
    const endMs = endDate.getTime()

    const logs = await this.getAllLogs()
    for (const log of logs) {
      const logTime = new Date(log.timestamp).getTime()
      
      // Apply tenant filter if provided (not in super-scope mode)
      if (tenantId && log.tenantId !== tenantId) {
        continue
      }
      
      if (logTime >= startMs && logTime <= endMs) {
        yield this.redactLogEntry(log)
        await new Promise((resolve) => setImmediate(resolve))
      }
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
}

function createRepository(): AuditLogRepository {
  const shouldUsePostgres = process.env.AUDIT_LOG_BACKEND === 'postgres'
  if (!shouldUsePostgres) {
    return new InMemoryAuditLogsRepository()
  }

  return new PostgresAuditLogsRepository(pool)
}

// Create a singleton instance
export const auditLogService = new AuditLogService(createRepository())

export { AuditAction } from './types.js'
export type { AuditLogEntry, AuditLogInput, AuditLogFilters } from './types.js'
