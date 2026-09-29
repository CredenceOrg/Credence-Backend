import { describe, it, expect, vi, beforeEach } from 'vitest'
import express, { type Request, type Response, type NextFunction } from 'express'
import request from 'supertest'

import { createAdminRouter } from './index.js'
import { createWebhookAdminRouter } from './webhooks.js'
import { createFeatureFlagAdminRouter } from './featureFlags.js'
import { createRateLimitOverridesAdminRouter } from './rateLimitOverrides.js'
import { createOutboxAdminRouter } from './outbox.js'
import { createMembersRouter } from './member.js'

// ── Shared test state & auth mocks ──────────────────────────────────────────

const {
  currentCallerRef,
  mockAuditInstance,
  mockAdminService,
  mockImpersonationService,
  mockWebhookService,
  mockFeatureFlagService,
  mockRateLimitService,
  mockMemberService,
} = vi.hoisted(() => ({
  currentCallerRef: {
    user: null as { id: string; email: string; role: string; tenantId: string } | null,
  },
  mockAuditInstance: {
    logAction: vi.fn().mockResolvedValue(undefined),
    getLogs: vi.fn().mockResolvedValue({ logs: [], hasNextPage: false }),
    getChainVerificationStatus: vi.fn().mockResolvedValue(null),
  },
  mockAdminService: {
    listUsers: vi.fn().mockResolvedValue({ users: [], total: 0 }),
    assignRole: vi.fn().mockResolvedValue({ message: 'Success', user: {} }),
    revokeApiKey: vi.fn().mockResolvedValue({ message: 'Success' }),
    getAuditLogs: vi.fn().mockResolvedValue({ logs: [], hasNextPage: false }),
    exportAuditLogs: vi.fn().mockImplementation(async function* () {}),
    logExportCompletion: vi.fn(),
  },
  mockImpersonationService: {
    issueToken: vi.fn().mockResolvedValue({ token: 'tok_123' }),
    revokeToken: vi.fn().mockResolvedValue(undefined),
  },
  mockWebhookService: {
    rotateSecret: vi.fn().mockResolvedValue({ id: 'wh_123', secret: 'sec_123', secretUpdatedAt: new Date() }),
    revokePreviousSecret: vi.fn().mockResolvedValue(undefined),
    replayWebhook: vi.fn().mockResolvedValue({ success: true }),
  },
  mockFeatureFlagService: {
    listFlagsWithOverrides: vi.fn().mockResolvedValue([]),
    createFlag: vi.fn().mockResolvedValue({ key: 'flag1' }),
    updateFlag: vi.fn().mockResolvedValue({ key: 'flag1' }),
    setOverride: vi.fn().mockResolvedValue({ key: 'flag1' }),
    removeOverride: vi.fn().mockResolvedValue(undefined),
    setTenantRollout: vi.fn().mockResolvedValue({ key: 'flag1' }),
    removeTenantRollout: vi.fn().mockResolvedValue(undefined),
  },
  mockRateLimitService: {
    listOverrides: vi.fn().mockResolvedValue([]),
    setOverride: vi.fn().mockResolvedValue({ tenantId: 't1' }),
    removeOverride: vi.fn().mockResolvedValue(undefined),
  },
  mockMemberService: {
    listMembers: vi.fn().mockResolvedValue({ members: [], total: 0 }),
    inviteMember: vi.fn().mockResolvedValue({ id: 'm1' }),
    updateMemberRole: vi.fn().mockResolvedValue({ id: 'm1' }),
    deleteMember: vi.fn().mockResolvedValue(undefined),
    restoreMember: vi.fn().mockResolvedValue({ id: 'm1' }),
  },
}))

