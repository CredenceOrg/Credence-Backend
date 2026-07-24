import { Router, type Request, type Response } from 'express'
import { createGzip } from 'zlib'
import { requireMinRole } from '../middleware/rbac.js'
import { rateLimit } from '../middleware/rateLimit.js'
import { auditLogService } from '../services/audit/index.js'
import type { AuditLogService } from '../services/audit/index.js'
import { loadConfig } from '../config/index.js'

const EXPORT_RATE_LIMIT = rateLimit({
  namespace: 'ratelimit:audit-export',
  max: 10,
  windowSec: 60,
})

export function createAuditLogRouter(service: AuditLogService = auditLogService): Router {
  const router = Router()
  let maxWindowMs: number | undefined
  let maxWindowDays: number | undefined

  // Helper to get config with fallback
  const getConfig = () => {
    try {
      return loadConfig()
    } catch {
      // Fallback to default 90 days if config loading fails (e.g., in tests)
      return { auditLog: { exportMaxWindowDays: 90 } }
    }
  }

  /**
   * GET /api/audit/export
   * Streams audit logs as NDJSON with optional gzip compression.
   * Requires admin role. Rate-limited to 10 req/min per tenant/IP.
   * Export window is capped to prevent resource exhaustion.
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
      if (!maxWindowMs) {
        const config = getConfig()
        maxWindowDays = config.auditLog.exportMaxWindowDays
        maxWindowMs = maxWindowDays * 24 * 60 * 60 * 1000
      }

      const now = new Date()
      const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

      const from = req.query.from ? new Date(req.query.from as string) : defaultFrom
      const to = req.query.to ? new Date(req.query.to as string) : now

      if (isNaN(from.getTime()) || isNaN(to.getTime())) {
        res.status(400).json({ error: 'InvalidDateRange', message: 'from/to must be valid ISO date strings' })
        return
      }

      // Validate export window is not too large
      const windowMs = to.getTime() - from.getTime()
      if (windowMs > maxWindowMs) {
        res.status(400).json({
          error: 'WindowTooLarge',
          message: `Export window cannot exceed ${maxWindowDays} days`,
        })
        return
      }

      res.setHeader('Content-Type', 'application/x-ndjson')

      const acceptEncoding = req.headers['accept-encoding']
      const supportsGzip = acceptEncoding && acceptEncoding.includes('gzip')

      let stream: any
      try {
        stream = service.exportLogsStream(from, to, undefined, { allowSuperScope: true })

        // Set up gzip only after successfully starting the stream
        let outputStream: any = res
        if (supportsGzip) {
          const gzip = createGzip()
          gzip.pipe(res)
          outputStream = gzip
          res.setHeader('Content-Encoding', 'gzip')
        }

        for await (const entry of stream) {
          outputStream.write(JSON.stringify(entry) + '\n')
        }
        outputStream.end()
      } catch (err) {
        // Make sure to close the stream iterator if it was opened
        if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
          try {
            await stream.return?.()
          } catch {
            // Ignore errors while closing the stream
          }
        }

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
