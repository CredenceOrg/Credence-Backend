import { describe, it, expect, vi, beforeEach } from 'vitest'
import express, { Request, Response, NextFunction } from 'express'
import request from 'supertest'
import { createAdminRouter } from './index.js'

// ---- Mock middleware ----
vi.mock('../../middleware/auth.ts', () => ({
  requireUserAuth: (req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = { id: 'admin-1', email: 'admin@test.com' }
    next()
  },
  requireAdminRole: (_req: Request, _res: Response, next: NextFunction) => next(),
}))

// ---- Mock AdminService ----
const mockAdminService = {
  listUsers: vi.fn(),
  assignRole: vi.fn(),
  revokeApiKey: vi.fn(),
  getAuditLogs: vi.fn(),
  exportAuditLogs: vi.fn(),
  logExportCompletion: vi.fn(),
}

vi.mock('../../services/admin/index.js', () => ({
  AdminService: vi.fn().mockImplementation(() => mockAdminService),
}))

// ---- Mock impersonation service ----
const mockImpersonationService = {
  issueToken: vi.fn(),
  revokeToken: vi.fn(),
}

vi.mock('../../services/impersonation/index.js', () => ({
  impersonationService: mockImpersonationService,
}))

// ---- Mock pagination ----
vi.mock('../../lib/pagination.ts', () => ({
  parsePaginationParams: vi.fn().mockReturnValue({ page: 1, limit: 10, offset: 0 }),
  buildPaginationMeta: vi.fn().mockReturnValue({ totalPages: 1 }),
}))

// ---- Mock ReplayService ----
vi.mock('../../services/replayService.js', () => ({
  ReplayService: vi.fn().mockImplementation(() => ({
    listFailedEvents: vi.fn().mockResolvedValue({ events: [], total: 0 }),
    replayEvent: vi.fn().mockResolvedValue({ success: true }),
  })),
}))

// ---- Mock repositories ----
vi.mock('../../db/repositories/failedInboundEventsRepository.js', () => ({
  FailedInboundEventsRepository: vi.fn().mockImplementation(() => ({})),
}))

vi.mock('../../db/repositories/identityRepository.js', () => ({
  IdentityRepository: vi.fn().mockImplementation(() => ({})),
}))

vi.mock('../../db/repositories/bondsRepository.js', () => ({
  BondsRepository: vi.fn().mockImplementation(() => ({})),
}))

vi.mock('../../services/replayHandlers.js', () => ({
  registerAllReplayHandlers: vi.fn(),
}))

function setup() {
  const app = express()
  app.use(express.json())
  app.use('/api/admin', createAdminRouter())
  return app
}

describe('Admin Router - Strict Validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('POST /api/admin/roles/assign', () => {
    it('should reject unknown fields in assign role request', async () => {
      mockAdminService.assignRole.mockResolvedValue({
        user: { id: 'u1' },
        message: 'assigned',
      })

      const res = await request(setup())
        .post('/api/admin/roles/assign')
        .send({ userId: 'u1', role: 'admin', maliciousField: 'attack' })

      expect(res.status).toBe(400)
      expect(res.body.code).toBe('validation_failed')
    })

    it('should accept valid assign role request', async () => {
      mockAdminService.assignRole.mockResolvedValue({
        user: { id: 'u1' },
        message: 'assigned',
      })

      const res = await request(setup())
        .post('/api/admin/roles/assign')
        .send({ userId: 'u1', role: 'admin' })

      expect(res.status).toBe(200)
    })
  })

  describe('POST /api/admin/keys/revoke', () => {
    it('should reject unknown fields in revoke API key request', async () => {
      mockAdminService.revokeApiKey.mockResolvedValue({
        message: 'revoked',
      })

      const res = await request(setup())
        .post('/api/admin/keys/revoke')
        .send({ userId: 'u1', apiKey: 'key123', maliciousField: 'attack' })

      expect(res.status).toBe(400)
      expect(res.body.code).toBe('validation_failed')
    })

    it('should accept valid revoke API key request', async () => {
      mockAdminService.revokeApiKey.mockResolvedValue({
        message: 'revoked',
      })

      const res = await request(setup())
        .post('/api/admin/keys/revoke')
        .send({ userId: 'u1', apiKey: 'key123' })

      expect(res.status).toBe(200)
    })
  })

  describe('POST /api/admin/impersonate', () => {
    it('should reject unknown fields in impersonate request', async () => {
      mockImpersonationService.issueToken.mockReturnValue({
        tokenId: 'token123',
        targetUserId: 'u1',
        targetUserEmail: 'user@test.com',
        expiresAt: '2024-01-01T00:00:00Z',
        ttlSeconds: 900,
      })

      const res = await request(setup())
        .post('/api/admin/impersonate')
        .send({ targetUserId: 'u1', reason: 'debug', maliciousField: 'attack' })

      expect(res.status).toBe(400)
      expect(res.body.code).toBe('validation_failed')
    })

    it('should accept valid impersonate request', async () => {
      mockImpersonationService.issueToken.mockReturnValue({
        tokenId: 'token123',
        targetUserId: 'u1',
        targetUserEmail: 'user@test.com',
        expiresAt: '2024-01-01T00:00:00Z',
        ttlSeconds: 900,
      })

      const res = await request(setup())
        .post('/api/admin/impersonate')
        .send({ targetUserId: 'u1', reason: 'debug' })

      expect(res.status).toBe(201)
    })
  })
})
