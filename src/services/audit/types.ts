/**
 * Audit log action types
 */
export enum AuditAction {
  LIST_USERS = 'LIST_USERS',
  ASSIGN_ROLE = 'ASSIGN_ROLE',
  REVOKE_ROLE = 'REVOKE_ROLE',
  REVOKE_API_KEY = 'REVOKE_API_KEY',
  CREATE_API_KEY = 'CREATE_API_KEY',
  DELETE_USER = 'DELETE_USER',
}

/**
 * Audit log entry
 */
export interface AuditLogEntry {
  id: string
  timestamp: string
  adminId: string
  adminEmail: string
  action: AuditAction
  targetUserId: string
  targetUserEmail: string
  details: Record<string, unknown>
  ipAddress?: string
  status: 'success' | 'failure'
  errorMessage?: string
}
