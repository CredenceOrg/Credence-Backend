import { Router, type Request, type Response, type NextFunction } from 'express'
import {
  type AuthenticatedRequest,
  requireUserAuth,
  requireAdminRole,
} from '../../middleware/auth.js'
import { validate } from '../../middleware/validate.js'
import { auditChainStatusQuerySchema } from '../../schemas/auditChainStatus.js'
import { auditLogService } from '../../services/audit/index.js'

const router = Router()

/**
 * GET /api/admin/audit/chain-status
 *
 * Returns the durable last-run result of the audit hash chain verifier.
 * Read-only — never mutates audit log rows.
 */
router.get(
  '/chain-status',
  requireUserAuth,
  requireAdminRole,
  validate({ query: auditChainStatusQuerySchema }),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const status = await auditLogService.getChainVerificationStatus()

      res.status(200).json({
        success: true,
        data: status ?? {
          lastVerifiedHeight: 0,
          verifiedAt: null,
          status: 'never_run' as const,
        },
      })
    } catch (error) {
      next(error)
    }
  },
)

export default router