vi.mock('../../middleware/auth.ts', () => ({
  UserRole: {
    SUPER_ADMIN: 'super-admin',
    ADMIN: 'admin',
    VERIFIER: 'verifier',
    USER: 'user',
  },
  ApiScope: {
    OUTBOX_REINJECT: 'outbox:reinject',
    WEBHOOKS_ADMIN: 'webhooks:admin',
  },
  requireUserAuth: (req: Request, res: Response, next: NextFunction) => {
    if (!currentCallerRef.user) {
      res.status(401).json({ error: 'Unauthorized', message: 'User authentication required' })
      return
    }
    ;(req as any).user = { ...currentCallerRef.user }
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
  requireApiKey: () => (req: Request, res: Response, next: NextFunction) => {
    const apiKeyHeader = req.headers['x-api-key'] || req.headers['authorization']
    if (!apiKeyHeader) {
      res.status(401).json({ error: 'Unauthorized', message: 'API key is required' })
      return
    }
    if (apiKeyHeader.toString().includes('invalid')) {
      res.status(401).json({ error: 'Unauthorized', message: 'Invalid API key' })
      return
    }
    next()
  },
}))

vi.mock('../../services/audit/index.js', () => ({
  auditLogService: mockAuditInstance,
  AuditLogService: class {
    logAction = mockAuditInstance.logAction
    getLogs = mockAuditInstance.getLogs
    getChainVerificationStatus = mockAuditInstance.getChainVerificationStatus
  },
  AuditAction: {},
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

vi.mock('../../services/webhooks/service.js', () => ({
  WebhookService: class {
    rotateSecret = mockWebhookService.rotateSecret
    revokePreviousSecret = mockWebhookService.revokePreviousSecret
    replayWebhook = mockWebhookService.replayWebhook
  },
}))

vi.mock('../../services/featureFlags/index.js', () => ({
  FeatureFlagService: class {
    listFlagsWithOverrides = mockFeatureFlagService.listFlagsWithOverrides
    createFlag = mockFeatureFlagService.createFlag
    updateFlag = mockFeatureFlagService.updateFlag
    setOverride = mockFeatureFlagService.setOverride
    removeOverride = mockFeatureFlagService.removeOverride
    setTenantRollout = mockFeatureFlagService.setTenantRollout
    removeTenantRollout = mockFeatureFlagService.removeTenantRollout
  },
}))

vi.mock('../../services/rateLimitOverride/service.js', () => ({
  RateLimitOverrideService: class {
    listOverrides = mockRateLimitService.listOverrides
    setOverride = mockRateLimitService.setOverride
    removeOverride = mockRateLimitService.removeOverride
  },
}))

vi.mock('../../services/members/service.ts', () => ({
  MemberService: class {
    listMembers = mockMemberService.listMembers
    inviteMember = mockMemberService.inviteMember
    updateMemberRole = mockMemberService.updateMemberRole
    deleteMember = mockMemberService.deleteMember
    restoreMember = mockMemberService.restoreMember
  },
}))

vi.mock('../../db/pool.js', () => ({
  pool: {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    connect: vi.fn().mockResolvedValue({ query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() }),
    on: vi.fn(),
  },
  workerPool: {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    on: vi.fn(),
  },
  replicaPool: {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    on: vi.fn(),
  },
  withReplica: vi.fn(),
}))

vi.mock('../../services/replayService.js', () => ({
  ReplayService: class {
    registerHandler = vi.fn()
    listFailedEvents = vi.fn().mockResolvedValue({ events: [], total: 0 })
    replayEvent = vi.fn().mockResolvedValue({ success: true })
    replayLedgerRange = vi.fn().mockResolvedValue({ replayed: 0, failed: 0 })
  },
}))

vi.mock('../../cache/redis.js', () => ({
  cache: {
    clearNamespace: vi.fn().mockResolvedValue(0),
  },
}))

// ── Admin Permission Matrix Enumeration ─────────────────────────────────────

export interface AdminRouteTestSpec {
  method: 'get' | 'post' | 'put' | 'delete' | 'patch'
  path: string
  sampleBody?: Record<string, unknown>
}

/**
 * Enumeration of every admin endpoint across all admin sub-routers in Credence Backend.
 */
export const ADMIN_PERMISSION_MATRIX: AdminRouteTestSpec[] = [
  // ── Main Admin Router (src/routes/admin/index.ts)
  { method: 'get', path: '/api/admin/users' },
  { method: 'post', path: '/api/admin/roles/assign', sampleBody: { userId: 'u1', role: 'user' } },
  { method: 'post', path: '/api/admin/reload-config' },
  { method: 'post', path: '/api/admin/refresh-secrets' },
  { method: 'post', path: '/api/admin/purge-cache', sampleBody: { namespace: 'test' } },
  { method: 'post', path: '/api/admin/keys/revoke', sampleBody: { keyId: 'k1' } },
  { method: 'post', path: '/api/admin/impersonate', sampleBody: { targetUserId: 'u2', reason: 'test' } },
  { method: 'post', path: '/api/admin/impersonate/tok_123/revoke' },
  { method: 'get', path: '/api/admin/audit-logs' },
  { method: 'get', path: '/api/admin/audit-logs/export?startDate=2026-01-01T00:00:00Z&endDate=2026-01-02T00:00:00Z' },
  { method: 'get', path: '/api/admin/events/failed' },
  { method: 'post', path: '/api/admin/events/replay/evt_123' },
  { method: 'post', path: '/api/admin/events/replay-range', sampleBody: { fromLedger: 100, toLedger: 100 } },
  { method: 'post', path: '/api/admin/replay-event', sampleBody: { id: 'evt_123' } },
  { method: 'post', path: '/api/admin/replay-webhook', sampleBody: { id: 'wh_123' } },
  { method: 'post', path: '/api/admin/replay', sampleBody: { requestId: 'req_123' } },

  // ── Sub-routers mounted in index.ts
  { method: 'get', path: '/api/admin/erasure-proof/ev_123' },
  { method: 'get', path: '/api/admin/audit/chain-status' },
  { method: 'get', path: '/api/admin/settlement/reconciliation' },
  { method: 'get', path: '/api/admin/migrations/dry-run' },
  { method: 'post', path: '/api/admin/migrations/dry-run', sampleBody: { count: 1 } },

  // ── Webhooks Admin Router (src/routes/admin/webhooks.ts)
  { method: 'post', path: '/api/admin/webhooks/wh_123/rotate' },
  { method: 'post', path: '/api/admin/webhooks/wh_123/revoke-previous' },

  // ── Feature Flags Admin Router (src/routes/admin/featureFlags.ts)
  { method: 'get', path: '/api/admin/feature-flags' },
  { method: 'post', path: '/api/admin/feature-flags', sampleBody: { key: 'flag1', description: 'test' } },
  { method: 'put', path: '/api/admin/feature-flags/flag1', sampleBody: { defaultEnabled: true } },
  { method: 'post', path: '/api/admin/feature-flags/flag1/overrides', sampleBody: { tenantId: 't1', enabled: true } },
  { method: 'delete', path: '/api/admin/feature-flags/flag1/overrides/t1' },
  { method: 'post', path: '/api/admin/feature-flags/flag1/tenant-rollouts', sampleBody: { tenantId: 't1', rolloutPercent: 50 } },
  { method: 'delete', path: '/api/admin/feature-flags/flag1/tenant-rollouts/t1' },

  // ── Rate Limit Overrides Admin Router (src/routes/admin/rateLimitOverrides.ts)
  { method: 'get', path: '/api/admin/rate-limits/overrides' },
  { method: 'post', path: '/api/admin/rate-limits/overrides', sampleBody: { tenantId: 't1', rateLimit: 100, windowSize: 60, reason: 'test' } },
  { method: 'delete', path: '/api/admin/rate-limits/overrides/t1', sampleBody: { reason: 'cleanup' } },

  // ── Outbox Admin Router (src/routes/admin/outbox.ts)
  { method: 'get', path: '/api/admin/outbox/quarantine' },
  { method: 'post', path: '/api/admin/outbox/pause' },
  { method: 'post', path: '/api/admin/outbox/resume' },
  { method: 'get', path: '/api/admin/outbox/status' },

  // ── Members Admin Router (src/routes/admin/member.ts)
  { method: 'get', path: '/api/admin/orgs/org1/members' },
  { method: 'post', path: '/api/admin/orgs/org1/members', sampleBody: { email: 'm1@credence.org', role: 'member' } },
  { method: 'patch', path: '/api/admin/orgs/org1/members/m1', sampleBody: { role: 'admin' } },
  { method: 'delete', path: '/api/admin/orgs/org1/members/m1' },
  { method: 'post', path: '/api/admin/orgs/org1/members/m1/restore' },
]

describe('Admin Permission Matrix Route Tests', () => {
  let app: express.Express

  beforeEach(() => {
    app = express()
    app.use(express.json())

    app.use('/api/admin', createAdminRouter())
    app.use('/api/admin/webhooks', createWebhookAdminRouter())
    app.use('/api/admin/feature-flags', createFeatureFlagAdminRouter())
    app.use('/api/admin/rate-limits/overrides', createRateLimitOverridesAdminRouter())
    app.use('/api/admin/outbox', createOutboxAdminRouter())
    app.use('/api/admin/orgs/:orgId/members', createMembersRouter())
  })

  describe('Unauthenticated callers (No Auth)', () => {
    it.each(ADMIN_PERMISSION_MATRIX)(
      '$method $path -> 401 Unauthorized',
      async ({ method, path, sampleBody }) => {
        currentCallerRef.user = null

        const req = request(app)[method](path)
        if (sampleBody) req.send(sampleBody)

        const res = await req
        expect(res.status).toBe(401)
        expect(res.body.error).toMatch(/Unauthorized|Unauthenticated/i)
      },
    )
  })

  describe('Non-admin callers (Forbidden: 403)', () => {
    const nonAdminRoles = ['user', 'verifier', 'public']

    nonAdminRoles.forEach((role) => {
      describe(`Role: ${role}`, () => {
        it.each(ADMIN_PERMISSION_MATRIX)(
          `$method $path -> 403 Forbidden for role=${role}`,
          async ({ method, path, sampleBody }) => {
            currentCallerRef.user = {
              id: `user-${role}`,
              email: `${role}@credence.org`,
              role,
              tenantId: 't-test',
            }

            const req = request(app)[method](path)
            if (sampleBody) req.send(sampleBody)

            const res = await req
            expect(res.status).toBe(403)
            expect(res.body.error).toBe('Forbidden')
          },
        )
      })
    })
  })

  describe('Authorized admin callers (Allowed past role gate)', () => {
    const adminRoles = ['admin', 'super-admin']

    adminRoles.forEach((role) => {
      describe(`Role: ${role}`, () => {
        it.each(ADMIN_PERMISSION_MATRIX)(
          `$method $path -> passes role gate (non-401 & non-403) for role=${role}`,
          async ({ method, path, sampleBody }) => {
            currentCallerRef.user = {
              id: `user-${role}`,
              email: `${role}@credence.org`,
              role,
              tenantId: 't-test',
            }

            const req = request(app)[method](path)
            if (sampleBody) req.send(sampleBody)

            const res = await req
            // Assert that the request passed the role authentication/authorization gate
            expect(res.status).not.toBe(401)
            expect(res.status).not.toBe(403)
          },
        )
      })
    })
  })
})
