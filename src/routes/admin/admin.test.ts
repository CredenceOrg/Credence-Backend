import { describe, it, expect, vi, beforeEach } from 'vitest'
import express, { Request, Response, NextFunction } from 'express'
import request from 'supertest'
import { createAdminRouter } from './index.js'
import { idempotencyMiddleware } from '../../middleware/idempotency.js'
import type { IdempotencyRepository, IdempotencyRecord, CreateIdempotencyInput } from '../../db/repositories/idempotencyRepository.js'

// ---- Mutable mock user for RBAC tests ----
const { mockUserRef, mockIdempotencyStore, mockAuditLogService } = vi.hoisted(() => ({
  mockUserRef: { current: null as { id: string; email: string; role: string; tenantId: string } | null },
  mockIdempotencyStore: new Map<string, IdempotencyRecord>(),
  mockAuditLogService: {
    logAction: vi.fn().mockResolvedValue(undefined),
    getAllLogs: vi.fn().mockResolvedValue([]),
    clearLogs: vi.fn().mockResolvedValue(undefined),
    getLogs: vi.fn().mockResolvedValue({ logs: [], hasNextPage: false }),
    exportLogsStream: vi.fn().mockImplementation(async function* () {}),
  },
}))

// ---- Mock middleware ----
vi.mock('../../middleware/auth.ts', () => ({
  UserRole: {
    ADMIN: 'admin',
    VERIFIER: 'verifier',
    USER: 'user',
    SUPER_ADMIN: 'super_admin',
  },
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
}))

