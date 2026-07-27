import { describe, it, expect, vi, beforeEach } from 'vitest'
import express, { Request, Response, NextFunction } from 'express'
import request from 'supertest'

const { mockUserRef, mockAuditLogService, mockWebhookService } = vi.hoisted(() => ({
  mockUserRef: { current: null as { id: string; email: string; role: string; tenantId: string } | null },
  mockAuditLogService: {
    logAction: vi.fn().mockResolvedValue(undefined),
  },
  mockWebhookService: {
    rotateSecret: vi.fn(),
    revokePreviousSecret: vi.fn(),
  },
}))

vi.mock('../../middleware/auth.js', () => ({
  UserRole: { ADMIN: 'admin', SUPER_ADMIN: 'super_admin', VERIFIER: 'verifier', USER: 'user' },
  ApiScope: { WEBHOOKS_ADMIN: 'webhooks:admin' },
  requireUserAuth: (req: Request, res: Response, next: NextFunction) => {
    const user = mockUserRef.current
    if (!user) {
      res.status(401).json({ error: 'Unauthorized', message: 'User authentication required' })
      return
    }
    ;(req as any).user = user
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
}))

vi.mock('../../services/audit/index.js', () => ({
  auditLogService: mockAuditLogService,
  AuditAction: { ROTATE_WEBHOOK_SECRET: 'ROTATE_WEBHOOK_SECRET' },
}))

vi.mock('../../db/pool.js', () => ({ pool: {} }))

vi.mock('../../db/repositories/webhookRepository.js', () => ({
  PostgresWebhookRepository: class {},
}))

vi.mock('../../services/webhooks/service.js', () => ({
  WebhookService: class {
    rotateSecret = mockWebhookService.rotateSecret
    revokePreviousSecret = mockWebhookService.revokePreviousSecret
  },
}))

import { createWebhookAdminRouter } from './webhooks.js'
import { errorHandler } from '../../middleware/errorHandler.js'

function setup() {
  const app = express()
  app.use(express.json())
  app.use('/api/admin/webhooks', createWebhookAdminRouter())
  app.use(errorHandler)
  return app
}

describe('Webhook admin router — structured error codes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUserRef.current = {
      id: 'user-1',
      email: 'user@test.com',
      role: 'verifier',
      tenantId: 'tenant-1',
    }
  })

  describe('POST /:id/rotate', () => {
    it('rejects non-admin callers with a stable machine-readable code, not just a bare "Forbidden" string', async () => {
      const res = await request(setup())
        .post('/api/admin/webhooks/wh-1/rotate')
        .send({})

      expect(res.status).toBe(403)
      expect(res.body.error).toBe('Admin role required')
      expect(res.body.code).toBe('forbidden')
      expect(res.body.error_code).toBe('forbidden')
    })

    it('records a failure audit entry when a non-admin is rejected', async () => {
      await request(setup())
        .post('/api/admin/webhooks/wh-1/rotate')
        .send({})

      expect(mockAuditLogService.logAction).toHaveBeenCalledTimes(1)
      expect(mockAuditLogService.logAction.mock.calls[0][3]).toBe('ROTATE_WEBHOOK_SECRET')
    })

    it('rotates the secret for admin callers', async () => {
      mockUserRef.current = { id: 'admin-1', email: 'admin@test.com', role: 'admin', tenantId: 'tenant-1' }
      mockWebhookService.rotateSecret.mockResolvedValue({
        id: 'wh-1',
        secret: 'new-secret',
        secretUpdatedAt: '2026-01-01T00:00:00Z',
      })

      const res = await request(setup())
        .post('/api/admin/webhooks/wh-1/rotate')
        .send({})

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.id).toBe('wh-1')
    })
  })
})
