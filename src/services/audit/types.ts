/**
 * Audit log action types
 */
export enum AuditAction {
  LIST_USERS = 'LIST_USERS',
  ASSIGN_ROLE = 'ASSIGN_ROLE',
  REVOKE_ROLE = 'REVOKE_ROLE',
  REVOKE_API_KEY = 'REVOKE_API_KEY',
  CREATE_API_KEY = 'CREATE_API_KEY',
  ROTATE_API_KEY = 'ROTATE_API_KEY',
  DELETE_USER = 'DELETE_USER',
  DISPUTE_SUBMITTED = 'DISPUTE_SUBMITTED',
  DISPUTE_MARKED_UNDER_REVIEW = 'DISPUTE_MARKED_UNDER_REVIEW',
  DISPUTE_RESOLVED = 'DISPUTE_RESOLVED',
  DISPUTE_DISMISSED = 'DISPUTE_DISMISSED',
  SLASH_REQUEST_CREATED = 'SLASH_REQUEST_CREATED',
  SLASH_VOTE_CAST = 'SLASH_VOTE_CAST',
  EVIDENCE_UPLOADED = 'EVIDENCE_UPLOADED',
  EVIDENCE_ACCESSED = 'EVIDENCE_ACCESSED',
  EVIDENCE_SHREDDED = 'EVIDENCE_SHREDDED',
  EXPORT_AUDIT_LOGS = 'EXPORT_AUDIT_LOGS',
  ISSUE_IMPERSONATION_TOKEN = 'ISSUE_IMPERSONATION_TOKEN',
  REVOKE_IMPERSONATION_TOKEN = 'REVOKE_IMPERSONATION_TOKEN',
  INVITE_MEMBER = 'INVITE_MEMBER',
  LIST_MEMBERS = 'LIST_MEMBERS',
  UPDATE_MEMBER_ROLE = 'UPDATE_MEMBER_ROLE',
  DELETE_MEMBER = 'DELETE_MEMBER',
  RESTORE_MEMBER = 'RESTORE_MEMBER',
  CREATE_FLAG = 'CREATE_FLAG',
  UPDATE_FLAG = 'UPDATE_FLAG',
  SET_FLAG_OVERRIDE = 'SET_FLAG_OVERRIDE',
  REMOVE_FLAG_OVERRIDE = 'REMOVE_FLAG_OVERRIDE',
  POLICY_RULE_CREATED = 'POLICY_RULE_CREATED',
  POLICY_RULE_UPDATED = 'POLICY_RULE_UPDATED',
  POLICY_RULE_DELETED = 'POLICY_RULE_DELETED',
  ROTATE_WEBHOOK_SECRET = 'ROTATE_WEBHOOK_SECRET',
  REVOKE_WEBHOOK_SECRET = 'REVOKE_WEBHOOK_SECRET',
  LIST_FAILED_EVENTS = 'LIST_FAILED_EVENTS',
  REPLAY_EVENT = 'REPLAY_EVENT',
  REPLAY_REQUEST = 'REPLAY_REQUEST',
  LIST_OUTBOX_QUARANTINE = 'LIST_OUTBOX_QUARANTINE',
  OUTBOX_REINJECT = 'OUTBOX_REINJECT',
}

export type AuditStatus = 'success' | 'failure'

export interface AuditLogInput {
  actorId: string
  actorEmail: string
  action: AuditAction | string
  resourceType: string
  resourceId: string
  details?: Record<string, unknown>
  status?: AuditStatus
  ipAddress?: string
  errorMessage?: string
  tenantId: string
  requestId?: string
}

export interface AuditLogFilters {
  action?: AuditAction | string
  actorId?: string
  resourceType?: string
  resourceId?: string
  status?: AuditStatus
  from?: string
  to?: string
  adminId?: string
  targetUserId?: string
  tenantId?: string
}

/**
 * Audit log entry
 */
export interface AuditLogEntry {
  id: string
  timestamp: string
  actorId: string
  actorEmail: string
  adminId?: string
  adminEmail?: string
  action: AuditAction | string
  resourceType: string
  resourceId: string
  targetUserId?: string
  targetUserEmail?: string
  details: Record<string, unknown>
  ipAddress?: string
  status: AuditStatus
  errorMessage?: string
  requestId?: string
  tenantId: string
  /** Sequence number for deterministic chain ordering */
  seq?: number
  /** SHA-256 row_hash of the preceding row (NULL for genesis row) */
  prevHash?: string | null
  /** SHA-256 hash of this row's content including prevHash */
  rowHash?: string | null
}

/**
 * Result of a chain integrity verification run
 */
export interface ChainVerificationResult {
  valid: boolean
  rowsChecked: number
  firstViolationSeq?: number
  firstViolationId?: string
  violationCount: number
  violations: ChainViolation[]
  checkedAt: string
}

/**
 * A single chain violation
 */
export interface ChainViolation {
  seq: number
  id: string
  expectedPrevHash: string | null
  actualPrevHash: string | null
  expectedRowHash: string
  actualRowHash: string | null
  type: 'prev_hash_mismatch' | 'row_hash_mismatch' | 'missing_row' | 'deleted_row'
}
