import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createGovernanceRouter } from './governance.js'
import { AuthService } from '../services/auth.js'
import { DisputeSubmissionError, type DisputeSubmissionService } from '../services/governance/disputeSubmissions.js'

const authService = new AuthService({
  issuer: 'credence-api',
  accessTokenSecret: 'dev-access-secret-change-me',
  refreshTokenSecret: 'dev-refresh-secret-change-me',
  accessTokenExpiry: '15m',
  refreshTokenExpiry: '7d',
})
const ACCESS_TOKEN = authService.issueTokenPair('governance-route-test').accessToken

function appWithRouter(service: DisputeSubmissionService) {
  const app = express()
  app.use(express.json())
  app.use('/api/governance', createGovernanceRouter(service))
  return app
}

describe('Governance routes', () => {
  it('returns 401 when JWT is missing', async () => {
    const service = {
      submit: vi.fn(),
    } as unknown as DisputeSubmissionService
    const res = await request(appWithRouter(service))
      .post('/api/governance/disputes')
      .send({})

    expect(res.status).toBe(401)
  })

  it('returns 201 for successful submission', async () => {
    const service = {
      submit: vi.fn().mockResolvedValue({
        id: 'dispute-1',
        slashRequestId: 'slash-1',
        identity: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2',
        evidence: ['tx:1'],
        stake: '100',
        status: 'submitted',
        submittedAt: new Date('2026-02-25T00:00:00.000Z'),
      }),
    } as unknown as DisputeSubmissionService
    const res = await request(appWithRouter(service))
      .post('/api/governance/disputes')
      .set('Authorization', `Bearer ${ACCESS_TOKEN}`)
      .send({
        slash_request_id: 'slash-1',
        identity: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2',
        evidence: ['tx:1'],
        stake: '100',
      })

    expect(res.status).toBe(201)
    expect(res.body.dispute.id).toBe('dispute-1')
    expect(res.body.arbitration.queued).toBe(true)
  })

  it('maps validation errors to 400', async () => {
    const service = {
      submit: vi.fn().mockRejectedValue(
        new DisputeSubmissionError('VALIDATION_ERROR', 'bad payload')
      ),
    } as unknown as DisputeSubmissionService
    const res = await request(appWithRouter(service))
      .post('/api/governance/disputes')
      .set('Authorization', `Bearer ${ACCESS_TOKEN}`)
      .send({})

    expect(res.status).toBe(400)
  })

  it('maps slash request missing to 404', async () => {
    const service = {
      submit: vi.fn().mockRejectedValue(
        new DisputeSubmissionError('SLASH_REQUEST_NOT_FOUND', 'missing')
      ),
    } as unknown as DisputeSubmissionService
    const res = await request(appWithRouter(service))
      .post('/api/governance/disputes')
      .set('Authorization', `Bearer ${ACCESS_TOKEN}`)
      .send({})

    expect(res.status).toBe(404)
  })

  it('maps deadline passed to 422', async () => {
    const service = {
      submit: vi.fn().mockRejectedValue(
        new DisputeSubmissionError('DEADLINE_PASSED', 'late')
      ),
    } as unknown as DisputeSubmissionService
    const res = await request(appWithRouter(service))
      .post('/api/governance/disputes')
      .set('Authorization', `Bearer ${ACCESS_TOKEN}`)
      .send({})

    expect(res.status).toBe(422)
  })

  it('maps conflict errors to 409', async () => {
    const service = {
      submit: vi.fn().mockRejectedValue(
        new DisputeSubmissionError('NOT_DISPUTABLE', 'no')
      ),
    } as unknown as DisputeSubmissionService
    const res = await request(appWithRouter(service))
      .post('/api/governance/disputes')
      .set('Authorization', `Bearer ${ACCESS_TOKEN}`)
      .send({})

    expect(res.status).toBe(409)
  })
})
