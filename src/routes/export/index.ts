import { Router, type Request, type Response, type NextFunction } from 'express'
import { createGzip } from 'zlib'
import { loadConfig } from '../../config/index.js'
import { DEFAULT_EXPORT_MAX_ROWS } from '../../config/constants.js'
import { requireApiKey, ApiScope } from '../../middleware/auth.js'
import { rateLimit } from '../../middleware/rateLimit.js'
import { validate } from '../../middleware/validate.js'
import { auditLogService } from '../../services/audit/index.js'
import {
  ExportService,
  createNdjsonExportWriter,
} from '../../services/exportService.js'
import { ExportTooLargeError, ValidationError } from '../../lib/errors.js'
import { auditLogExportQuerySchema } from '../../schemas/export.js'
import { getTenantId } from '../../utils/tenantContext.js'

const EXPORT_RATE_LIMIT = rateLimit({
  namespace: 'ratelimit:data-export',
  max: 10,
  windowSec: 60,
})

function resolveExportConfig(): { maxWindowDays: number; maxRows: number } {
  try {
    const config = loadConfig()
    return {
      maxWindowDays: config.auditLog.exportMaxWindowDays,
      maxRows: config.export.maxRows,
    }
  } catch {
    return {
      maxWindowDays: 90,
      maxRows: DEFAULT_EXPORT_MAX_ROWS,
    }
  }
}

export interface CreateExportRouterOptions {
  exportService?: ExportService
  maxWindowDays?: number
  maxRows?: number
}

/**
 * Authenticated data-export routes.
 *
 * Size limits are enforced in the service layer *before* the NDJSON writer
 * opens or rows are streamed, so oversized requests fail cheaply.
 */
export function createExportRouter(options: CreateExportRouterOptions = {}): Router {
  const router = Router()
  const defaults = resolveExportConfig()
  const maxWindowDays = options.maxWindowDays ?? defaults.maxWindowDays
  const maxRows = options.maxRows ?? defaults.maxRows
  const maxWindowMs = maxWindowDays * 24 * 60 * 60 * 1000

  const exportService =
    options.exportService ??
    new ExportService(auditLogService, { maxRows })

  /**
   * GET /api/export/audit-logs
   *
   * Streams tenant-scoped audit logs as NDJSON.
   * Requires `exports:read`. Rejects with 413 when the matching row count
   * exceeds EXPORT_MAX_ROWS before any streaming work begins.
   *
   * Query params:
   *   from – ISO date string (inclusive), defaults to 30 days ago
   *   to   – ISO date string (inclusive), defaults to now
   */
  router.get(
    '/audit-logs',
    EXPORT_RATE_LIMIT,
    requireApiKey(ApiScope.EXPORTS_READ),
    validate({ query: auditLogExportQuerySchema }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const now = new Date()
        const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

        const from = req.query.from
          ? new Date(req.query.from as string)
          : defaultFrom
        const to = req.query.to ? new Date(req.query.to as string) : now

        if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
          throw new ValidationError('from/to must be valid ISO date strings')
        }

        if (from > to) {
          throw new ValidationError('from must be before or equal to to')
        }

        const windowMs = to.getTime() - from.getTime()
        if (windowMs > maxWindowMs) {
          throw new ValidationError(
            `Export window cannot exceed ${maxWindowDays} days`,
          )
        }

        const tenantId = getTenantId() ?? 'default-tenant'
        const params = { startDate: from, endDate: to, tenantId }

        // Reject oversized exports before opening the response stream.
        await exportService.assertWithinRowLimit(params)

        res.setHeader('Content-Type', 'application/x-ndjson')
        res.setHeader(
          'Content-Disposition',
          'attachment; filename="audit-logs.ndjson"',
        )
        res.setHeader('X-Export-Max-Rows', String(exportService.getMaxRows()))

        const acceptEncoding = req.headers['accept-encoding']
        const supportsGzip =
          typeof acceptEncoding === 'string' && acceptEncoding.includes('gzip')

        let output: NodeJS.WritableStream = res
        if (supportsGzip) {
          const gzip = createGzip()
          gzip.pipe(res)
          output = gzip
          res.setHeader('Content-Encoding', 'gzip')
        }

        const writer = createNdjsonExportWriter(output as import('node:stream').Writable)
        // Size already asserted above — skip the second count before streaming.
        await exportService.runAuditLogExport(params, writer, {
          skipRowLimitCheck: true,
        })
      } catch (error) {
        if (error instanceof ExportTooLargeError) {
          if (!res.headersSent) {
            next(error)
          } else {
            res.end()
          }
          return
        }

        if (!res.headersSent) {
          next(error)
        } else {
          res.end()
        }
      }
    },
  )

  return router
}

export default createExportRouter
