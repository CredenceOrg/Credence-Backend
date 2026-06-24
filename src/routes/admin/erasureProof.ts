import { Router, type Request, type Response } from 'express'
import {
  type AuthenticatedRequest,
  requireUserAuth,
  requireAdminRole,
} from '../../middleware/auth.js'
import { auditLogService, AuditAction } from '../../services/audit/index.js'

const router = Router()

/**
 * GET /v1/admin/erasure-proof/:id
 *
 * Returns the signed proof-of-erasure for a given evidence record.
 * Queries the audit log for an EVIDENCE_SHREDDED entry matching the evidence ID.
 */
router.get(
  '/erasure-proof/:id',
  requireUserAuth,
  requireAdminRole,
  async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest
      const user = authReq.user!
      const evidenceId = req.params.id

      if (!evidenceId || evidenceId.trim().length === 0) {
        res.status(400).json({ error: 'BadRequest', message: 'evidence id is required' })
        return
      }

      const { logs } = await auditLogService.getLogs(
        user.tenantId,
        {
          action: AuditAction.EVIDENCE_SHREDDED,
          resourceId: evidenceId,
        },
        1,
        undefined,
        { allowSuperScope: true },
      )

      if (logs.length === 0) {
        res.status(404).json({
          error: 'NotFound',
          message: `No erasure proof found for evidence ${evidenceId}`,
        })
        return
      }

      const entry = logs[0]

      res.status(200).json({
        success: true,
        data: {
          evidenceId,
          shreddedAt: entry.details?.shreddedAt ?? entry.timestamp,
          proofJwt: entry.details?.proofJwt ?? null,
          auditEntryId: entry.id,
          auditTimestamp: entry.timestamp,
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      res.status(500).json({ error: 'InternalError', message })
    }
  },
)

export default router
