import { describe, it, expect, vi, beforeEach } from 'vitest'
import express, { type Request, type Response, type NextFunction } from 'express'
import request from 'supertest'
import auditChainStatusRouter from './auditChainStatus.js'
import { errorHandler } from '../../middleware/errorHandler.js'

const mockGetChainVerificationStatus = vi.fn()

vi.mock('../../services/audit/index.js', () => ({
  auditLogService: {
    getChainVerificationStatus: (...args: unknown[]) => mockGetChainVerificationStatus(...args),
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
}))

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/admin/audit', auditChainStatusRouter)
  app.use(errorHandler)
  return app
}

describe('GET /api/admin/audit/chain-status', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUser = {
      id: 'admin-1',
      email: 'admin@test.com',
      role: 'admin',
      tenantId: 'tenant-1',
    }
  })

  it('returns never_run when verifier has not run yet', async () => {
    mockGetChainVerificationStatus.mockResolvedValue(null)

    const res = await request(createApp()).get('/api/admin/audit/chain-status')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      success: true,
      data: {
        lastVerifiedHeight: 0,
        verifiedAt: null,
        status: 'never_run',
      },
    })
  })

  it('returns persisted valid verification state for admin callers', async () => {
    mockGetChainVerificationStatus.mockResolvedValue({
      lastVerifiedHeight: 10,
      verifiedAt: '2025-06-01T12:00:00.000Z',
      status: 'valid',
      violationCount: 0,
      rowsChecked: 10,
    })

    const res = await request(createApp()).get('/api/admin/audit/chain-status')

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.status).toBe('valid')
    expect(res.body.data.lastVerifiedHeight).toBe(10)
  })

  it('returns break_detected path with firstBreakSeq', async () => {
    mockGetChainVerificationStatus.mockResolvedValue({
      lastVerifiedHeight: 2,
      verifiedAt: '2025-06-01T12:05:00.000Z',
      status: 'break_detected',
      firstBreakSeq: 3,
      violationCount: 1,
      rowsChecked: 5,
    })

    const res = await request(createApp()).get('/api/admin/audit/chain-status')

    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('break_detected')
    expect(res.body.data.firstBreakSeq).toBe(3)
    expect(res.body.data.lastVerifiedHeight).toBe(2)
  })

  it('handles chain break at sequence 0 (first row)', async () => {
    mockGetChainVerificationStatus.mockResolvedValue({
      lastVerifiedHeight: 0,
      verifiedAt: '2025-06-01T12:10:00.000Z',
      status: 'break_detected',
      firstBreakSeq: 1,
      violationCount: 1,
      rowsChecked: 1,
    })

    const res = await request(createApp()).get('/api/admin/audit/chain-status')

    expect(res.status).toBe(200)
    expect(res.body.data.lastVerifiedHeight).toBe(0)
    expect(res.body.data.firstBreakSeq).toBe(1)
  })

  it('rejects unauthenticated callers with 401', async () => {
    mockUser = null

    const res = await request(createApp()).get('/api/admin/audit/chain-status')

    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Unauthorized')
    expect(mockGetChainVerificationStatus).not.toHaveBeenCalled()
  })

  it('rejects non-admin callers with 403', async () => {
    mockUser = {
      id: 'user-1',
      email: 'user@test.com',
      role: 'user',
      tenantId: 'tenant-1',
    }

    const res = await request(createApp()).get('/api/admin/audit/chain-status')

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Forbidden')
    expect(mockGetChainVerificationStatus).not.toHaveBeenCalled()
  })

  it('rejects unknown query params with validation error', async () => {
    mockGetChainVerificationStatus.mockResolvedValue(null)

    const res = await request(createApp())
      .get('/api/admin/audit/chain-status')
      .query({ unexpected: 'value' })

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('validation_failed')
    expect(mockGetChainVerificationStatus).not.toHaveBeenCalled()
  })
})
