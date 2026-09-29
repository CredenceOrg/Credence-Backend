/**
 * @file Route tests for GET /api/export/audit-logs size-limit enforcement.
 *
 * Verifies that oversized exports are rejected with 413 *before* the
 * NDJSON writer opens, and that auth + window validation behave correctly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express'
import request from 'supertest'
import { createExportRouter } from '../../src/routes/export/index.js'
import { errorHandler } from '../../src/middleware/errorHandler.js'
import { tenantContextMiddleware } from '../../src/middleware/tenantContext.js'
import { runWithTenant } from '../../src/utils/tenantContext.js'
import { ExportTooLargeError } from '../../src/lib/errors.js'
import type { ExportService } from '../../src/services/exportService.js'

vi.mock('../../src/middleware/rateLimit.js', () => ({
  rateLimit: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}))

vi.mock('../../src/middleware/auth.js', () => ({
  ApiScope: { EXPORTS_READ: 'exports:read' },
  requireApiKey: () => (req: Request, _res: Response, next: NextFunction) => {
    const key = req.headers['x-api-key']
    if (!key) {
      res401(_res)
      return
    }
    if (key === 'test-public-key-67890') {
      _res.status(403).json({
        error: 'Forbidden',
        message: "Insufficient scope: 'exports:read' is required",
      })
      return
    }
    ;(req as any).apiKey = { key, scopes: ['exports:read'] }
    next()
  },
}))

function res401(res: Response) {
  res.status(401).json({ error: 'Unauthorized', message: 'API key required' })
}

function buildApp(exportService: Partial<ExportService>) {
  const app = express()
  app.use((_req, _res, next) => runWithTenant('tenant-export', () => next()))
  app.use(tenantContextMiddleware)
  app.use(
    '/api/export',
    createExportRouter({
      exportService: exportService as ExportService,
      maxWindowDays: 90,
      maxRows: 5,
    }),
  )
  app.use(errorHandler)
  return app
}

describe('GET /api/export/audit-logs', () => {
  let exportService: {
    assertWithinRowLimit: ReturnType<typeof vi.fn>
    runAuditLogExport: ReturnType<typeof vi.fn>
    getMaxRows: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    exportService = {
      assertWithinRowLimit: vi.fn().mockResolvedValue({ rowCount: 2, maxRows: 5 }),
      runAuditLogExport: vi.fn().mockImplementation(async (_params, writer) => {
        await writer.open()
        await writer.writeBatch([{ id: '1' }, { id: '2' }])
        await writer.close()
        return {
          totalRows: 2,
          batchesProcessed: 1,
          errors: 0,
          duration: 1,
          startTime: new Date().toISOString(),
        }
      }),
      getMaxRows: vi.fn().mockReturnValue(5),
    }
  })

  it('streams NDJSON when the export is within the row limit', async () => {
    const res = await request(buildApp(exportService))
      .get('/api/export/audit-logs')
      .set('X-API-Key', 'test-reports-key')

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/ndjson/)
    expect(res.headers['x-export-max-rows']).toBe('5')
    expect(exportService.assertWithinRowLimit).toHaveBeenCalledTimes(1)
    expect(exportService.runAuditLogExport).toHaveBeenCalledTimes(1)

    const lines = res.text.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toEqual({ id: '1' })
  })

  it('returns 413 before streaming when the export exceeds the row limit', async () => {
    exportService.assertWithinRowLimit.mockRejectedValue(
      new ExportTooLargeError('Export would include at least 6 rows, exceeding the maximum of 5', {
        rowCount: 6,
        maxRows: 5,
      }),
    )

    const res = await request(buildApp(exportService))
      .get('/api/export/audit-logs')
      .set('X-API-Key', 'test-reports-key')

    expect(res.status).toBe(413)
    expect(res.body.code).toBe('request_too_large')
    expect(exportService.runAuditLogExport).not.toHaveBeenCalled()
    // Body must not look like a started NDJSON stream
    expect(res.headers['content-type']).not.toMatch(/ndjson/)
  })

  it('rejects unauthenticated requests', async () => {
    const res = await request(buildApp(exportService)).get('/api/export/audit-logs')
    expect(res.status).toBe(401)
    expect(exportService.assertWithinRowLimit).not.toHaveBeenCalled()
  })

  it('rejects keys without exports:read', async () => {
    const res = await request(buildApp(exportService))
      .get('/api/export/audit-logs')
      .set('X-API-Key', 'test-public-key-67890')

    expect(res.status).toBe(403)
    expect(exportService.assertWithinRowLimit).not.toHaveBeenCalled()
  })

  it('rejects export windows that exceed the configured max days', async () => {
    const res = await request(buildApp(exportService))
      .get(
        '/api/export/audit-logs?from=2024-01-01T00:00:00Z&to=2024-06-01T00:00:00Z',
      )
      .set('X-API-Key', 'test-reports-key')

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('validation_failed')
    expect(exportService.assertWithinRowLimit).not.toHaveBeenCalled()
    expect(exportService.runAuditLogExport).not.toHaveBeenCalled()
  })

  it('rejects invalid ISO date query params', async () => {
    const res = await request(buildApp(exportService))
      .get('/api/export/audit-logs?from=not-a-date')
      .set('X-API-Key', 'test-reports-key')

    expect(res.status).toBe(400)
    expect(exportService.assertWithinRowLimit).not.toHaveBeenCalled()
  })
})
