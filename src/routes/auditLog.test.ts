import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express, { type Request, type Response, type NextFunction } from 'express'
import { createAuditLogRouter } from './auditLog.js'
import type { AuditLogService } from '../services/audit/index.js'
import { AppError } from '../lib/errors.js'

// Stub rate limiter so tests are not blocked by Redis
vi.mock('../middleware/rateLimit.js', () => ({
  rateLimit: () => (_req: any, _res: any, next: any) => next(),
}))

/** Minimal error handler that converts AppError to HTTP responses */
function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.name, message: err.message })
  } else {
    res.status(500).json({ error: 'InternalError' })
  }
}

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'entry-1',
    timestamp: new Date().toISOString(),
    actorId: 'admin-1',
    actorEmail: 'a***@credence.org',
    adminId: 'admin-1',
    adminEmail: 'a***@credence.org',
    action: 'EXPORT_AUDIT_LOGS',
    resourceType: 'admin_user',
    resourceId: 'admin-1',
    details: {},
    status: 'success' as const,
    ...overrides,
  }
}

async function* makeStream(entries: ReturnType<typeof makeEntry>[]) {
  for (const e of entries) yield e
}

function buildApp(service: Partial<AuditLogService>) {
  const app = express()
  // Attach a minimal req.user so requireMinRole passes
  app.use((req: any, _res, next) => {
    req.user = { id: 'admin-1', address: 'GADMIN', role: 'admin' }
    next()
  })
  app.use('/api/audit', createAuditLogRouter(service as AuditLogService))
  app.use(errorHandler)
  return app
}

describe('GET /api/audit/export', () => {
  let service: { exportLogsStream: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    service = { exportLogsStream: vi.fn() }
  })

  it('streams NDJSON with Content-Type application/x-ndjson', async () => {
    service.exportLogsStream.mockReturnValue(makeStream([makeEntry()]))

    const res = await request(buildApp(service)).get('/api/audit/export')

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/application\/x-ndjson/)
    const lines = res.text.trim().split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]).id).toBe('entry-1')
  })

  it('streams multiple entries as separate NDJSON lines', async () => {
    service.exportLogsStream.mockReturnValue(
      makeStream([makeEntry({ id: 'e1' }), makeEntry({ id: 'e2' }), makeEntry({ id: 'e3' })]),
    )

    const res = await request(buildApp(service)).get('/api/audit/export')

    const lines = res.text.trim().split('\n').filter(Boolean)
    expect(lines).toHaveLength(3)
    expect(lines.map((l) => JSON.parse(l).id)).toEqual(['e1', 'e2', 'e3'])
  })

  it('returns empty body when no logs match', async () => {
    service.exportLogsStream.mockReturnValue(makeStream([]))

    const res = await request(buildApp(service)).get('/api/audit/export')

    expect(res.status).toBe(200)
    expect(res.text.trim()).toBe('')
  })

  it('passes from/to query params to the service', async () => {
    service.exportLogsStream.mockReturnValue(makeStream([]))

    await request(buildApp(service))
      .get('/api/audit/export?from=2024-01-01T00:00:00Z&to=2024-12-31T23:59:59Z')

    expect(service.exportLogsStream).toHaveBeenCalledWith(
      new Date('2024-01-01T00:00:00Z'),
      new Date('2024-12-31T23:59:59Z'),
      undefined,
      { allowSuperScope: true },
    )
  })

  it('returns 400 for invalid date params', async () => {
    service.exportLogsStream.mockReturnValue(makeStream([]))

    const res = await request(buildApp(service)).get('/api/audit/export?from=not-a-date')

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('InvalidDateRange')
  })

  it('returns 403 when caller lacks admin role', async () => {
    service.exportLogsStream.mockReturnValue(makeStream([]))

    const app = express()
    app.use((req: any, _res, next) => {
      req.user = { id: 'user-1', address: 'GUSER', role: 'user' }
      next()
    })
    app.use('/api/audit', createAuditLogRouter(service as AuditLogService))
    app.use(errorHandler)

    const res = await request(app).get('/api/audit/export')

    expect(res.status).toBe(403)
  })

  it('returns 401 when caller is unauthenticated', async () => {
    service.exportLogsStream.mockReturnValue(makeStream([]))

    const app = express()
    // No req.user attached
    app.use('/api/audit', createAuditLogRouter(service as AuditLogService))
    app.use(errorHandler)

    const res = await request(app).get('/api/audit/export')

    expect(res.status).toBe(401)
  })

  it('returns 500 when stream throws before headers are sent', async () => {
    async function* failingStream() {
      throw new Error('DB error')
    }
    service.exportLogsStream.mockReturnValue(failingStream())

    const res = await request(buildApp(service)).get('/api/audit/export')

    expect(res.status).toBe(500)
    // Content-Type is x-ndjson so body is parsed as text; check the raw text
    expect(res.text).toContain('ExportFailed')
  })
})
