import { Router, type Request, type Response } from 'express'
import { requireMinRole } from '../middleware/rbac.js'
import { rateLimit } from '../middleware/rateLimit.js'
import { auditLogService } from '../services/audit/index.js'
import type { AuditLogService } from '../services/audit/index.js'

const EXPORT_RATE_LIMIT = rateLimit({
  namespace: 'ratelimit:audit-export',
  max: 10,
  windowSec: 60,
})

export function createAuditLogRouter(service: AuditLogService = auditLogService): Router {
  const router = Router()

  /**
   * GET /api/audit/export
   * Streams audit logs as NDJSON.
   * Requires admin role. Rate-limited to 10 req/min per tenant/IP.
   *
   * Query params:
   *   from  – ISO date string (inclusive), defaults to 30 days ago
   *   to    – ISO date string (inclusive), defaults to now
   */
  router.get(
    '/export',
    EXPORT_RATE_LIMIT,
    requireMinRole('admin'),
    async (req: Request, res: Response) => {
      const now = new Date()
      const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

      const from = req.query.from ? new Date(req.query.from as string) : defaultFrom
      const to = req.query.to ? new Date(req.query.to as string) : now

      if (isNaN(from.getTime()) || isNaN(to.getTime())) {
        res.status(400).json({ error: 'InvalidDateRange', message: 'from/to must be valid ISO date strings' })
        return
      }

      res.setHeader('Content-Type', 'application/x-ndjson')

      try {
        const stream = service.exportLogsStream(from, to, undefined, { allowSuperScope: true })
        for await (const entry of stream) {
          res.write(JSON.stringify(entry) + '\n')
        }
        res.end()
      } catch (err) {
        if (!res.headersSent) {
          res.status(500).json({ error: 'ExportFailed', message: 'Failed to export audit logs' })
        } else {
          res.end()
        }
      }
    },
  )

  return router
}
