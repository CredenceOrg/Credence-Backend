import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { app } from './index.js'

const validAddress = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e'

describe('API request validation', () => {
  beforeAll(() => {
    process.env.NODE_ENV = 'test'
  })
  afterAll(() => {
    delete process.env.NODE_ENV
  })

  describe('GET /api/health', () => {
    it('returns 200 with status and dependencies', async () => {
      const res = await request(app).get('/api/health')
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({
        status: 'ok',
        service: 'credence-backend',
      })
      expect(res.body).toHaveProperty('dependencies')
    })
  })

  describe('GET /api/trust/:address', () => {
    it('returns 200 for valid address', async () => {
      const res = await request(app).get(`/api/trust/${validAddress}`)
      expect(res.status).toBe(200)
      expect(res.body.address).toBe(validAddress)
      expect(res.body).toHaveProperty('score')
    })

    it('returns 400 for invalid address format', async () => {
      const res = await request(app).get('/api/trust/not-an-address')
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Validation failed')
      expect(res.body.details).toBeDefined()
      expect(Array.isArray(res.body.details)).toBe(true)
      expect(res.body.details.some((d: { path: string }) => d.path.includes('address'))).toBe(true)
    })

    it('returns 400 for address without 0x prefix', async () => {
      const res = await request(app).get(
        '/api/trust/742d35Cc6634C0532925a3b844Bc454e4438f44e',
      )
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Validation failed')
    })

    it('returns 400 for too-short address', async () => {
      const res = await request(app).get('/api/trust/0x' + 'a'.repeat(39))
      expect(res.status).toBe(400)
    })
  })

  describe('GET /api/bond/:address', () => {
    it('returns 200 for valid address', async () => {
      const res = await request(app).get(`/api/bond/${validAddress}`)
      expect(res.status).toBe(200)
      expect(res.body.address).toBe(validAddress)
      expect(res.body).toHaveProperty('bondedAmount')
    })

    it('returns 400 for invalid address', async () => {
      const res = await request(app).get('/api/bond/invalid')
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Validation failed')
      expect(res.body.details).toBeDefined()
    })
  })

  describe('GET /api/attestations/:address', () => {
    it('returns 200 for valid address and default query', async () => {
      const res = await request(app).get(`/api/attestations/${validAddress}`)
      expect(res.status).toBe(200)
      expect(res.body.address).toBe(validAddress)
      expect(res.body.limit).toBe(20)
      expect(res.body.offset).toBe(0)
    })

    it('returns 200 with valid limit and offset', async () => {
      const res = await request(app)
        .get(`/api/attestations/${validAddress}`)
        .query({ limit: 50, offset: 10 })
      expect(res.status).toBe(200)
      expect(res.body.limit).toBe(50)
      expect(res.body.offset).toBe(10)
    })

    it('returns 400 for invalid address', async () => {
      const res = await request(app).get('/api/attestations/bad-address')
      expect(res.status).toBe(400)
    })

    it('returns 400 for invalid query (limit out of range)', async () => {
      const res = await request(app)
        .get(`/api/attestations/${validAddress}`)
        .query({ limit: 200 })
      expect(res.status).toBe(400)
    })
  })

  describe('POST /api/attestations', () => {
    it('returns 201 for valid body', async () => {
      const res = await request(app)
        .post('/api/attestations')
        .send({
          subject: validAddress,
          value: 'attestation-value',
        })
      expect(res.status).toBe(201)
      expect(res.body.subject).toBe(validAddress)
      expect(res.body.value).toBe('attestation-value')
    })

    it('returns 400 for missing required field (value)', async () => {
      const res = await request(app)
        .post('/api/attestations')
        .send({ subject: validAddress })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Validation failed')
      expect(res.body.details).toBeDefined()
    })

    it('returns 400 for missing required field (subject)', async () => {
      const res = await request(app)
        .post('/api/attestations')
        .send({ value: 'v' })
      expect(res.status).toBe(400)
    })

    it('returns 400 for invalid subject address', async () => {
      const res = await request(app)
        .post('/api/attestations')
        .send({ subject: 'not-an-address', value: 'v' })
      expect(res.status).toBe(400)
    })
  })
})
