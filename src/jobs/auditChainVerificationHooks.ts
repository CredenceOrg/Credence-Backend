import { auditLogService } from '../services/audit/index.js'
import { logAuditChainVerification } from './auditChainVerificationLog.js'
import type { AuditChainVerificationHooks } from './auditChainVerifier.js'

/**
 * Default persistence and structured logging hooks for scheduled verification runs.
 */
export function createDefaultAuditChainVerificationHooks(): AuditChainVerificationHooks {
  return {
    saveStatus: (result) => auditLogService.saveChainVerificationStatus(result),
    logVerification: logAuditChainVerification,
  }
}
