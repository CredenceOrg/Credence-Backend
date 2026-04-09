import { describe, it, expect, beforeEach, vi } from 'vitest'

// Set required environment variables BEFORE any imports
process.env.DB_URL = 'postgresql://test:test@localhost:5432/test'
process.env.REDIS_URL = 'redis://localhost:6379'
process.env.JWT_SECRET = 'test-secret-key-for-testing'

import request from 'supertest'
import app from '../app.js'
import { auditLogService } from '../services/audit/index.js'
import { impersonationService } from '../services/impersonation/index.js'
import { AuditAction } from '../services/audit/types.js'

const ADMIN_TOKEN = 'Bearer admin-key-12345'
const VERIFIER_TOKEN = 'Bearer verifier-key-67890'

beforeEach(() => {
  auditLogService.clearLogs()
  impersonationService._reset()
})

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------
describe('POST /api/admin/impersonate – authorization', () => {
  it('returns 401 when no Authorization header', async () => {
    const res = await request(app).post('/api/admin/impersonate').send({
      targetUserId: 'verifier-user-1',
      reason: 'support ticket #123',
    })
    expect(res.status).toBe(401)
  })

  it('returns 403 when caller is not admin', async () => {
    const res = await request(app)
      .post('/api/admin/impersonate')
      .set('Authorization', VERIFIER_TOKEN)
      .send({ targetUserId: 'admin-user-1', reason: 'test' })
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
describe('POST /api/admin/impersonate – validation', () => {
  it('returns 400 when targetUserId is missing', async () => {
    const res = await request(app)
      .post('/api/admin/impersonate')
      .set('Authorization', ADMIN_TOKEN)
      .send({ reason: 'support ticket #123' })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/targetUserId/)
  })

  it('returns 400 when reason is missing', async () => {
    const res = await request(app)
      .post('/api/admin/impersonate')
      .set('Authorization', ADMIN_TOKEN)
      .send({ targetUserId: 'verifier-user-1' })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/reason/)
  })

  it('returns 404 when target user does not exist', async () => {
    const res = await request(app)
      .post('/api/admin/impersonate')
      .set('Authorization', ADMIN_TOKEN)
      .send({ targetUserId: 'ghost-user', reason: 'support ticket #123' })
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Happy path – token issuance
// ---------------------------------------------------------------------------
describe('POST /api/admin/impersonate – token issuance', () => {
  it('issues a token with default TTL', async () => {
    const res = await request(app)
      .post('/api/admin/impersonate')
      .set('Authorization', ADMIN_TOKEN)
      .send({ targetUserId: 'verifier-user-1', reason: 'support ticket #123' })

    expect(res.status).toBe(201)
    expect(res.body.success).toBe(true)

    const { data } = res.body
    expect(data).toHaveProperty('tokenId')
    expect(data.targetUserId).toBe('verifier-user-1')
    expect(data.ttlSeconds).toBe(900)
    expect(new Date(data.expiresAt).getTime()).toBeGreaterThan(Date.now())
  })

  it('respects a custom TTL up to the 1-hour cap', async () => {
    const res = await request(app)
      .post('/api/admin/impersonate')
      .set('Authorization', ADMIN_TOKEN)
      .send({ targetUserId: 'verifier-user-1', reason: 'test', ttlSeconds: 300 })

    expect(res.status).toBe(201)
    expect(res.body.data.ttlSeconds).toBe(300)
  })

  it('caps TTL at 3600 seconds', async () => {
    const res = await request(app)
      .post('/api/admin/impersonate')
      .set('Authorization', ADMIN_TOKEN)
      .send({ targetUserId: 'verifier-user-1', reason: 'test', ttlSeconds: 99999 })

    expect(res.status).toBe(201)
    expect(res.body.data.ttlSeconds).toBe(3600)
  })
})

// ---------------------------------------------------------------------------
// Token expiry
// ---------------------------------------------------------------------------
describe('ImpersonationService – token expiry', () => {
  it('validateToken returns null for an expired token', async () => {
    // Issue with 1-second TTL
    const res = await request(app)
      .post('/api/admin/impersonate')
      .set('Authorization', ADMIN_TOKEN)
      .send({ targetUserId: 'verifier-user-1', reason: 'expiry test', ttlSeconds: 1 })

    const { tokenId } = res.body.data

    // Advance time past expiry by manipulating the stored record directly
    const record = impersonationService.validateToken(tokenId)!
    // Backdate expiresAt
    ;(record as any).expiresAt = new Date(Date.now() - 1000).toISOString()

    expect(impersonationService.validateToken(tokenId)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------
describe('POST /api/admin/impersonate/:tokenId/revoke', () => {
  it('revokes an active token', async () => {
    const issueRes = await request(app)
      .post('/api/admin/impersonate')
      .set('Authorization', ADMIN_TOKEN)
      .send({ targetUserId: 'verifier-user-1', reason: 'revoke test' })

    const { tokenId } = issueRes.body.data

    const revokeRes = await request(app)
      .post(`/api/admin/impersonate/${tokenId}/revoke`)
      .set('Authorization', ADMIN_TOKEN)

    expect(revokeRes.status).toBe(200)
    expect(revokeRes.body.success).toBe(true)

    // Token should no longer validate
    expect(impersonationService.validateToken(tokenId)).toBeNull()
  })

  it('returns 400 when revoking an already-revoked token', async () => {
    const issueRes = await request(app)
      .post('/api/admin/impersonate')
      .set('Authorization', ADMIN_TOKEN)
      .send({ targetUserId: 'verifier-user-1', reason: 'double revoke test' })

    const { tokenId } = issueRes.body.data

    await request(app)
      .post(`/api/admin/impersonate/${tokenId}/revoke`)
      .set('Authorization', ADMIN_TOKEN)

    const res = await request(app)
      .post(`/api/admin/impersonate/${tokenId}/revoke`)
      .set('Authorization', ADMIN_TOKEN)

    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/already revoked/)
  })

  it('returns 404 for an unknown tokenId', async () => {
    const res = await request(app)
      .post('/api/admin/impersonate/nonexistent-token/revoke')
      .set('Authorization', ADMIN_TOKEN)

    expect(res.status).toBe(404)
  })

  it('returns 403 when non-admin tries to revoke', async () => {
    const issueRes = await request(app)
      .post('/api/admin/impersonate')
      .set('Authorization', ADMIN_TOKEN)
      .send({ targetUserId: 'verifier-user-1', reason: 'authz revoke test' })

    const { tokenId } = issueRes.body.data

    const res = await request(app)
      .post(`/api/admin/impersonate/${tokenId}/revoke`)
      .set('Authorization', VERIFIER_TOKEN)

    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// Audit events
// ---------------------------------------------------------------------------
describe('Audit trail', () => {
  it('logs ISSUE_IMPERSONATION_TOKEN on successful issuance', async () => {
    await request(app)
      .post('/api/admin/impersonate')
      .set('Authorization', ADMIN_TOKEN)
      .send({ targetUserId: 'verifier-user-1', reason: 'audit test' })

    const { logs } = auditLogService.getLogs({ action: AuditAction.ISSUE_IMPERSONATION_TOKEN })
    expect(logs).toHaveLength(1)
    expect(logs[0].status).toBe('success')
    expect(logs[0].adminId).toBe('admin-user-1')
    expect(logs[0].targetUserId).toBe('verifier-user-1')
    expect(logs[0].details.reason).toBe('audit test')
  })

  it('logs ISSUE_IMPERSONATION_TOKEN as failure when target not found', async () => {
    await request(app)
      .post('/api/admin/impersonate')
      .set('Authorization', ADMIN_TOKEN)
      .send({ targetUserId: 'ghost', reason: 'audit failure test' })

    const { logs } = auditLogService.getLogs({ action: AuditAction.ISSUE_IMPERSONATION_TOKEN })
    expect(logs).toHaveLength(1)
    expect(logs[0].status).toBe('failure')
  })

  it('logs REVOKE_IMPERSONATION_TOKEN on revocation', async () => {
    // Clear logs before this test
    auditLogService.clearLogs()
    
    const issueRes = await request(app)
      .post('/api/admin/impersonate')
      .set('Authorization', ADMIN_TOKEN)
      .send({ targetUserId: 'verifier-user-1', reason: 'revoke audit test' })

    const { tokenId } = issueRes.body.data

    // Clear logs again to only capture revocation
    auditLogService.clearLogs()

    await request(app)
      .post(`/api/admin/impersonate/${tokenId}/revoke`)
      .set('Authorization', ADMIN_TOKEN)

    const { logs } = auditLogService.getLogs({ action: AuditAction.REVOKE_IMPERSONATION_TOKEN })
    expect(logs).toHaveLength(1)
    expect(logs[0].status).toBe('success')
    expect(logs[0].details.tokenId).toBe(tokenId)
  })
})
