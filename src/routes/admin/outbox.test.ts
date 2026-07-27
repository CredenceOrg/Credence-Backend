import { describe, it, expect, vi, beforeEach } from 'vitest'
import express, { Request, Response, NextFunction } from 'express'
import request from 'supertest'
import { createOutboxAdminRouter } from './outbox.js'
import { errorHandler } from '../../middleware/errorHandler.js'

const { mockUserRef, mockAuditLogService } = vi.hoisted(() => ({
  mockUserRef: { current: null as { id: string; email: string; role: string; tenantId: string } | null },
  mockAuditLogService: {
    logAction: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('../../middleware/auth.ts', () => ({
  ApiScope: { OUTBOX_REINJECT: 'outbox:reinject' },
  requireUserAuth: (req: Request, _res: Response, next: NextFunction) => {
    const user = mockUserRef.current
    if (!user) {
      _res.status(401).json({ error: 'Unauthorized', message: 'User authentication required' })
      return
    }
    ;(req as any).user = { id: user.id, email: user.email, role: user.role, tenantId: user.tenantId }
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
  requireApiKey: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  AuthenticatedRequest: class {},
}))

vi.mock('../../middleware/errorHandler.js', () => ({
  errorHandler: (err: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: 'Internal Server Error', code: 'internal_server_error' })
  },
}))

vi.mock('../../services/audit/index.js', () => ({
  auditLogService: mockAuditLogService,
  AuditAction: {
    LIST_OUTBOX_QUARANTINE: 'LIST_OUTBOX_QUARANTINE',
    OUTBOX_REINJECT: 'OUTBOX_REINJECT',
    OUTBOX_PAUSE: 'OUTBOX_PAUSE',
  },
}))

function setup() {
  const app = express()
  app.use(express.json())
  app.use('/api/admin/outbox', createOutboxAdminRouter())
  return app
}

describe('Admin Outbox Router - POST /pause', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUserRef.current = {
      id: 'admin-1',
      email: 'admin@test.com',
      role: 'admin',
      tenantId: 'tenant-1',
    }
  })

  it('returns_401_when_unauthenticated', async () => {
    mockUserRef.current = null

    const res = await request(setup())
      .post('/api/admin/outbox/pause')
      .send()

    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Unauthorized')
  })

  it('returns_403_when_not_admin', async () => {
    mockUserRef.current = {
      id: 'user-1',
      email: 'user@test.com',
      role: 'user',
      tenantId: 'tenant-1',
    }

    const res = await request(setup())
      .post('/api/admin/outbox/pause')
      .send()

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Forbidden')
  })

  it('returns_200_on_successful_pause', async () => {
    const res = await request(setup())
      .post('/api/admin/outbox/pause')
      .send()

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, message: 'Outbox publisher paused' })
  })

  it('writes_audit_log_entry_on_successful_pause', async () => {
    await request(setup())
      .post('/api/admin/outbox/pause')
      .send()

    expect(mockAuditLogService.logAction).toHaveBeenCalledTimes(1)

    const callArgs = mockAuditLogService.logAction.mock.calls[0]
    expect(callArgs[0]).toBe('tenant-1')
    expect(callArgs[1]).toBe('admin-1')
    expect(callArgs[2]).toBe('admin@test.com')
    expect(callArgs[3]).toBe('OUTBOX_PAUSE')
    expect(callArgs[4]).toBe('admin-1')
    expect(callArgs[7]).toBe('success')
    expect(callArgs[9]).toBeDefined()
  })
})