// ---- Mock audit log service ----
vi.mock('../../services/audit/index.js', () => ({
  auditLogService: mockAuditLogService,
  AuditAction: {
    UPDATE_SETTINGS: 'UPDATE_SETTINGS',
    LIST_USERS: 'LIST_USERS',
    LIST_FAILED_EVENTS: 'LIST_FAILED_EVENTS',
    REPLAY_REQUEST: 'REPLAY_REQUEST',
    EXPORT_AUDIT_LOGS: 'EXPORT_AUDIT_LOGS',
  },
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

/**
 * In-memory idempotency repository for testing.
 * Matches the real IdempotencyRepository interface but stores records in memory.
 */
class TestIdempotencyRepository implements IdempotencyRepository {
  private store = mockIdempotencyStore

  async findByKey(key: string): Promise<IdempotencyRecord | null> {
    return this.store.get(key) ?? null
  }

  async save(input: CreateIdempotencyInput): Promise<void> {
    this.store.set(input.key, {
      key: input.key,
      actorId: input.actorId,
      requestHash: input.requestHash,
      responseCode: input.responseCode,
      responseBody: input.responseBody,
      ttlSeconds: input.ttlSeconds,
      expiresAt: new Date(Date.now() + (input.expiresInSeconds ?? input.ttlSeconds) * 1000),
      createdAt: new Date(),
    })
  }

  async deleteExpired(): Promise<number> {
    return 0
  }
}

function setup(includeIdempotency = false) {
  const app = express()
  app.use(express.json())

  if (includeIdempotency) {
    const repo = new TestIdempotencyRepository()
    app.use('/api/admin', idempotencyMiddleware(repo))
  }

  app.use('/api/admin', createAdminRouter())
  app.use(errorHandler)
  return app
}

describe('Admin Router - Strict Validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUserRef.current = {
      id: 'admin-1',
      email: 'admin@test.com',
      role: 'admin',
      tenantId: 'tenant-1',
    }
    mockIdempotencyStore.clear()
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

  describe('POST /api/admin/refresh-secrets', () => {
    // ────────────────────────────────────────────────────────────────────────
    // RBAC: only-admin
    // ────────────────────────────────────────────────────────────────────────

    it('rejects unauthenticated callers with 401', async () => {
      mockUserRef.current = null

      const res = await request(setup())
        .post('/api/admin/reload-config')
        .send()

      expect(res.status).toBe(401)
      expect(res.body.error).toBe('Unauthorized')
    })

    it('rejects non-admin callers with 403', async () => {
      mockUserRef.current = {
        id: 'user-1',
        email: 'user@test.com',
        role: 'user',
        tenantId: 'tenant-1',
      }

      const res = await request(setup())
        .post('/api/admin/refresh-secrets')
        .send()

      expect(res.status).toBe(403)
      expect(res.body.error).toBe('Forbidden')
    })

    // ────────────────────────────────────────────────────────────────────────
    // Validation / sad path
    // ────────────────────────────────────────────────────────────────────────

    it('rejects invalid secrets from the vault and surfaces a typed error', async () => {
      const fs = await import('fs')
      const dotenv = await import('dotenv')

      const existsSyncSpy = vi.spyOn(fs.default, 'existsSync').mockReturnValue(true)
      const readFileSyncSpy = vi.spyOn(fs.default, 'readFileSync').mockReturnValue(Buffer.from('JWT_SECRET=short'))
      const parseSpy = vi.spyOn(dotenv.default, 'parse').mockReturnValue({ JWT_SECRET: 'short' })

      const res = await request(setup())
        .post('/api/admin/refresh-secrets')
        .send()

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('ConfigValidationError')

      existsSyncSpy.mockRestore()
      readFileSyncSpy.mockRestore()
      parseSpy.mockRestore()
    })

    it('successfully refreshes secrets when config is valid', async () => {
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

    // ────────────────────────────────────────────────────────────────────────
    // Idempotency: only-idempotent
    // ────────────────────────────────────────────────────────────────────────

    it('replays cached response for the same idempotency key and payload', async () => {
      const fs = await import('fs')
      const dotenv = await import('dotenv')

      const originalEnv = { ...process.env }
      process.env.DB_URL = 'postgres://localhost/test'
      process.env.REDIS_URL = 'redis://localhost/test'
      process.env.JWT_SECRET = 'valid-secret-at-least-32-chars-long'

      const existsSyncSpy = vi.spyOn(fs.default, 'existsSync').mockReturnValue(true)
      const readFileSyncSpy = vi.spyOn(fs.default, 'readFileSync').mockReturnValue(Buffer.from('JWT_SECRET=new-valid-secret-at-least-32-chars-long'))
      const parseSpy = vi.spyOn(dotenv.default, 'parse').mockReturnValue({ JWT_SECRET: 'new-valid-secret-at-least-32-chars-long' })

      const app = setup(true) // include idempotency middleware
      const idempotencyKey = 'refresh-secrets-idem-1'

      // First request — should succeed and cache the response
      const first = await request(app)
        .post('/api/admin/refresh-secrets')
        .set('Idempotency-Key', idempotencyKey)
        .send()

      expect(first.status).toBe(200)
      expect(first.body.success).toBe(true)
      expect(process.env.JWT_SECRET).toBe('new-valid-secret-at-least-32-chars-long')

      // Reset env to simulate a fresh state
      process.env.JWT_SECRET = 'valid-secret-at-least-32-chars-long'

      // Second request with same key — should replay cached response
      // NOTE: even though env is reset, the cached response (success:true) is replayed
      const second = await request(app)
        .post('/api/admin/refresh-secrets')
        .set('Idempotency-Key', idempotencyKey)
        .send()

      // The idempotency middleware replays the original response
      // The route handler is never called, so env stays unchanged
      expect(second.status).toBe(200)
      expect(second.body.success).toBe(true)
      // env should NOT have been changed by the second call
      expect(process.env.JWT_SECRET).toBe('valid-secret-at-least-32-chars-long')

      existsSyncSpy.mockRestore()
      readFileSyncSpy.mockRestore()
      parseSpy.mockRestore()
      process.env = originalEnv
    })

    it('returns 409 when idempotency key is reused with a different payload', async () => {
      const fs = await import('fs')
      const dotenv = await import('dotenv')

      const originalEnv = { ...process.env }
      process.env.DB_URL = 'postgres://localhost/test'
      process.env.REDIS_URL = 'redis://localhost/test'
      process.env.JWT_SECRET = 'valid-secret-at-least-32-chars-long'

      const existsSyncSpy = vi.spyOn(fs.default, 'existsSync').mockReturnValue(true)
      const readFileSyncSpy = vi.spyOn(fs.default, 'readFileSync').mockReturnValue(Buffer.from('JWT_SECRET=new-valid-secret-at-least-32-chars-long'))
      const parseSpy = vi.spyOn(dotenv.default, 'parse').mockReturnValue({ JWT_SECRET: 'new-valid-secret-at-least-32-chars-long' })

      const idempotencyKey = 'refresh-secrets-idem-2'
      const app = setup(true)

      // First request — succeeds and caches with the default (empty) payload
      const first = await request(app)
        .post('/api/admin/refresh-secrets')
        .set('Idempotency-Key', idempotencyKey)
        .send()

      expect(first.status).toBe(200)

      // Second request with same key but different payload
      const second = await request(app)
        .post('/api/admin/refresh-secrets')
        .set('Idempotency-Key', idempotencyKey)
        .send({ different: 'payload' })

      expect(second.status).toBe(409)
      expect(second.body.code).toBe('idempotency_key_mismatch')

      existsSyncSpy.mockRestore()
      readFileSyncSpy.mockRestore()
      parseSpy.mockRestore()
      process.env = originalEnv
    })

    // ────────────────────────────────────────────────────────────────────────
    // Audit logging: only-audit-logged
    // ────────────────────────────────────────────────────────────────────────

    it('writes an audit log entry on successful secret refresh', async () => {
      const fs = await import('fs')
      const dotenv = await import('dotenv')

      const originalEnv = { ...process.env }
      process.env.DB_URL = 'postgres://localhost/test'
      process.env.REDIS_URL = 'redis://localhost/test'
      process.env.JWT_SECRET = 'valid-secret-at-least-32-chars-long'

      const existsSyncSpy = vi.spyOn(fs.default, 'existsSync').mockReturnValue(true)
      const readFileSyncSpy = vi.spyOn(fs.default, 'readFileSync').mockReturnValue(Buffer.from('JWT_SECRET=new-valid-secret-at-least-32-chars-long'))
      const parseSpy = vi.spyOn(dotenv.default, 'parse').mockReturnValue({ JWT_SECRET: 'new-valid-secret-at-least-32-chars-long' })

      expect(mockAuditLogService.logAction).not.toHaveBeenCalled()

      const res = await request(setup())
        .post('/api/admin/refresh-secrets')
        .send()

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)

      // Audit log should have been called with the correct action
      expect(mockAuditLogService.logAction).toHaveBeenCalledTimes(1)
      const callArgs = mockAuditLogService.logAction.mock.calls[0]

      // logAction(tenantId, adminId, adminEmail, action, targetUserId, ...)
      expect(callArgs[0]).toBe('tenant-1')
      expect(callArgs[1]).toBe('admin-1')
      expect(callArgs[2]).toBe('admin@test.com')
      expect(callArgs[3]).toBe('UPDATE_SETTINGS')
      expect(callArgs[4]).toBe('system')

      // The details should contain the action marker
      expect(callArgs[6]).toEqual({ action: 'refresh-secrets' })

      // ipAddress and requestId are passed
      expect(callArgs[9]).toBeDefined() // ipAddress

      existsSyncSpy.mockRestore()
      readFileSyncSpy.mockRestore()
      parseSpy.mockRestore()
      process.env = originalEnv
    })

    it('does not write an audit log entry when config validation fails', async () => {
      const fs = await import('fs')
      const dotenv = await import('dotenv')

      const existsSyncSpy = vi.spyOn(fs.default, 'existsSync').mockReturnValue(true)
      const readFileSyncSpy = vi.spyOn(fs.default, 'readFileSync').mockReturnValue(Buffer.from('JWT_SECRET=short'))
      const parseSpy = vi.spyOn(dotenv.default, 'parse').mockReturnValue({ JWT_SECRET: 'short' })

      expect(mockAuditLogService.logAction).not.toHaveBeenCalled()

      const res = await request(setup())
        .post('/api/admin/refresh-secrets')
        .send()

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('ConfigValidationError')

      // No audit log should be written for failed validation
      expect(mockAuditLogService.logAction).not.toHaveBeenCalled()

      existsSyncSpy.mockRestore()
      readFileSyncSpy.mockRestore()
      parseSpy.mockRestore()
    })
  })
})

describe('Admin Anti-Crawling Defenses', () => {
  beforeEach(() => {
    mockUserRef.current = null
  })

  it('rejects requests from known crawler User-Agents with a typed error', async () => {
    const response = await request(setup())
      .get('/api/admin')
      .set('User-Agent', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)');

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      error: expect.any(String),
      code: 'crawler_blocked'
    });
  });

  it('attaches X-Robots-Tag header to legitimate admin requests', async () => {
    const response = await request(setup())
      .get('/api/admin')
      .set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

    expect(response.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive, nosnippet');
  });
});
