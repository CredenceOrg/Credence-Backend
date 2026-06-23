/**
 * Integration tests for dispute routes wired through the governance state machine.
 *
 * Covers HTTP auth, validation, state transitions, audit-log side effects, and the
 * standard conflict error envelope for invalid transitions.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import disputesRouter from '../../src/routes/disputes.js'
import { resetStore } from '../../src/services/governance/disputes.js'
import { auditLogService, AuditAction } from '../../src/services/audit/index.js'
import { userRepo, type UserRole } from '../../src/repositories/userRepository.js'
import { generateApiKey, _resetStore as resetApiKeyStore } from '../../src/services/apiKeys.js'
import { ErrorCode } from '../../src/lib/errorCatalog.js'

const ALICE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2'
const BOB = 'GABBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB3'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const BASE = '/api/disputes'

function validDisputeBody() {
  return {
    filedBy: ALICE,
    respondent: BOB,
    reason: 'Failure to deliver contracted services within agreed timeline',
    evidence: ['tx:abc123'],
    deadlineMs: 7 * DAY,
  }
}

function makeBearerFor(userId: string, role: UserRole): string {
  userRepo.upsert({
    id: userId,
    role,
    email: `${userId}@example.test`,
    tenantId: `tenant-${userId}`,
  })
  const created = generateApiKey(userId, 'full')
  return `Bearer ${created.key}`
}

function setupApp(): Express {
  const app = express()
  app.use(express.json())
  app.use(BASE, disputesRouter)
  return app
}

async function openDispute(
  app: Express,
  bearer: string,
  body = validDisputeBody(),
): Promise<{ id: string; status: string }> {
  const res = await request(app)
    .post(BASE)
    .set('Authorization', bearer)
    .send(body)
    .expect(201)

  return { id: res.body.id, status: res.body.status }
}

describe('Dispute routes + state machine integration', () => {
  let app: Express
  let filerBearer: string
  let verifierBearer: string

  beforeEach(async () => {
    resetStore()
    resetApiKeyStore()
    userRepo._reset()
    await auditLogService.clearLogs()

    app = setupApp()
    filerBearer = makeBearerFor('filer-1', 'user')
    verifierBearer = makeBearerFor('verifier-1', 'verifier')
  })

  describe('POST /api/disputes', () => {
    it('opens a dispute and persists it for retrieval', async () => {
      const res = await request(app)
        .post(BASE)
        .set('Authorization', filerBearer)
        .send(validDisputeBody())
        .expect(201)

      expect(res.body).toMatchObject({
        status: 'pending',
        filedBy: ALICE,
        respondent: BOB,
        resolution: null,
      })
      expect(res.body.id).toBeTruthy()

      const fetched = await request(app)
        .get(`${BASE}/${res.body.id}`)
        .set('Authorization', filerBearer)
        .expect(200)

      expect(fetched.body.status).toBe('pending')
      expect(fetched.body.id).toBe(res.body.id)
    })

    it('writes a success audit log entry when a dispute is opened', async () => {
      const res = await request(app)
        .post(BASE)
        .set('Authorization', filerBearer)
        .send(validDisputeBody())
        .expect(201)

      const logs = await auditLogService.getAllLogs()
      expect(logs).toHaveLength(1)
      expect(logs[0]).toMatchObject({
        action: AuditAction.DISPUTE_SUBMITTED,
        resourceType: 'dispute',
        resourceId: res.body.id,
        status: 'success',
        actorId: 'filer-1',
      })
    })

    it('rejects unauthenticated dispute creation', async () => {
      const res = await request(app)
        .post(BASE)
        .send(validDisputeBody())
        .expect(401)

      expect(res.body).toMatchObject({
        error: 'Unauthorized',
        message: 'Bearer token required',
      })

      const logs = await auditLogService.getAllLogs()
      expect(logs).toHaveLength(0)
    })

    it('rejects invalid dispute payloads and records a failure audit log', async () => {
      const res = await request(app)
        .post(BASE)
        .set('Authorization', filerBearer)
        .send({ ...validDisputeBody(), filedBy: '' })
        .expect(400)

      expect(res.body).toMatchObject({
        error: 'BadRequest',
      })
      expect(res.body.message).toContain('Invalid dispute')

      const logs = await auditLogService.getAllLogs()
      expect(logs).toHaveLength(1)
      expect(logs[0]).toMatchObject({
        action: AuditAction.DISPUTE_SUBMITTED,
        status: 'failure',
        resourceId: 'unknown',
      })
    })
  })

  describe('GET /api/disputes/:id', () => {
    it('returns 404 for unknown disputes', async () => {
      const res = await request(app)
        .get(`${BASE}/missing-dispute-id`)
        .set('Authorization', filerBearer)
        .expect(404)

      expect(res.body).toMatchObject({
        error: 'NotFound',
        message: 'Dispute not found',
      })
    })
  })

  describe('GET /api/disputes', () => {
    it('returns disputes for the caller scoped by tenant', async () => {
      await openDispute(app, filerBearer)
      await openDispute(app, filerBearer)

      const res = await request(app)
        .get(BASE)
        .set('Authorization', filerBearer)
        .expect(200)

      expect(res.body.data).toHaveLength(2)

      const verifierRes = await request(app)
        .get(BASE)
        .set('Authorization', verifierBearer)
        .expect(200)
      
      expect(verifierRes.body.data).toHaveLength(0)
    })

    it('filters disputes by status', async () => {
      const d1 = await openDispute(app, filerBearer)
      const d2 = await openDispute(app, filerBearer)
      
      await request(app)
        .post(`${BASE}/${d1.id}/review`)
        .set('Authorization', verifierBearer)
        .expect(200)

      const underReviewRes = await request(app)
        .get(`${BASE}?status=under_review`)
        .set('Authorization', filerBearer)
        .expect(200)
      
      expect(underReviewRes.body.data).toHaveLength(1)
      expect(underReviewRes.body.data[0].id).toBe(d1.id)

      const pendingRes = await request(app)
        .get(`${BASE}?status=pending`)
        .set('Authorization', filerBearer)
        .expect(200)

      expect(pendingRes.body.data).toHaveLength(1)
      expect(pendingRes.body.data[0].id).toBe(d2.id)
    })

    it('rejects invalid statuses with 400', async () => {
      await request(app)
        .get(`${BASE}?status=invalid_status`)
        .set('Authorization', filerBearer)
        .expect(400)
    })

    it('handles cursor pagination and stable ordering roundtrip', async () => {
      const d1 = await openDispute(app, filerBearer)
      await new Promise(resolve => setTimeout(resolve, 5))
      const d2 = await openDispute(app, filerBearer)
      await new Promise(resolve => setTimeout(resolve, 5))
      const d3 = await openDispute(app, filerBearer)

      const firstPage = await request(app)
        .get(`${BASE}?limit=2`)
        .set('Authorization', filerBearer)
        .expect(200)

      expect(firstPage.body.data).toHaveLength(2)
      // Newest first
      expect(firstPage.body.data[0].id).toBe(d3.id)
      expect(firstPage.body.data[1].id).toBe(d2.id)
      expect(firstPage.body.page.hasMore).toBe(true)
      expect(firstPage.body.page.nextCursor).toBeTruthy()

      const secondPage = await request(app)
        .get(`${BASE}?limit=2&cursor=${firstPage.body.page.nextCursor}`)
        .set('Authorization', filerBearer)
        .expect(200)

      expect(secondPage.body.data).toHaveLength(1)
      expect(secondPage.body.data[0].id).toBe(d1.id)
      expect(secondPage.body.page.hasMore).toBe(false)
      expect(secondPage.body.page.nextCursor).toBeNull()
    })
  })

  describe('state transitions', () => {
    it('applies a valid pending → under_review → resolved transition chain', async () => {
      const { id } = await openDispute(app, filerBearer)

      const reviewRes = await request(app)
        .post(`${BASE}/${id}/review`)
        .set('Authorization', verifierBearer)
        .expect(200)

      expect(reviewRes.body.status).toBe('under_review')

      const resolveRes = await request(app)
        .post(`${BASE}/${id}/resolve`)
        .set('Authorization', verifierBearer)
        .send({ resolution: 'Both parties agreed to settlement' })
        .expect(200)

      expect(resolveRes.body.status).toBe('resolved')
      expect(resolveRes.body.resolution).toBe('Both parties agreed to settlement')

      const fetched = await request(app)
        .get(`${BASE}/${id}`)
        .set('Authorization', filerBearer)
        .expect(200)

      expect(fetched.body.status).toBe('resolved')
    })

    it('rejects invalid transitions with the standard conflict error envelope', async () => {
      const { id } = await openDispute(app, filerBearer)

      await request(app)
        .post(`${BASE}/${id}/resolve`)
        .set('Authorization', verifierBearer)
        .send({ resolution: 'Resolved on first pass' })
        .expect(200)

      const res = await request(app)
        .post(`${BASE}/${id}/review`)
        .set('Authorization', verifierBearer)
        .expect(422)

      expect(res.body).toMatchObject({
        code: ErrorCode.INVALID_DISPUTE_TRANSITION,
        error_code: ErrorCode.INVALID_DISPUTE_TRANSITION,
      })
      expect(res.body.message).toContain('Invalid transition')
      expect(res.body.message).toContain('resolved')
      expect(res.body.message).toContain('under_review')
    })

    it('rejects resolve-then-reopen (resolved → pending) via HTTP', async () => {
      const { id } = await openDispute(app, filerBearer)

      await request(app)
        .post(`${BASE}/${id}/resolve`)
        .set('Authorization', verifierBearer)
        .send({ resolution: 'Final ruling' })
        .expect(200)

      const dismissRes = await request(app)
        .post(`${BASE}/${id}/dismiss`)
        .set('Authorization', verifierBearer)
        .send({ reason: 'Attempted reopen via dismiss' })
        .expect(422)

      expect(dismissRes.body.error_code).toBe(ErrorCode.INVALID_DISPUTE_TRANSITION)
      expect(dismissRes.body.message).toContain('Invalid transition')

      const fetched = await request(app)
        .get(`${BASE}/${id}`)
        .set('Authorization', filerBearer)
        .expect(200)

      expect(fetched.body.status).toBe('resolved')
    })

    it('records failure audit logs when an invalid transition is rejected', async () => {
      const { id } = await openDispute(app, filerBearer)

      await request(app)
        .post(`${BASE}/${id}/resolve`)
        .set('Authorization', verifierBearer)
        .send({ resolution: 'Closed' })
        .expect(200)

      await request(app)
        .post(`${BASE}/${id}/review`)
        .set('Authorization', verifierBearer)
        .expect(422)

      const logs = await auditLogService.getAllLogs()
      const failureLog = logs.find(
        (log) =>
          log.action === AuditAction.DISPUTE_MARKED_UNDER_REVIEW &&
          log.status === 'failure',
      )

      expect(failureLog).toBeDefined()
      expect(failureLog?.resourceId).toBe(id)
      expect(failureLog?.errorMessage).toContain('Invalid transition')
    })

    it('records success audit logs across valid transition endpoints', async () => {
      const { id } = await openDispute(app, filerBearer)

      await request(app)
        .post(`${BASE}/${id}/review`)
        .set('Authorization', verifierBearer)
        .expect(200)

      await request(app)
        .post(`${BASE}/${id}/resolve`)
        .set('Authorization', verifierBearer)
        .send({ resolution: 'Settled' })
        .expect(200)

      const logs = await auditLogService.getAllLogs()
      const actions = logs.map((log) => log.action)

      expect(actions).toContain(AuditAction.DISPUTE_SUBMITTED)
      expect(actions).toContain(AuditAction.DISPUTE_MARKED_UNDER_REVIEW)
      expect(actions).toContain(AuditAction.DISPUTE_RESOLVED)
      expect(logs.every((log) => log.status === 'success' || log.status === undefined)).toBe(true)
    })

    it('dismisses a pending dispute and writes a success audit log', async () => {
      const { id } = await openDispute(app, filerBearer)

      const res = await request(app)
        .post(`${BASE}/${id}/dismiss`)
        .set('Authorization', verifierBearer)
        .send({ reason: 'Insufficient evidence provided' })
        .expect(200)

      expect(res.body.status).toBe('dismissed')
      expect(res.body.resolution).toBe('Insufficient evidence provided')

      const logs = await auditLogService.getAllLogs()
      expect(logs.some((log) => log.action === AuditAction.DISPUTE_DISMISSED && log.status === 'success')).toBe(
        true,
      )
    })
  })

  describe('authorization', () => {
    it('rejects transition attempts without a bearer token', async () => {
      const { id } = await openDispute(app, filerBearer)

      const res = await request(app)
        .post(`${BASE}/${id}/review`)
        .expect(401)

      expect(res.body.error).toBe('Unauthorized')

      const fetched = await request(app)
        .get(`${BASE}/${id}`)
        .set('Authorization', filerBearer)
        .expect(200)

      expect(fetched.body.status).toBe('pending')
    })

    it('rejects transition attempts with an invalid bearer token', async () => {
      const { id } = await openDispute(app, filerBearer)

      const res = await request(app)
        .post(`${BASE}/${id}/resolve`)
        .set('Authorization', 'Bearer cr_' + '0'.repeat(64))
        .send({ resolution: 'Should not apply' })
        .expect(401)

      expect(res.body.error).toBe('Unauthorized')
    })
  })

  describe('edge cases', () => {
    it('rejects a duplicate under_review transition (wrong follow-up action)', async () => {
      const { id } = await openDispute(app, filerBearer)

      await request(app)
        .post(`${BASE}/${id}/review`)
        .set('Authorization', verifierBearer)
        .expect(200)

      const res = await request(app)
        .post(`${BASE}/${id}/review`)
        .set('Authorization', verifierBearer)
        .expect(422)

      expect(res.body.error_code).toBe(ErrorCode.INVALID_DISPUTE_TRANSITION)
      expect(res.body.message).toContain('Invalid transition')
    })

    it('handles concurrent resolve attempts: one succeeds, one conflicts', async () => {
      const { id } = await openDispute(app, filerBearer)

      const [first, second] = await Promise.all([
        request(app)
          .post(`${BASE}/${id}/resolve`)
          .set('Authorization', verifierBearer)
          .send({ resolution: 'Concurrent resolution A' }),
        request(app)
          .post(`${BASE}/${id}/resolve`)
          .set('Authorization', verifierBearer)
          .send({ resolution: 'Concurrent resolution B' }),
      ])

      const statuses = [first.status, second.status].sort()
      expect(statuses).toEqual([200, 422])

      const conflictBody = first.status === 422 ? first.body : second.body
      expect(conflictBody.error_code).toBe(ErrorCode.INVALID_DISPUTE_TRANSITION)
      expect(conflictBody.message).toContain('Invalid transition')

      const fetched = await request(app)
        .get(`${BASE}/${id}`)
        .set('Authorization', filerBearer)
        .expect(200)

      expect(fetched.body.status).toBe('resolved')
    })
  })
})
