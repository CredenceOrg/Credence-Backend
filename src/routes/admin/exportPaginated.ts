import { Router, type Request, type Response, type NextFunction } from 'express'
import type { AuthenticatedRequest } from '../../middleware/auth.js'
import { requireUserAuth, requireAdminRole } from '../../middleware/auth.js'
import { AdminService } from '../../services/admin/index.js'
import { auditLogService, AuditAction } from '../../services/audit/index.js'
import { parsePaginationParams, buildCursorPaginationMeta, buildCursorPaginationLinks } from '../../lib/pagination.js'
import { ValidationError } from '../../lib/errors.js'

const EXPORT_MAX_LIMIT = 1000
const EXPORT_DEFAULT_LIMIT = 500

const router = Router()

router.get(
  '/audit-logs/export-paginated',
  requireUserAuth,
  requireAdminRole,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authReq = req as AuthenticatedRequest
      const user = authReq.user!
      const requestId = (req as any).requestId

      const from = req.query.from as string | undefined
      const to = req.query.to as string | undefined

      if (!from || !to) {
        throw new ValidationError('from and to query parameters are required')
      }

      const fromDate = new Date(from)
      const toDate = new Date(to)

      if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
        throw new ValidationError('from and to must be valid ISO date strings')
      }

      if (fromDate > toDate) {
        throw new ValidationError('from must be before or equal to to')
      }

      const { limit, cursor, decodedCursor } = parsePaginationParams(
        req.query as Record<string, unknown>,
        { defaultLimit: EXPORT_DEFAULT_LIMIT, maxLimit: EXPORT_MAX_LIMIT },
      )

      const filters: Record<string, string> = {
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
      }

      const adminService = new AdminService(auditLogService)
      const result = await adminService.getAuditLogs(
        user.id,
        user.email,
        filters,
        limit,
        cursor ?? undefined,
        user,
      )

      void auditLogService.logAction(
        user.tenantId,
        user.id,
        user.email,
        AuditAction.EXPORT_AUDIT_LOGS,
        user.id,
        undefined,
        {
          phase: 'paginated_page',
          from: fromDate.toISOString(),
          to: toDate.toISOString(),
          limit,
          hasNextPage: result.hasNextPage,
        },
        undefined,
        undefined,
        req.ip,
        requestId,
      )

      const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`

      res.status(200).json({
        success: true,
        data: {
          logs: result.logs,
          ...buildCursorPaginationMeta(result.hasNextPage, limit, result.nextCursor),
          links: buildCursorPaginationLinks(fullUrl, limit, result.nextCursor),
        },
      })
    } catch (error) {
      next(error)
    }
  },
)

export default router
