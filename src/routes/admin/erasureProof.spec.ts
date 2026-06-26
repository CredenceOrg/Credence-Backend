import { vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import erasureProofRouter from './erasureProof.js'
import {
  auditLogService,
  AuditAction,
} from '../../services/audit/index.js'

// Mock the auth middleware
vi.mock('../../middleware/auth.js', () => ({
  requireUserAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'admin-1', email: 'admin@test.com', tenantId: 'tenant-1', role: 'admin' }
    next()
  },
  requireAdminRole: (_req: any, _res: any, next: any) => next(),
}))

describe('GET /v1/admin/erasure-proof/:id', () => {
  let app: express.Express

  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use(erasureProofRouter)
  })

  beforeEach(async () => {
    await auditLogService.clearLogs()
  })

  it('should return 404 when no erasure proof exists', async () => {
    const res = await request(app)
      .get('/erasure-proof/nonexistent-evidence')
      .expect('Content-Type', /json/)

    expect(res.status).toBe(404)
    expect(res.body.error).toBe('NotFound')
  })

  it('should return the erasure proof JWT when evidence was shredded', async () => {
    // Seed the audit log with an EVIDENCE_SHREDDED entry
    const proofJwt = 'eyJhbGciOiJQUzI1NiIsImtpZCI6InRlc3Qta2lkIn0.test-signature'
    await auditLogService.logAction({
      tenantId: 'tenant-1',
      actorId: 'RETENTION_JOB',
      actorEmail: 'RETENTION_JOB@system.internal',
      action: AuditAction.EVIDENCE_SHREDDED,
      resourceType: 'evidence',
      resourceId: 'evidence-123',
      details: {
        proofJwt,
        shreddedAt: new Date().toISOString(),
      },
    })

    const res = await request(app)
      .get('/erasure-proof/evidence-123')
      .expect('Content-Type', /json/)

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.evidenceId).toBe('evidence-123')
    expect(res.body.data.proofJwt).toBe(proofJwt)
  })

  it('should return 400 for empty evidence ID', async () => {
    const res = await request(app)
      .get('/erasure-proof/%20')
      .expect('Content-Type', /json/)

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('BadRequest')
  })

  it('should return a proof when multiple shred entries exist', async () => {
    await auditLogService.logAction({
      tenantId: 'tenant-1',
      actorId: 'RETENTION_JOB',
      actorEmail: 'RETENTION_JOB@system.internal',
      action: AuditAction.EVIDENCE_SHREDDED,
      resourceType: 'evidence',
      resourceId: 'multi-shred',
      details: {
        proofJwt: 'proof-jwt-v1',
        shreddedAt: new Date().toISOString(),
      },
    })

    const res = await request(app)
      .get('/erasure-proof/multi-shred')
      .expect('Content-Type', /json/)

    expect(res.status).toBe(200)
    expect(res.body.data.evidenceId).toBe('multi-shred')
    expect(res.body.data.proofJwt).toBeTruthy()
  })
})
