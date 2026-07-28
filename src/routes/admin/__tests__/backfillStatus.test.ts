import { describe, it, expect, vi, beforeEach } from 'vitest'
import express, { type Request, type Response, type NextFunction } from 'express'
import request from 'supertest'
import systemRouter from '../system.js'

const { currentCallerRef, mockPool, mockApp } = vi.hoisted(() => {
  const userRef: { user: { id: string; email: string; role: string; tenantId: string } | null } = {
    user: null,
  }
  return {
    currentCallerRef: userRef,
    mockPool: { query: vi.fn() },
    mockApp: {
      requireUserAuth: (req: Request, res: Response, next: NextFunction) => {
        if (!userRef.user) {
          res.status(401).json({ error: 'Unauthorized', message: 'User authentication required' })
          return
        }
        ;(req as any).user = { ...userRef.user }
        next()
      },
      requireAdminRole: (req: Request, res: Response, next: NextFunction) => {
        const user = (req as any).user
        if (!user) {
          res.status(401).json({ error: 'Unauthorized', message: 'User authentication required' })
          return
        }
        const role = user.role
        if (role !== 'admin' && role !== 'super-admin' && role !== 'super_admin') {
          res.status(403).json({ error: 'Forbidden', message: 'Admin role required' })
          return
        }
        next()
      },
    },
  }
})

vi.mock('../../../middleware/auth.ts', () => ({
  requireUserAuth: mockApp.requireUserAuth,
  requireAdminRole: mockApp.requireAdminRole,
  AuthenticatedRequest: class {},
  UserRole: {
    SUPER_ADMIN: 'super-admin',
    ADMIN: 'admin',
    VERIFIER: 'verifier',
    USER: 'user',
  },
}))

vi.mock('../../../db/pool.js', () => ({
  pool: mockPool,
}))

function setup() {
  const app = express()
  app.use(express.json())
  app.use('/api/admin/system', systemRouter)
  return app
}

describe('Admin System Router - GET /backfill-status', () => {
  beforeEach(() => {
    // Don't use vi.clearAllMocks() — it can interfere with module mock factory closures.
    // Only reset specific mocks that need resetting.
    mockPool.query.mockReset()
    mockPool.query.mockResolvedValue({ rows: [] })
    currentCallerRef.user = {
      id: 'admin-1',
      email: 'admin@test.com',
      role: 'admin',
      tenantId: 'tenant-1',
    }
  })

  it('returns_401_when_unauthenticated', async () => {
    currentCallerRef.user = null

    const res = await request(setup())
      .get('/api/admin/system/backfill-status')
      .send()

    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Unauthorized')
  })

  it('returns_403_when_not_admin', async () => {
    currentCallerRef.user = {
      id: 'user-1',
      email: 'user@test.com',
      role: 'user',
      tenantId: 'tenant-1',
    }

    const res = await request(setup())
      .get('/api/admin/system/backfill-status')
      .send()

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Forbidden')
  })

  it('returns_200_with_empty_data_when_no_backfills_exist', async () => {
    const res = await request(setup())
      .get('/api/admin/system/backfill-status')
      .send()

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data).toEqual([])
  })

  it('returns_fresh_pending_backfill_status_correctly', async () => {
    const now = new Date()
    mockPool.query.mockResolvedValue({
      rows: [{
        job_name: 'fresh_backfill',
        cursor_value: '0',
        rows_processed: 0,
        total_rows: 1000,
        status: 'pending',
        last_error: null,
        created_at: now,
        updated_at: now,
        metadata: {},
      }],
    })

    const res = await request(setup())
      .get('/api/admin/system/backfill-status')
      .send()

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0]).toMatchObject({
      jobName: 'fresh_backfill',
      cursorValue: '0',
      rowsProcessed: 0,
      totalRows: 1000,
      status: 'pending',
      lastError: null,
    })
    expect(typeof res.body.data[0].createdAt).toBe('string')
    expect(typeof res.body.data[0].updatedAt).toBe('string')
  })

  it('returns_in_progress_backfill_status_correctly', async () => {
    const now = new Date()
    mockPool.query.mockResolvedValue({
      rows: [{
        job_name: 'backfill_in_progress',
        cursor_value: '500',
        rows_processed: 500,
        total_rows: 1000,
        status: 'running',
        last_error: null,
        created_at: now,
        updated_at: now,
        metadata: {},
      }],
    })

    const res = await request(setup())
      .get('/api/admin/system/backfill-status')
      .send()

    expect(res.status).toBe(200)
    expect(res.body.data[0]).toMatchObject({
      jobName: 'backfill_in_progress',
      cursorValue: '500',
      rowsProcessed: 500,
      totalRows: 1000,
      status: 'running',
    })
  })

  it('returns_completed_backfill_status_correctly', async () => {
    const now = new Date()
    mockPool.query.mockResolvedValue({
      rows: [{
        job_name: 'backfill_completed',
        cursor_value: '1000',
        rows_processed: 1000,
        total_rows: 1000,
        status: 'completed',
        last_error: null,
        created_at: now,
        updated_at: now,
        metadata: {},
      }],
    })

    const res = await request(setup())
      .get('/api/admin/system/backfill-status')
      .send()

    expect(res.status).toBe(200)
    expect(res.body.data[0]).toMatchObject({
      jobName: 'backfill_completed',
      cursorValue: '1000',
      rowsProcessed: 1000,
      totalRows: 1000,
      status: 'completed',
    })
  })

  it('returns_failed_backfill_status_with_error_message', async () => {
    const now = new Date()
    mockPool.query.mockResolvedValue({
      rows: [{
        job_name: 'backfill_failed',
        cursor_value: '200',
        rows_processed: 200,
        total_rows: 1000,
        status: 'failed',
        last_error: 'Connection timeout',
        created_at: now,
        updated_at: now,
        metadata: {},
      }],
    })

    const res = await request(setup())
      .get('/api/admin/system/backfill-status')
      .send()

    expect(res.status).toBe(200)
    expect(res.body.data[0]).toMatchObject({
      jobName: 'backfill_failed',
      status: 'failed',
      lastError: 'Connection timeout',
    })
  })
})
