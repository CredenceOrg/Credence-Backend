import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import fs from 'node:fs'
import path from 'node:path'
import type { Request, Response, NextFunction } from 'express'

const {
  mockListOverrides,
  mockListMembers,
  mockFindManyPaginated,
  mockExportLogsStream,
  mockListSlashRequests,
} = vi.hoisted(() => ({
  mockListOverrides: vi.fn().mockResolvedValue([]),
  mockListMembers: vi.fn().mockResolvedValue({ members: [], total: 0 }),
  mockFindManyPaginated: vi.fn().mockResolvedValue([]),
  mockExportLogsStream: vi.fn().mockImplementation(async function* () {}),
  mockListSlashRequests: vi.fn().mockReturnValue({ requests: [], total: 0 }),
}))

vi.mock('../middleware/tenantContext.js', () => ({
  tenantContextMiddleware: (req: Request, _res: Response, next: NextFunction) => {
    ;(req as any).tenantContext = { tenantId: 'tenant-1' }
    next()
  },
}))

vi.mock('../middleware/rateLimit.js', () => ({
  createRateLimitMiddleware: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  rateLimit: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}))

vi.mock('../middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth.js')>()
  return {
    ...actual,
    requireUserAuth: (req: Request, _res: Response, next: NextFunction) => {
      ;(req as any).user = {
        id: 'admin-1',
        email: 'admin@credence.org',
        role: 'admin',
        tenantId: 'tenant-1',
      }
      next()
    },
    requireAdminRole: (_req: Request, _res: Response, next: NextFunction) => {
      next()
    },
    requireApiKey: () => (_req: Request, _res: Response, next: NextFunction) => {
      next()
    },
  }
})

vi.mock('../services/rateLimitOverride/service.js', () => ({
  RateLimitOverrideService: class {
    listOverrides = mockListOverrides
    setOverride = vi.fn()
    removeOverride = vi.fn()
  },
}))

vi.mock('../services/members/factory.ts', () => ({
  MemberService: class {
    listMembers = mockListMembers
    inviteMember = vi.fn()
    updateMemberRole = vi.fn()
    deleteMember = vi.fn()
    restoreMember = vi.fn()
  },
}))

vi.mock('../db/repositories/settlementsRepository.js', () => ({
  SettlementsRepository: class {
    findManyPaginated = mockFindManyPaginated
  },
}))

vi.mock('../services/audit/index.js', () => ({
  auditLogService: {
    exportLogsStream: mockExportLogsStream,
    logAction: vi.fn().mockResolvedValue(undefined),
  },
  AuditLogService: class {
    exportLogsStream = mockExportLogsStream
    logAction = vi.fn().mockResolvedValue(undefined)
  },
  AuditAction: {},
}))

vi.mock('../services/governance/slashingVotes.js', () => ({
  listSlashRequests: mockListSlashRequests,
  createSlashRequest: vi.fn(),
  getSlashRequest: vi.fn(),
  submitVote: vi.fn(),
}))

import app from '../app.js'
import { errorHandler } from '../middleware/errorHandler.js'

describe('src/app.ts mounted routers & error-handler ordering (#1611)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListOverrides.mockResolvedValue([])
    mockListMembers.mockResolvedValue({ members: [], total: 0 })
    mockFindManyPaginated.mockResolvedValue([])
    mockExportLogsStream.mockImplementation(async function* () {})
    mockListSlashRequests.mockReturnValue({ requests: [], total: 0 })
  })

  describe('previously orphaned routers reach their handlers (non-404)', () => {
    it('GET /api/admin/rate-limits/overrides reaches createRateLimitOverridesAdminRouter', async () => {
      const res = await request(app).get('/api/admin/rate-limits/overrides')
      expect(res.status).not.toBe(404)
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ success: true, data: [] })
    })

    it('GET /api/admin/orgs/:orgId/members reaches createMembersRouter with merged :orgId param', async () => {
      const res = await request(app).get('/api/admin/orgs/org-1/members')
      expect(res.status).not.toBe(404)
      expect(res.status).toBe(200)
      expect(mockListMembers).toHaveBeenCalledWith(
        'tenant-1',
        'admin-1',
        'admin@credence.org',
        'org-1',
        expect.any(Object),
        false,
      )
    })

    it('GET /api/transactions/history reaches createTransactionsRouter', async () => {
      const res = await request(app).get('/api/transactions/history')
      expect(res.status).not.toBe(404)
      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        success: true,
        data: [],
        next_cursor: null,
      })
    })

    it('GET /api/audit/export reaches createAuditLogRouter behind requireUserAuth', async () => {
      const res = await request(app).get('/api/audit/export')
      expect(res.status).not.toBe(404)
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toMatch(/application\/x-ndjson/)
    })
  })

  describe('governance error handling via global errorHandler', () => {
    it('returns JSON error envelope without stack trace when governance route calls next(new Error("boom"))', async () => {
      mockListSlashRequests.mockImplementationOnce(() => {
        throw new Error('boom')
      })

      const res = await request(app).get('/api/governance/slash-requests')

      expect(res.status).toBe(500)
      expect(res.headers['content-type']).toMatch(/application\/json/)
      expect(res.body).toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        error_code: 'INTERNAL_SERVER_ERROR',
      })
      expect(res.text).not.toContain('at ')
    })
  })

  describe('router stack and index.ts guards', () => {
    it('keeps errorHandler as the final layer in app._router.stack and mounts each router path once', () => {
      const stack: Array<{ name: string; handle: unknown; regexp: RegExp }> = (app as any)._router.stack
      expect(stack.length).toBeGreaterThan(0)

      const lastLayer = stack[stack.length - 1]
      expect(lastLayer.handle).toBe(errorHandler)

      const routerLayers = stack.filter((layer) => layer.name === 'router')
      const regexCounts = new Map<string, number>()
      for (const layer of routerLayers) {
        const key = layer.regexp.toString()
        regexCounts.set(key, (regexCounts.get(key) ?? 0) + 1)
      }

      // Specifically verify /api/admin router mount regexp appears only once
      const adminRouterLayers = routerLayers.filter(
        (layer: any) => !layer.regexp.fast_slash && layer.regexp.test('/api/admin'),
      )
      expect(adminRouterLayers).toHaveLength(1)

      for (const [regexStr, count] of regexCounts.entries()) {
        expect(count, `Router mount regexp ${regexStr} registered more than once`).toBe(1)
      }
    })

    it('ensures src/index.ts no longer contains any app.use( calls', () => {
      const indexSource = fs.readFileSync(path.resolve(__dirname, '../index.ts'), 'utf8')
      expect(indexSource).not.toContain('app.use(')
    })
  })
})
