import { AuditLogEntry, AuditAction } from './types.js'

/**
 * Audit log service for tracking admin actions
 * In production, this would write to a database or centralized logging system
 *
 * Supports request-scoped batching: callers can buffer multiple log entries
 * and flush them in a single write, reducing per-request I/O when the
 * underlying storage is a remote database rather than an in-memory array.
 */
export class AuditLogService {
  private logs: AuditLogEntry[] = []
  private logId = 0
  /** Entries buffered by the current request that have not been flushed yet. */
  private buffer: AuditLogEntry[] = []
  /** True when the service is in buffered (request-scoped) mode. */
  private buffered = false

  /**
   * Enable request-scoped buffering. While buffered, every call to
   * {@link logAction} appends to an internal buffer instead of writing
   * immediately. Call {@link flush} at the end of the request to commit
   * all buffered entries at once.
   *
   * Use this in middleware or request interceptors to coalesce audit-log
   * writes per request, reducing the number of I/O operations when the
   * underlying store is a remote database.
   *
   * If a buffer is already active (e.g., nested middleware registration),
   * this call is a safe no-op rather than silently discarding the existing
   * buffer.
   */
  startBuffer(): void {
    if (this.buffered) {
      return // already buffering — don't discard existing entries
    }
    this.buffered = true
    this.buffer = []
  }

  /**
   * Immediately flush all buffered entries to the audit log (the internal
   * `logs` array). After flushing, buffered mode is disabled.
   *
   * Call this at the end of each request (e.g. in response middleware or
   * a `finally` block) to commit the coalesced entries.
   *
   * @returns The number of entries that were flushed.
   */
  flush(): number {
    const count = this.buffer.length
    if (count > 0) {
      this.logs.push(...this.buffer)
      this.buffer = []
    }
    this.buffered = false
    return count
  }

  /**
   * Discard any buffered entries without writing them.
   * Useful on request error paths where the audit trail should not be saved.
   */
  discardBuffer(): void {
    this.buffer = []
    this.buffered = false
  }

  /**
   * Log an admin action
   * 
   * When buffered mode is active (via {@link startBuffer}), the entry is
   * added to the request buffer and will be written on the next {@link flush}.
   * Otherwise, the entry is written immediately to the log.
   * 
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
  logAction(
    adminId: string,
    adminEmail: string,
    action: AuditAction,
    targetUserId: string,
    targetUserEmail: string,
    details: Record<string, unknown> = {},
    status: 'success' | 'failure' = 'success',
    errorMessage?: string,
    ipAddress?: string
  ): AuditLogEntry {
    const entry: AuditLogEntry = {
      id: `audit-${this.logId++}`,
      timestamp: new Date().toISOString(),
      adminId,
      adminEmail,
      action,
      targetUserId,
      targetUserEmail,
      details,
      ipAddress,
      status,
      errorMessage,
    }

    if (this.buffered) {
      this.buffer.push(entry)
    } else {
      this.logs.push(entry)
    }
    return entry
  }

  /**
   * Get audit logs with optional filtering
   * 
   * @param filters - Optional filters for action, adminId, targetUserId, etc.
   * @param limit - Maximum number of logs to return (default: 100)
   * @param offset - Pagination offset (default: 0)
   * @returns Array of matching audit log entries and total count
   */
  getLogs(
    filters?: {
      action?: AuditAction
      adminId?: string
      targetUserId?: string
      status?: 'success' | 'failure'
    },
    limit = 100,
    offset = 0
  ): {
    logs: AuditLogEntry[]
    total: number
  } {
    let filtered = this.logs

    if (filters?.action) {
      filtered = filtered.filter((log) => log.action === filters.action)
    }
    if (filters?.adminId) {
      filtered = filtered.filter((log) => log.adminId === filters.adminId)
    }
    if (filters?.targetUserId) {
      filtered = filtered.filter((log) => log.targetUserId === filters.targetUserId)
    }
    if (filters?.status) {
      filtered = filtered.filter((log) => log.status === filters.status)
    }

    // Sort by timestamp descending (newest first)
    filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

    const total = filtered.length
    const paginated = filtered.slice(offset, offset + limit)

    return { logs: paginated, total }
  }

  /**
   * Get all audit logs (for testing)
   * @returns All audit log entries
   */
  getAllLogs(): AuditLogEntry[] {
    return this.logs
  }

  /**
   * Clear all logs (for testing)
   */
  clearLogs(): void {
    this.logs = []
    this.logId = 0
  }

  /**
   * Stream audit logs as an AsyncGenerator to avoid memory spikes
   * Applies date filtering and redacts sensitive information compliance policy
   * 
   * @param startDate - Start date (inclusive)
   * @param endDate - End date (inclusive)
   */
  async *exportLogsStream(startDate: Date, endDate: Date): AsyncGenerator<AuditLogEntry> {
    const startMs = startDate.getTime()
    const endMs = endDate.getTime()

    // Sort logs descending but stream them chronologically or descending?
    // Often compliance exports are fine descending, we'll keep the same order.
    // Iterating over the array. Since it is in-memory we just filter and yield.
    // In a database, this would use a cursor and fetch chunks.
    for (const log of this.logs) {
      const logTime = new Date(log.timestamp).getTime()
      if (logTime >= startMs && logTime <= endMs) {
        // Redact and yield
        yield this.redactLogEntry(log)
        // Yield to event loop to simulate genuine streaming and prevent blocking
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

// Create a singleton instance
export const auditLogService = new AuditLogService()

// Export types
export { AuditAction } from './types.js'
export type { AuditLogEntry } from './types.js'
