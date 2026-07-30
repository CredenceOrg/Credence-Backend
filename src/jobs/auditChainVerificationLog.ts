import { LogEventType } from '../observability/logSchemas.js'
import { redact } from '../observability/redaction.js'
import { logger } from '../utils/logger.js'
import type { ChainVerificationResult } from '../services/audit/types.js'

/**
 * Emit a schema-validated structured log entry for a completed verification run.
 */
export function logAuditChainVerification(result: ChainVerificationResult): void {
  const payload: Record<string, unknown> = {
    eventType: LogEventType.AUDIT_CHAIN_VERIFICATION,
    valid: result.valid,
    rowsChecked: result.rowsChecked,
    violationCount: result.violationCount,
    lastCheckedSeq: result.lastCheckedSeq ?? 0,
    checkedAt: result.checkedAt,
  }

  if (result.firstViolationSeq !== undefined) {
    payload.firstViolationSeq = result.firstViolationSeq
  }

  logger.info(redact(payload, { eventType: LogEventType.AUDIT_CHAIN_VERIFICATION }))
}
