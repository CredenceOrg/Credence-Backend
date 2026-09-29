import { describe, it, expect, vi, beforeEach } from 'vitest'
import express, { type Request, type Response, type NextFunction } from 'express'
import request from 'supertest'
import exportPaginatedRouter from './exportPaginated.js'
import { errorHandler } from '../../middleware/errorHandler.js'

const mockGetLogs = vi.fn()

vi.mock('../../services/audit/index.js', () => ({
  auditLogService: {
    getLogs: (...args: unknown[]) => mockGetLogs(...args),
    logAction: vi.fn(),
  },
  AuditAction: {
    EXPORT_AUDIT_LOGS: 'EXPORT_AUDIT_LOGS',
  },
}))

let mockUser: { id: string; email: string; role: string; tenantId: string } | null = {
  id: 'admin-1',
  email: 'admin@test.com',
  role: 'admin',
  tenantId: 'tenant-1',
}

vi.mock('../../middleware/auth.js', () => ({
  requireUserAuth: (req: Request, _res: Response, next: NextFunction) => {
    if (!mockUser) {
      _res.status(401).json({ error: 'Unauthorized', message: 'User authentication required' })
      return
    }
    ;(req as any).user = mockUser
    ;(req as any).requestId = 'test-request-id'
    next()
  },
  requireAdminRole: (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user
    if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) {
      res.status(403).json({ error: 'Forbidden', message: 'Admin role required' })
      return
    }
    next()
  },
  UserRole: {
    ADMIN: 'admin',
    SUPER_ADMIN: 'super_admin',
  },
}))

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/admin', exportPaginatedRouter)
  app.use(errorHandler)
  return app
}

describe('GET /api/admin/audit-logs/export-paginated', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUser = {
      id: 'admin-1',
      email: 'admin@test.com',
      role: 'admin',
      tenantId: 'tenant-1',
    }
  })

  it('returns paginated audit logs when from and to are provided', async () => {
    mockGetLogs.mockResolvedValue({
      logs: [
        { id: '1', action: 'LIST_USERS', timestamp: '2026-07-01T00:00:00.000Z' },
        { id: '2', action: 'ASSIGN_ROLE', timestamp: '2026-07-01T01:00:00.000Z' },
      ],
      hasNextPage: false,
      nextCursor: undefined,
    })

    const res = await request(createApp())
      .get('/api/admin/audit-logs/export-paginated')
      .query({ from: '2026-07-01T00:00:00.000Z', to: '2026-07-02T00:00:00.000Z' })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.logs).toHaveLength(2)
    expect(res.body.data.hasNextPage).toBe(false)
    expect(res.body.data.limit).toBe(500)

    expect(mockGetLogs).toHaveBeenCalledWith(
      'tenant-1',
      expect.objectContaining({
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-07-02T00:00:00.000Z',
      }),
      500,
      undefined,
      expect.objectContaining({}),
    )
  })

  it('returns paginated results with nextCursor when there are more pages', async () => {
    mockGetLogs.mockResolvedValue({
      logs: Array.from({ length: 500 }, (_, i) => ({
        id: `${i + 1}`,
        action: 'LIST_USERS',
        timestamp: '2026-07-01T00:00:00.000Z',
      })),
      hasNextPage: true,
      nextCursor: 'encoded-cursor-value',
    })

    const res = await request(createApp())
      .get('/api/admin/audit-logs/export-paginated')
      .query({ from: '2026-07-01T00:00:00.000Z', to: '2026-07-02T00:00:00.000Z', limit: '500' })

    expect(res.status).toBe(200)
    expect(res.body.data.logs).toHaveLength(500)
    expect(res.body.data.hasNextPage).toBe(true)
    expect(res.body.data.nextCursor).toBe('encoded-cursor-value')
    expect(res.body.data.links.next).toBeDefined()
  })

  it('respects custom limit parameter', async () => {
    mockGetLogs.mockResolvedValue({
      logs: Array.from({ length: 100 }, (_, i) => ({
        id: `${i + 1}`,
        action: 'EXPORT_AUDIT_LOGS',
        timestamp: '2026-07-01T00:00:00.000Z',
      })),
      hasNextPage: false,
      nextCursor: undefined,
    })

    const res = await request(createApp())
      .get('/api/admin/audit-logs/export-paginated')
      .query({ from: '2026-07-01T00:00:00.000Z', to: '2026-07-02T00:00:00.000Z', limit: '100' })

    expect(res.status).toBe(200)
    expect(res.body.data.logs).toHaveLength(100)
    expect(res.body.data.limit).toBe(100)
  })

  it('caps limit at EXPORT_MAX_LIMIT (1000)', async () => {
    mockGetLogs.mockResolvedValue({
      logs: [],
      hasNextPage: false,
      nextCursor: undefined,
    })

    const res = await request(createApp())
      .get('/api/admin/audit-logs/export-paginated')
      .query({ from: '2026-07-01T00:00:00.000Z', to: '2026-07-02T00:00:00.000Z', limit: '5000' })

    expect(res.status).toBe(500)
  })

  it('rejects missing from parameter', async () => {
    const res = await request(createApp())
      .get('/api/admin/audit-logs/export-paginated')
      .query({ to: '2026-07-02T00:00:00.000Z' })

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('validation_failed')
  })

  it('rejects missing to parameter', async () => {
    const res = await request(createApp())
      .get('/api/admin/audit-logs/export-paginated')
      .query({ from: '2026-07-01T00:00:00.000Z' })

    expect(res.status).toBe(400)
  })

  it('rejects invalid date formats', async () => {
    const res = await request(createApp())
      .get('/api/admin/audit-logs/export-paginated')
      .query({ from: 'not-a-date', to: '2026-07-02T00:00:00.000Z' })

    expect(res.status).toBe(400)
  })

  it('rejects from date after to date', async () => {
    const res = await request(createApp())
      .get('/api/admin/audit-logs/export-paginated')
      .query({ from: '2026-07-05T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' })

    expect(res.status).toBe(400)
  })

  it('rejects unauthenticated callers with 401', async () => {
    mockUser = null

    const res = await request(createApp())
      .get('/api/admin/audit-logs/export-paginated')
      .query({ from: '2026-07-01T00:00:00.000Z', to: '2026-07-02T00:00:00.000Z' })

    expect(res.status).toBe(401)
    expect(mockGetLogs).not.toHaveBeenCalled()
  })

  it('rejects non-admin callers with 403', async () => {
    mockUser = {
      id: 'user-1',
      email: 'user@test.com',
      role: 'user',
      tenantId: 'tenant-1',
    }

    const res = await request(createApp())
      .get('/api/admin/audit-logs/export-paginated')
      .query({ from: '2026-07-01T00:00:00.000Z', to: '2026-07-02T00:00:00.000Z' })

    expect(res.status).toBe(403)
    expect(mockGetLogs).not.toHaveBeenCalled()
  })

  it('returns empty logs array when no audit records match the date range', async () => {
    mockGetLogs.mockResolvedValue({
      logs: [],
      hasNextPage: false,
      nextCursor: undefined,
    })

    const res = await request(createApp())
      .get('/api/admin/audit-logs/export-paginated')
      .query({ from: '2026-06-01T00:00:00.000Z', to: '2026-06-01T01:00:00.000Z' })

    expect(res.status).toBe(200)
    expect(res.body.data.logs).toHaveLength(0)
    expect(res.body.data.hasNextPage).toBe(false)
  })
})
