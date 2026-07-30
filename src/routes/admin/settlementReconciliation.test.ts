import { describe, it, expect, vi, beforeEach } from 'vitest'
import express, { type Request, type Response, type NextFunction } from 'express'
import request from 'supertest'
import settlementReconciliationRouter from './settlementReconciliation.js'
import { errorHandler } from '../../middleware/errorHandler.js'

// ---- Mock pool.query ----
const mockPoolQuery = vi.fn()

vi.mock('../../db/pool.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
  workerPool: {
    query: vi.fn(),
  },
}))

// ---- Mock auth middleware ----
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

// ---- Mock metrics (avoid prom-client side-effects) ----
vi.mock('../../middleware/metrics.js', () => ({
  register: { registerMetric: vi.fn(), metrics: vi.fn() },
  settlementUnmatchedCount: { set: vi.fn() },
  setSettlementUnmatchedCount: vi.fn(),
}))

// ---- Mock pagination (buildCursorEnvelope used by route) ----
vi.mock('../../lib/pagination.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pagination.js')>()
  return {
    ...actual,
    // Keep real buildCursorEnvelope + encodeCursor
  }
})

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/admin/settlement', settlementReconciliationRouter)
  app.use(errorHandler)
  return app
}

describe('GET /api/admin/settlement/reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUser = {
      id: 'admin-1',
      email: 'admin@test.com',
      role: 'admin',
      tenantId: 'tenant-1',
    }
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Empty state
  // ──────────────────────────────────────────────────────────────────────────

  it('returns data: null when no reconciliation run exists', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }) // runs query

    const res = await request(createApp()).get('/api/admin/settlement/reconciliation')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, data: null })
    expect(mockPoolQuery).toHaveBeenCalledTimes(1)
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Matched-only run (0 discrepancies)
  // ──────────────────────────────────────────────────────────────────────────

  it('returns summary with empty findings when run has no discrepancies', async () => {
    const runAt = new Date('2026-06-30T12:00:00.000Z')

    // 1st call: latest run
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{
        id: 'run-1',
        checked: 5,
        discrepancies: 0,
        errors: 0,
        run_at: runAt,
      }],
    })

    // 2nd call: findings (empty)
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })

    const res = await request(createApp()).get('/api/admin/settlement/reconciliation')

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.summary).toEqual({
      checked: 5,
      discrepancies: 0,
      errors: 0,
      runAt: '2026-06-30T12:00:00.000Z',
    })
    expect(res.body.data.findings.data).toEqual([])
    expect(res.body.data.findings.page.hasMore).toBe(false)
    expect(res.body.data.findings.page.nextCursor).toBeNull()
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Discrepancy-present run
  // ──────────────────────────────────────────────────────────────────────────

  it('returns summary and paginated findings when discrepancies exist', async () => {
    const runAt = new Date('2026-06-30T14:00:00.000Z')
    const findingCreatedAt = new Date('2026-06-30T14:00:01.000Z')

    // 1st call: latest run
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{
        id: 'run-2',
        checked: 10,
        discrepancies: 2,
        errors: 0,
        run_at: runAt,
      }],
    })

    // 2nd call: findings
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'finding-1',
          settlement_id: 'settlement-a',
          finding_type: 'state_mismatch',
          details: { internalStatus: 'settled', chainStatus: 'failed' },
          created_at: findingCreatedAt,
        },
        {
          id: 'finding-2',
          settlement_id: 'settlement-b',
          finding_type: 'missing_on_chain',
          details: { internalStatus: 'settled', error: 'Not found' },
          created_at: findingCreatedAt,
        },
      ],
    })

    const res = await request(createApp()).get('/api/admin/settlement/reconciliation')

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.summary.discrepancies).toBe(2)
    expect(res.body.data.findings.data).toHaveLength(2)
    expect(res.body.data.findings.data[0].findingType).toBe('state_mismatch')
    expect(res.body.data.findings.data[1].findingType).toBe('missing_on_chain')
    expect(res.body.data.findings.page.hasMore).toBe(false)
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Pagination: hasMore + nextCursor
  // ──────────────────────────────────────────────────────────────────────────

  it('returns hasMore and nextCursor when more findings exist', async () => {
    const runAt = new Date('2026-06-30T14:00:00.000Z')
    const findingTime = new Date('2026-06-30T14:00:01.000Z')

    // 1st call: latest run
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{
        id: 'run-3',
        checked: 100,
        discrepancies: 5,
        errors: 0,
        run_at: runAt,
      }],
    })

    // 2nd call: findings — limit is 2, so return 3 rows to signal hasMore
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'finding-a',
          settlement_id: 'sa',
          finding_type: 'state_mismatch',
          details: {},
          created_at: findingTime,
        },
        {
          id: 'finding-b',
          settlement_id: 'sb',
          finding_type: 'missing_on_chain',
          details: {},
          created_at: findingTime,
        },
        {
          id: 'finding-c',
          settlement_id: 'sc',
          finding_type: 'state_mismatch',
          details: {},
          created_at: findingTime,
        },
      ],
    })

    const res = await request(createApp())
      .get('/api/admin/settlement/reconciliation')
      .query({ limit: '2' })

    expect(res.status).toBe(200)
    expect(res.body.data.findings.data).toHaveLength(2)
    expect(res.body.data.findings.page.hasMore).toBe(true)
    expect(res.body.data.findings.page.nextCursor).toBeTruthy()
    expect(res.body.data.findings.page.limit).toBe(2)
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Cursor pagination — second page
  // ──────────────────────────────────────────────────────────────────────────

  it('accepts a cursor and queries the next page', async () => {
    const runAt = new Date('2026-06-30T14:00:00.000Z')
    const cursorCreatedAt = '2026-06-30T14:00:01.000Z'
    const cursorId = 'finding-b'
    const cursor = Buffer.from(`${cursorCreatedAt}|${cursorId}`, 'utf8').toString('base64url')

    // 1st call: latest run
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{
        id: 'run-4',
        checked: 50,
        discrepancies: 3,
        errors: 0,
        run_at: runAt,
      }],
    })

    // 2nd call: findings for second page
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'finding-c',
          settlement_id: 'sc',
          finding_type: 'state_mismatch',
          details: { internalStatus: 'pending', chainStatus: 'settled' },
          created_at: new Date('2026-06-30T14:00:00.500Z'),
        },
      ],
    })

    const res = await request(createApp())
      .get('/api/admin/settlement/reconciliation')
      .query({ cursor, limit: '20' })

    expect(res.status).toBe(200)
    expect(res.body.data.findings.data).toHaveLength(1)
    expect(res.body.data.findings.page.hasMore).toBe(false)

    // Verify cursor was decoded and used in the query
    const findingsCall = mockPoolQuery.mock.calls[1]
    expect(findingsCall[1]).toEqual(['run-4', cursorCreatedAt, cursorId, 21])
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Invalid cursor
  // ──────────────────────────────────────────────────────────────────────────

  it('returns 400 for an invalid cursor format', async () => {
    const runAt = new Date('2026-06-30T14:00:00.000Z')

    mockPoolQuery.mockResolvedValueOnce({
      rows: [{
        id: 'run-5',
        checked: 1,
        discrepancies: 1,
        errors: 0,
        run_at: runAt,
      }],
    })

    const res = await request(createApp())
      .get('/api/admin/settlement/reconciliation')
      .query({ cursor: 'not-a-valid-cursor' })

    expect(res.status).toBe(400)
    expect(res.body.success).toBe(false)
    expect(res.body.code).toBe('validation_failed')
  })

  // ──────────────────────────────────────────────────────────────────────────
  // RBAC: unauthenticated
  // ──────────────────────────────────────────────────────────────────────────

  it('rejects unauthenticated callers with 401', async () => {
    mockUser = null

    const res = await request(createApp()).get('/api/admin/settlement/reconciliation')

    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Unauthorized')
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  // ──────────────────────────────────────────────────────────────────────────
  // RBAC: non-admin
  // ──────────────────────────────────────────────────────────────────────────

  it('rejects non-admin callers with 403', async () => {
    mockUser = {
      id: 'user-1',
      email: 'user@test.com',
      role: 'user',
      tenantId: 'tenant-1',
    }

    const res = await request(createApp()).get('/api/admin/settlement/reconciliation')

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Forbidden')
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Validation: rejects unknown query params
  // ──────────────────────────────────────────────────────────────────────────

  it('rejects unknown query params with validation error', async () => {
    const res = await request(createApp())
      .get('/api/admin/settlement/reconciliation')
      .query({ unexpected: 'value' })

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('validation_failed')
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })
})
