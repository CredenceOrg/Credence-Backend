import { describe, it, expect } from 'vitest'
import request from 'supertest'
import app from '../index.js'

describe('API Endpoints', () => {
  describe('GET /api/health', () => {
    it('should return health status', async () => {
      const response = await request(app).get('/api/health')

      expect(response.status).toBe(200)
      expect(response.body.status).toBe('ok')
      expect(response.body.service).toBe('credence-backend')
      expect(response.body).toHaveProperty('dependencies')
    })
  })

  describe('GET /api/trust/:address', () => {
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
    })
  })
})
