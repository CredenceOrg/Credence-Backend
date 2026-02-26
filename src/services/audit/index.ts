import { AuditLogEntry, AuditAction } from './types.js'

/**
 * Audit log service for tracking admin actions
 * In production, this would write to a database or centralized logging system
 */
export class AuditLogService {
  private logs: AuditLogEntry[] = []
  private logId = 0

  /**
   * Log an admin action
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

    this.logs.push(entry)
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
}

// Create a singleton instance
export const auditLogService = new AuditLogService()

// Export types
export { AuditLogEntry, AuditAction } from './types.js'
