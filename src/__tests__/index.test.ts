import { describe, it, expect } from 'vitest'
import request from 'supertest'
import app from '../index.js'
import { AuthService } from '../services/auth.js'

const authService = new AuthService({
  issuer: 'credence-api',
  accessTokenSecret: 'dev-access-secret-change-me',
  refreshTokenSecret: 'dev-refresh-secret-change-me',
  accessTokenExpiry: '15m',
  refreshTokenExpiry: '7d',
})
const accessToken = authService.issueTokenPair('index-test-user').accessToken

describe('API Endpoints', () => {
  describe('GET /api/health', () => {
    it('should return health status', async () => {
      const response = await request(app).get('/api/health')

      expect(response.status).toBe(200)
      expect(response.body.status).toBe('ok')
      expect(response.body.service).toBe('credence-backend')
    })
  })

  describe('GET /api/trust/:address', () => {
    it('should return trust score for an address', async () => {
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

    it('should handle different addresses', async () => {
      const address = '0x0000000000000000000000000000000000000001'
      const response = await request(app).get(`/api/trust/${address}`)

      expect(response.status).toBe(200)
      expect(response.body.address).toBe(address)
    })

    it('should return 400 for invalid address format', async () => {
      const address = 'invalid-address'
      const response = await request(app).get(`/api/trust/${address}`)

      expect(response.status).toBe(400)
      expect(response.body.error).toMatch(/Validation failed/i)
    })
  })

  describe('GET /api/bond/:address', () => {
    it('should return bond status for an address', async () => {
      const address = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e'
      const response = await request(app).get(`/api/bond/${address}`)

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({
        address,
        bondedAmount: '0',
        bondStart: null,
        bondDuration: null,
        active: false,
      })
    })

    it('should return 400 for invalid address format', async () => {
      const address = 'invalid-address'
      const response = await request(app).get(`/api/bond/${address}`)

      expect(response.status).toBe(400)
      expect(response.body.error).toMatch(/Validation failed/i)
    })
  })

  describe('POST /api/bulk/verify', () => {
    it('should handle valid JSON in request body', async () => {
      const response = await request(app)
        .post('/api/bulk/verify')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Content-Type', 'application/json')
        .send({
          addresses: ['GABC7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ'],
        })

      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty('results')
      expect(response.body).toHaveProperty('metadata')
    })

    it('should return 401 without authorization', async () => {
      const response = await request(app)
        .post('/api/bulk/verify')
        .send({ addresses: ['GABC...'] })

      expect(response.status).toBe(401)
    })
  })

  describe('404 Handling', () => {
    it('should return 404 for unknown routes', async () => {
      const response = await request(app).get('/api/unknown')
      expect(response.status).toBe(404)
    })
  })
})
