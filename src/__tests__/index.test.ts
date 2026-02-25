import { describe, it, expect } from 'vitest'
import request from 'supertest'
import app from '../index.js'

describe('API Endpoints', () => {
  describe('GET /api/health', () => {
    it('should return health status', async () => {
      const response = await request(app).get('/api/health')

      expect(response.status).toBe(200)
      expect(response.body).toEqual({
        status: 'ok',
        service: 'credence-backend',
      })
    })
  })

  describe('GET /api/trust/:address', () => {
    it('should return trust score for an address', async () => {
      const address = 'GABC7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ'
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
      const address = 'GDEF7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ'
      const response = await request(app).get(`/api/trust/${address}`)

      expect(response.status).toBe(200)
      expect(response.body.address).toBe(address)
    })
  })

  describe('GET /api/bond/:address', () => {
    it('should return bond status for an address', async () => {
      const address = 'GABC7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ'
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

    it('should handle different addresses', async () => {
      const address = 'GDEF7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ'
      const response = await request(app).get(`/api/bond/${address}`)

      expect(response.status).toBe(200)
      expect(response.body.address).toBe(address)
    })
  })

  describe('404 Handling', () => {
    it('should return 404 for unknown routes', async () => {
      const response = await request(app).get('/api/unknown')

      expect(response.status).toBe(404)
    })
  })
})


  describe('JSON Parsing', () => {
    it('should handle valid JSON in request body', async () => {
      const response = await request(app)
        .post('/api/bulk/verify')
        .set('X-API-Key', 'test-enterprise-key-12345')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ addresses: ['GABC7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ'] }))

      expect(response.status).toBe(200)
    })
  })
