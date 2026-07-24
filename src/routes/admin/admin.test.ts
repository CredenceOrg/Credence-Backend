import { describe, it, expect, vi, beforeEach } from 'vitest'
import express, { Request, Response, NextFunction } from 'express'
import request from 'supertest'
import { createAdminRouter } from './index.js'

// ---- Mock middleware ----
vi.mock('../../middleware/auth.ts', () => ({
  UserRole: {
    ADMIN: 'admin',
    VERIFIER: 'verifier',
    USER: 'user',
  },
  requireUserAuth: (req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = { id: 'admin-1', email: 'admin@test.com' }
    next()
  },
  requireAdminRole: (_req: Request, _res: Response, next: NextFunction) => next(),
}))

// ---- Mock AdminService & ImpersonationService ----
const { mockAdminService, mockImpersonationService } = vi.hoisted(() => ({
  mockAdminService: {
    listUsers: vi.fn(),
    assignRole: vi.fn(),
    revokeApiKey: vi.fn(),
    getAuditLogs: vi.fn(),
    exportAuditLogs: vi.fn(),
    logExportCompletion: vi.fn(),
  },
  mockImpersonationService: {
    issueToken: vi.fn(),
    revokeToken: vi.fn(),
  },
}))

vi.mock('../../services/admin/index.js', () => ({
  AdminService: class {
    listUsers = mockAdminService.listUsers
    assignRole = mockAdminService.assignRole
    revokeApiKey = mockAdminService.revokeApiKey
    getAuditLogs = mockAdminService.getAuditLogs
    exportAuditLogs = mockAdminService.exportAuditLogs
    logExportCompletion = mockAdminService.logExportCompletion
  },
}))

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
  ReplayService: class {
    listFailedEvents = vi.fn().mockResolvedValue({ events: [], total: 0 })
    replayEvent = vi.fn().mockResolvedValue({ success: true })
  },
}))

// ---- Mock repositories ----
vi.mock('../../db/repositories/failedInboundEventsRepository.js', () => ({
  FailedInboundEventsRepository: class {},
}))

vi.mock('../../db/repositories/identityRepository.js', () => ({
  IdentityRepository: class {},
}))

vi.mock('../../db/repositories/bondsRepository.js', () => ({
  BondsRepository: class {},
}))

vi.mock('../../services/replayHandlers.js', () => ({
  registerAllReplayHandlers: vi.fn(),
}))

import { errorHandler } from '../../middleware/errorHandler.js'

function setup() {
  const app = express()
  app.use(express.json())
  app.use('/api/admin', createAdminRouter())
  app.use(errorHandler)
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

  describe('POST /api/admin/reload-config', () => {
    it('should reject invalid secrets from the vault and surface a typed error', async () => {
      // Temporarily mock fs and dotenv just for this test
      const fs = await import('fs')
      const dotenv = await import('dotenv')
      
      const existsSyncSpy = vi.spyOn(fs.default, 'existsSync').mockReturnValue(true)
      const readFileSyncSpy = vi.spyOn(fs.default, 'readFileSync').mockReturnValue(Buffer.from('JWT_SECRET=short'))
      const parseSpy = vi.spyOn(dotenv.default, 'parse').mockReturnValue({ JWT_SECRET: 'short' })
      
      const res = await request(setup())
        .post('/api/admin/reload-config')
        .send()
        
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('ConfigValidationError')
      
      existsSyncSpy.mockRestore()
      readFileSyncSpy.mockRestore()
      parseSpy.mockRestore()
    })

    it('should successfully refresh secrets if valid', async () => {
      const fs = await import('fs')
      const dotenv = await import('dotenv')
      
      // Ensure we pass validateConfig by having a valid candidateEnv
      const originalEnv = { ...process.env }
      process.env.DB_URL = 'postgres://localhost/test'
      process.env.REDIS_URL = 'redis://localhost/test'
      process.env.JWT_SECRET = 'valid-secret-at-least-32-chars-long'

      const existsSyncSpy = vi.spyOn(fs.default, 'existsSync').mockReturnValue(true)
      const readFileSyncSpy = vi.spyOn(fs.default, 'readFileSync').mockReturnValue(Buffer.from('JWT_SECRET=new-valid-secret-at-least-32-chars-long'))
      const parseSpy = vi.spyOn(dotenv.default, 'parse').mockReturnValue({ JWT_SECRET: 'new-valid-secret-at-least-32-chars-long' })
      
      const res = await request(setup())
        .post('/api/admin/reload-config')
        .send()
        
      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(process.env.JWT_SECRET).toBe('new-valid-secret-at-least-32-chars-long')
      
      existsSyncSpy.mockRestore()
      readFileSyncSpy.mockRestore()
      parseSpy.mockRestore()
      process.env = originalEnv
    })
  })

  describe('POST /api/admin/refresh-secrets', () => {
    it('should gracefully fallback and work just like reload-config for backwards compatibility', async () => {
      const fs = await import('fs')
      const dotenv = await import('dotenv')
      
      const originalEnv = { ...process.env }
      process.env.DB_URL = 'postgres://localhost/test'
      process.env.REDIS_URL = 'redis://localhost/test'
      process.env.JWT_SECRET = 'valid-secret-at-least-32-chars-long'

      const existsSyncSpy = vi.spyOn(fs.default, 'existsSync').mockReturnValue(true)
      const readFileSyncSpy = vi.spyOn(fs.default, 'readFileSync').mockReturnValue(Buffer.from('JWT_SECRET=new-valid-secret-at-least-32-chars-long'))
      const parseSpy = vi.spyOn(dotenv.default, 'parse').mockReturnValue({ JWT_SECRET: 'new-valid-secret-at-least-32-chars-long' })
      
      const res = await request(setup())
        .post('/api/admin/refresh-secrets')
        .send()
        
      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(process.env.JWT_SECRET).toBe('new-valid-secret-at-least-32-chars-long')
      
      existsSyncSpy.mockRestore()
      readFileSyncSpy.mockRestore()
      parseSpy.mockRestore()
      process.env = originalEnv
    })
  })
})

describe('Admin Anti-Crawling Defenses', () => {
  it('should reject requests from known crawler User-Agents with a typed error', async () => {
    const response = await request(setup())
      .get('/admin') // Adjust if the path is wrong
      .set('User-Agent', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)');

    expect(response.status).toBe(403);
    
    // Adjust Zod/Error catalog shape is wrong.
    expect(response.body).toMatchObject({
      error: expect.objectContaining({
        code: 'ADMIN_CRAWLER_BLOCKED'
      })
    });
  });

  it('should attach X-Robots-Tag headers to legitimate admin requests', async () => {
    const response = await request(setup())
      .get('/admin')
      .set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

    expect(response.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive, nosnippet');
  });
});