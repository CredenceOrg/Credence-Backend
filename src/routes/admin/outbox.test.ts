import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express, { Request, Response, NextFunction } from 'express'
import request from 'supertest'
import { createOutboxAdminRouter } from './outbox.js'
import { resetWorkerHealthState } from '../../services/health/runtimeState.js'

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

vi.mock('../../services/audit/index.js', () => ({
  auditLogService: mockAuditLogService,
  AuditAction: {
    LIST_OUTBOX_QUARANTINE: 'LIST_OUTBOX_QUARANTINE',
    OUTBOX_REINJECT: 'OUTBOX_REINJECT',
    OUTBOX_PAUSE: 'OUTBOX_PAUSE',
    OUTBOX_RESUME: 'OUTBOX_RESUME',
  },
}))

function setup() {
  const app = express()
  app.use(express.json())
  app.use('/api/admin/outbox', createOutboxAdminRouter())
  return app
}

describe('Admin Outbox Router', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetWorkerHealthState()
    mockUserRef.current = {
      id: 'admin-1',
      email: 'admin@test.com',
      role: 'admin',
      tenantId: 'tenant-1',
    }
  })

  afterEach(() => {
    resetWorkerHealthState()
  })

  describe('POST /pause', () => {
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

    it('returns_200_even_when_called_twice', async () => {
      // Pause is unconditional — calling it multiple times is safe
      await request(setup()).post('/api/admin/outbox/pause').send()

      const res = await request(setup())
        .post('/api/admin/outbox/pause')
        .send()

      expect(res.status).toBe(200)
    })

    it('writes_audit_log_entry_on_pause', async () => {
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

  describe('POST /resume', () => {
    it('returns_200_on_successful_resume_after_pause', async () => {
      // Pause first (sets running = false)
      await request(setup()).post('/api/admin/outbox/pause').send()

      // Then resume
      const res = await request(setup())
        .post('/api/admin/outbox/resume')
        .send()

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ success: true, message: 'Outbox publisher resumed' })
    })

    it('returns_409_when_already_running', async () => {
      // Running is initially false. Pause sets to false. Resume sets to true.
      // A second resume should fail.
      await request(setup()).post('/api/admin/outbox/pause').send()
      await request(setup()).post('/api/admin/outbox/resume').send()

      const res = await request(setup())
        .post('/api/admin/outbox/resume')
        .send()

      expect(res.status).toBe(409)
      expect(res.body.message).toBe('Outbox publisher is already running')
    })

    it('returns_401_when_unauthenticated', async () => {
      mockUserRef.current = null

      const res = await request(setup())
        .post('/api/admin/outbox/resume')
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
        .post('/api/admin/outbox/resume')
        .send()

      expect(res.status).toBe(403)
      expect(res.body.error).toBe('Forbidden')
    })

    it('writes_audit_log_entry_on_successful_resume', async () => {
      // Pause first
      await request(setup()).post('/api/admin/outbox/pause').send()

      // Then resume
      await request(setup()).post('/api/admin/outbox/resume').send()

      // Should have 2 log calls: pause + resume
      expect(mockAuditLogService.logAction).toHaveBeenCalledTimes(2)

      const resumeCallArgs = mockAuditLogService.logAction.mock.calls[1]
      expect(resumeCallArgs[3]).toBe('OUTBOX_RESUME')
      expect(resumeCallArgs[7]).toBe('success')
    })
  })

  describe('GET /status', () => {
    it('returns_200_with_current_status', async () => {
      const res = await request(setup())
        .get('/api/admin/outbox/status')
        .send()

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data).toHaveProperty('running')
      expect(res.body.data).toHaveProperty('configured')
      expect(res.body.data).toHaveProperty('lastHeartbeatAt')
    })

    it('shows_running_false_after_reset', async () => {
      const res = await request(setup())
        .get('/api/admin/outbox/status')
        .send()

      // Default state after resetWorkerHealthState is running: false
      expect(res.body.data.running).toBe(false)
    })

    it('shows_running_false_after_pause', async () => {
      await request(setup()).post('/api/admin/outbox/pause').send()

      const res = await request(setup())
        .get('/api/admin/outbox/status')
        .send()

      expect(res.body.data.running).toBe(false)
    })

    it('shows_running_true_after_resume', async () => {
      await request(setup()).post('/api/admin/outbox/pause').send()
      await request(setup()).post('/api/admin/outbox/resume').send()

      const res = await request(setup())
        .get('/api/admin/outbox/status')
        .send()

      expect(res.body.data.running).toBe(true)
    })

    it('returns_401_when_unauthenticated', async () => {
      mockUserRef.current = null

      const res = await request(setup())
        .get('/api/admin/outbox/status')
        .send()

      expect(res.status).toBe(401)
    })
  })
})
