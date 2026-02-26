import { describe, it, expect } from 'vitest'
import request from 'supertest'
import app from '../index.js'

<<<<<<< HEAD
describe('API Endpoints', () => {
  describe('GET /api/health', () => {
    it('should return health status', async () => {
      const response = await request(app).get('/api/health')

      expect(response.status).toBe(200)
      expect(response.body.status).toBe('ok')
      expect(response.body.service).toBe('credence-backend')
      expect(response.body).toHaveProperty('dependencies')
=======
const validAddress = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'

describe('API Endpoints', () => {
  describe('GET /api/health', () => {
    it('should return health status', async () => {
      const response = await request(app).get('/api/health')
      expect(response.status).toBe(200)
      expect(response.body.status).toBe('ok')
      expect(response.body.service).toBe('credence-backend')
>>>>>>> upstream/main
    })
  })

  describe('GET /api/trust/:address', () => {
<<<<<<< HEAD
    it('should return trust score for a valid address', async () => {
      const address = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e'
      const response = await request(app).get(`/api/trust/${address}`)

      expect(response.status).toBe(200)
      expect(response.body).toEqual({
        address,
        score: 0,
        bondedAmount: '0',
        bondStart: null,
        attestationCount: 0,
      })
    })

    it('should return 400 for invalid address', async () => {
      const response = await request(app).get('/api/trust/invalid')
      expect(response.status).toBe(400)
    })
  })

  describe('GET /api/bond/:address', () => {
    it('should return bond status for a valid address', async () => {
      const address = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e'
      const response = await request(app).get(`/api/bond/${address}`)

      expect(response.status).toBe(200)
      expect(response.body).toEqual({
        address,
        bondedAmount: '0',
        bondStart: null,
        bondDuration: null,
        active: false,
      })
    })

    it('should return 400 for invalid address', async () => {
      const response = await request(app).get('/api/bond/invalid')
      expect(response.status).toBe(400)
    })
  })

  describe('GET /api/verification/:address', () => {
    it('should return verification status', async () => {
      const address = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e'
      const response = await request(app).get(`/api/verification/${address}`)

      expect(response.status).toBe(200)
      expect(response.body).toEqual({
        address,
        proof: null,
        verified: false,
        timestamp: null,
      })
=======
    it('should return trust score for a known address', async () => {
      const response = await request(app).get(`/api/trust/${validAddress}`)
      expect(response.status).toBe(200)
      expect(response.body.address).toBe(validAddress)
      expect(response.body).toHaveProperty('score')
    })

    it('should return 400 for an invalid address', async () => {
      const response = await request(app).get('/api/trust/not-an-address')
      expect(response.status).toBe(400)
      expect(response.body).toHaveProperty('error')
    })

    it('should return 404 for a valid unknown address', async () => {
      const response = await request(app).get(
        '/api/trust/0x1234567890123456789012345678901234567890',
      )
      expect(response.status).toBe(404)
      expect(response.body).toHaveProperty('error')
    })
  })

  describe('GET /api/bond/:address', () => {
    it('should return bond status for a valid address', async () => {
      const response = await request(app).get(`/api/bond/${validAddress}`)
      expect(response.status).toBe(200)
      expect(response.body.address).toBe(validAddress)
      expect(response.body).toHaveProperty('active')
    })

    it('should return 400 for an invalid address', async () => {
      const response = await request(app).get('/api/bond/not-an-address')
      expect(response.status).toBe(400)
      expect(response.body).toHaveProperty('error')
    })
  })

  describe('POST /api/bulk/verify', () => {
    it('should handle valid JSON in request body', async () => {
      const response = await request(app)
        .post('/api/bulk/verify')
        .set('X-API-Key', 'test-enterprise-key-12345')
        .set('Content-Type', 'application/json')
        .send({ addresses: [validAddress] })
      expect(response.status).toBe(200)
>>>>>>> upstream/main
    })
  })
})
