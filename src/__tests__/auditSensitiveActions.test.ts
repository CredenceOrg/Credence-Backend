import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import app from '../index.js'
import { auditLogService } from '../services/audit/index.js'
import { AuditAction } from '../services/audit/types.js'
import { API_KEY_TO_USER, MOCK_USERS, UserRole } from '../middleware/auth.js'

describe('Sensitive action audit integration', () => {
  const ADMIN_TOKEN = 'Bearer admin-key-12345'
  const VERIFIER_TOKEN = 'Bearer verifier-key-67890'
  const validStellarAddress = 'G' + 'A'.repeat(55)

  beforeAll(() => {
    process.env.EVIDENCE_ENCRYPTION_KEY = '12345678901234567890123456789012'
    MOCK_USERS['user-basic-1'] = {
      id: 'user-basic-1',
      role: UserRole.USER,
      email: 'user@credence.org',
      apiKey: 'user-key-00000',
    }
    API_KEY_TO_USER['user-key-00000'] = 'user-basic-1'
  })

  beforeEach(async () => {
    await auditLogService.clearLogs()
  })

  it('writes dispute submission audit entry and queries by actor/resource/time', async () => {
    const submitResponse = await request(app)
      .post('/api/disputes')
      .set('Authorization', ADMIN_TOKEN)
      .send({
        filedBy: validStellarAddress,
        respondent: 'G' + 'B'.repeat(55),
        reason: 'Fraudulent identity claim reported by multiple verifiers.',
        evidence: ['hash://evidence/1'],
        deadlineMs: 3_600_000,
      })

    expect(submitResponse.status).toBe(201)
    const disputeId = submitResponse.body.id

    const from = new Date(Date.now() - 1000).toISOString()
    const logsResponse = await request(app)
      .get(`/api/admin/audit-logs?actorId=admin-user-1&resourceId=${disputeId}&from=${encodeURIComponent(from)}`)
      .set('Authorization', ADMIN_TOKEN)

    expect(logsResponse.status).toBe(200)
    expect(logsResponse.body.data.total).toBeGreaterThanOrEqual(1)

    const log = logsResponse.body.data.logs[0]
    expect(log.action).toBe(AuditAction.DISPUTE_SUBMITTED)
    expect(log.actorId).toBe('admin-user-1')
    expect(log.resourceId).toBe(disputeId)
    expect(log.timestamp).toBeDefined()
  })

  it('writes slash vote audit entries', async () => {
    const createResponse = await request(app)
      .post('/api/governance/slash-requests')
      .set('Authorization', VERIFIER_TOKEN)
      .send({
        targetAddress: '0xabc',
        reason: 'Double-signing detected',
        requestedBy: 'verifier-user-1',
      })

    expect(createResponse.status).toBe(201)

    const slashRequestId = createResponse.body.id
    const voteResponse = await request(app)
      .post(`/api/governance/slash-requests/${slashRequestId}/votes`)
      .set('Authorization', VERIFIER_TOKEN)
      .send({ voterId: 'signer-1', choice: 'approve' })

    expect(voteResponse.status).toBe(201)

    const logsResponse = await request(app)
      .get(`/api/admin/audit-logs?action=${AuditAction.SLASH_VOTE_CAST}&resourceId=${slashRequestId}`)
      .set('Authorization', ADMIN_TOKEN)

    expect(logsResponse.status).toBe(200)
    expect(logsResponse.body.data.logs.length).toBeGreaterThanOrEqual(1)
    expect(logsResponse.body.data.logs[0].action).toBe(AuditAction.SLASH_VOTE_CAST)
  })

  it('writes evidence access audit entries', async () => {
    const uploadResponse = await request(app)
      .post('/api/evidence/upload')
      .set('Authorization', ADMIN_TOKEN)
      .send({ rawData: 'encrypted payload reference' })

    expect(uploadResponse.status).toBe(201)
    const evidenceId = uploadResponse.body.evidence_id

    const retrieveResponse = await request(app)
      .get(`/api/evidence/${evidenceId}`)
      .set('Authorization', VERIFIER_TOKEN)

    expect(retrieveResponse.status).toBe(200)

    const logsResponse = await request(app)
      .get(`/api/admin/audit-logs?action=${AuditAction.EVIDENCE_ACCESSED}&resourceId=${evidenceId}`)
      .set('Authorization', ADMIN_TOKEN)

    expect(logsResponse.status).toBe(200)
    expect(logsResponse.body.data.logs.length).toBeGreaterThanOrEqual(1)
    expect(logsResponse.body.data.logs[0].resourceType).toBe('evidence')
  })

  it('covers dispute review, resolve, dismiss, and failure branches', async () => {
    const create = await request(app)
      .post('/api/disputes')
      .set('Authorization', ADMIN_TOKEN)
      .send({
        filedBy: validStellarAddress,
        respondent: 'G' + 'C'.repeat(55),
        reason: 'Escalated dispute requiring lifecycle transitions.',
        evidence: ['hash://evidence/2'],
        deadlineMs: 3_600_000,
      })

    expect(create.status).toBe(201)
    const disputeId = create.body.id

    const review = await request(app)
      .post(`/api/disputes/${disputeId}/review`)
      .set('Authorization', ADMIN_TOKEN)
      .send({})
    expect(review.status).toBe(200)

    const resolve = await request(app)
      .post(`/api/disputes/${disputeId}/resolve`)
      .set('Authorization', ADMIN_TOKEN)
      .send({ resolution: 'Dispute resolved after review.' })
    expect(resolve.status).toBe(200)

    const dismissResolved = await request(app)
      .post(`/api/disputes/${disputeId}/dismiss`)
      .set('Authorization', ADMIN_TOKEN)
      .send({ reason: 'should fail' })
    expect(dismissResolved.status).toBe(409)

    const getMissing = await request(app)
      .get('/api/disputes/non-existent-id')
      .set('Authorization', ADMIN_TOKEN)
    expect(getMissing.status).toBe(404)

    const badSubmit = await request(app)
      .post('/api/disputes')
      .set('Authorization', ADMIN_TOKEN)
      .send({ filedBy: 'bad', respondent: 'bad', reason: 'short', evidence: [], deadlineMs: 1 })
    expect(badSubmit.status).toBe(400)

    const unresolved = await request(app)
      .post('/api/disputes')
      .set('Authorization', ADMIN_TOKEN)
      .send({
        filedBy: validStellarAddress,
        respondent: 'G' + 'D'.repeat(55),
        reason: 'Another dispute for conflict branches.',
        evidence: ['hash://evidence/3'],
        deadlineMs: 3_600_000,
      })
    expect(unresolved.status).toBe(201)

    const unresolvedId = unresolved.body.id
    const badResolve = await request(app)
      .post(`/api/disputes/${unresolvedId}/resolve`)
      .set('Authorization', ADMIN_TOKEN)
      .send({ resolution: '' })
    expect(badResolve.status).toBe(409)

    const badDismiss = await request(app)
      .post(`/api/disputes/${unresolvedId}/dismiss`)
      .set('Authorization', ADMIN_TOKEN)
      .send({ reason: '' })
    expect(badDismiss.status).toBe(409)

    const firstReview = await request(app)
      .post(`/api/disputes/${unresolvedId}/review`)
      .set('Authorization', ADMIN_TOKEN)
      .send({})
    expect(firstReview.status).toBe(200)

    const secondReview = await request(app)
      .post(`/api/disputes/${unresolvedId}/review`)
      .set('Authorization', ADMIN_TOKEN)
      .send({})
    expect(secondReview.status).toBe(409)
  })

  it('covers governance list/get/not-found/conflict branches', async () => {
    const list = await request(app)
      .get('/api/governance/slash-requests')
      .set('Authorization', VERIFIER_TOKEN)
    expect(list.status).toBe(200)

    const missing = await request(app)
      .post('/api/governance/slash-requests/missing-id/votes')
      .set('Authorization', VERIFIER_TOKEN)
      .send({ voterId: 'v1', choice: 'approve' })
    expect(missing.status).toBe(404)

    const create = await request(app)
      .post('/api/governance/slash-requests')
      .set('Authorization', VERIFIER_TOKEN)
      .send({ targetAddress: '0xdef', reason: 'policy breach', requestedBy: 'verifier-user-1' })
    expect(create.status).toBe(201)

    const slashId = create.body.id
    const getById = await request(app)
      .get(`/api/governance/slash-requests/${slashId}`)
      .set('Authorization', VERIFIER_TOKEN)
    expect(getById.status).toBe(200)

    const firstVote = await request(app)
      .post(`/api/governance/slash-requests/${slashId}/votes`)
      .set('Authorization', VERIFIER_TOKEN)
      .send({ voterId: 'dup-voter', choice: 'approve' })
    expect(firstVote.status).toBe(201)

    const duplicateVote = await request(app)
      .post(`/api/governance/slash-requests/${slashId}/votes`)
      .set('Authorization', VERIFIER_TOKEN)
      .send({ voterId: 'dup-voter', choice: 'reject' })
    expect(duplicateVote.status).toBe(409)

    const invalidCreate = await request(app)
      .post('/api/governance/slash-requests')
      .set('Authorization', VERIFIER_TOKEN)
      .send({
        targetAddress: '0xinvalid',
        reason: 'bad threshold to trigger error branch',
        requestedBy: 'verifier-user-1',
        threshold: 0,
        totalSigners: 2,
      })
    expect(invalidCreate.status).toBe(400)

    const unknownGet = await request(app)
      .get('/api/governance/slash-requests/does-not-exist')
      .set('Authorization', VERIFIER_TOKEN)
    expect(unknownGet.status).toBe(404)
  })

  it('covers evidence validation and not-found failure branches', async () => {
    const missingRawData = await request(app)
      .post('/api/evidence/upload')
      .set('Authorization', ADMIN_TOKEN)
      .send({})
    expect(missingRawData.status).toBe(400)

    const missingEvidence = await request(app)
      .get('/api/evidence/non-existent-evidence')
      .set('Authorization', ADMIN_TOKEN)

    expect(missingEvidence.status).toBe(404)

    const forbiddenEvidence = await request(app)
      .get('/api/evidence/non-existent-evidence')
      .set('Authorization', 'Bearer user-key-00000')
    expect(forbiddenEvidence.status).toBe(403)
  })

  it('audits evidence upload failure for duplicate IDs and maps invalid IDs to 400', async () => {
    const duplicateEvidenceId = 'immutable-evidence-id'

    const firstUpload = await request(app)
      .post('/api/evidence/upload')
      .set('Authorization', ADMIN_TOKEN)
      .send({ evidenceId: duplicateEvidenceId, rawData: 'first payload' })
    expect(firstUpload.status).toBe(201)

    const secondUpload = await request(app)
      .post('/api/evidence/upload')
      .set('Authorization', ADMIN_TOKEN)
      .send({ evidenceId: duplicateEvidenceId, rawData: 'second payload' })
    expect(secondUpload.status).toBe(400)

    const badIdLookup = await request(app)
      .get('/api/evidence/%20')
      .set('Authorization', ADMIN_TOKEN)
    expect(badIdLookup.status).toBe(400)

    const failureLogs = await request(app)
      .get(`/api/admin/audit-logs?action=${AuditAction.EVIDENCE_UPLOADED}&status=failure&resourceId=${duplicateEvidenceId}`)
      .set('Authorization', ADMIN_TOKEN)

    expect(failureLogs.status).toBe(200)
    expect(failureLogs.body.data.total).toBeGreaterThanOrEqual(1)
    expect(failureLogs.body.data.logs[0].errorMessage).toContain('Evidence already exists')
  })
})
