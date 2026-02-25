import { describe, it, expect } from 'vitest'
import request from 'supertest'
import app from '../index.js'

describe('POST /api/bulk/verify', () => {
  const ENTERPRISE_KEY = 'test-enterprise-key-12345'
  const PUBLIC_KEY = 'test-public-key-67890'
  const INVALID_KEY = 'invalid-key'

  const VALID_ADDRESS_1 = 'GABC7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ'
  const VALID_ADDRESS_2 = 'GDEF7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ'
  const VALID_ADDRESS_3 = 'GHIJ7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ'
  const INVALID_ADDRESS = 'INVALID'

  describe('Authentication', () => {
    it('should return 401 when API key is missing', async () => {
      const response = await request(app)
        .post('/api/bulk/verify')
        .send({ addresses: [VALID_ADDRESS_1] })

      expect(response.status).toBe(401)
      expect(response.body).toEqual({
        error: 'Unauthorized',
        message: 'API key is required',
      })
    })

    it('should return 401 when API key is invalid', async () => {
      const response = await request(app)
        .post('/api/bulk/verify')
        .set('X-API-Key', INVALID_KEY)
        .send({ addresses: [VALID_ADDRESS_1] })

      expect(response.status).toBe(401)
      expect(response.body).toEqual({
        error: 'Unauthorized',
        message: 'Invalid API key',
      })
    })

    it('should return 403 when using public API key', async () => {
      const response = await request(app)
        .post('/api/bulk/verify')
        .set('X-API-Key', PUBLIC_KEY)
        .send({ addresses: [VALID_ADDRESS_1] })

      expect(response.status).toBe(403)
      expect(response.body).toEqual({
        error: 'Forbidden',
        message: 'Enterprise API key required',
      })
    })

    it('should accept valid enterprise API key', async () => {
      const response = await request(app)
        .post('/api/bulk/verify')
        .set('X-API-Key', ENTERPRISE_KEY)
        .send({ addresses: [VALID_ADDRESS_1] })

      expect(response.status).toBe(200)
    })
  })

  describe('Request Validation', () => {
    it('should return 400 when addresses is missing', async () => {
      const response = await request(app)
        .post('/api/bulk/verify')
        .set('X-API-Key', ENTERPRISE_KEY)
        .send({})

      expect(response.status).toBe(400)
      expect(response.body).toEqual({
        error: 'InvalidRequest',
        message: 'addresses must be an array',
      })
    })

    it('should return 400 when addresses is not an array', async () => {
      const response = await request(app)
        .post('/api/bulk/verify')
        .set('X-API-Key', ENTERPRISE_KEY)
        .send({ addresses: 'not-an-array' })

      expect(response.status).toBe(400)
      expect(response.body).toEqual({
        error: 'InvalidRequest',
        message: 'addresses must be an array',
      })
    })

    it('should return 400 when addresses contains non-string values', async () => {
      const response = await request(app)
        .post('/api/bulk/verify')
        .set('X-API-Key', ENTERPRISE_KEY)
        .send({ addresses: [VALID_ADDRESS_1, 123, null] })

      expect(response.status).toBe(400)
      expect(response.body).toEqual({
        error: 'InvalidRequest',
        message: 'All addresses must be strings',
      })
    })

    it('should return 400 when batch size is too small', async () => {
      const response = await request(app)
        .post('/api/bulk/verify')
        .set('X-API-Key', ENTERPRISE_KEY)
        .send({ addresses: [] })

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({
        error: 'BatchSizeTooSmall',
        message: expect.stringContaining('Minimum batch size'),
        limit: 1,
        received: 0,
      })
    })

    it('should return 413 when batch size exceeds limit', async () => {
      const addresses = Array(101).fill(VALID_ADDRESS_1)
      const response = await request(app)
        .post('/api/bulk/verify')
        .set('X-API-Key', ENTERPRISE_KEY)
        .send({ addresses })

      expect(response.status).toBe(413)
      expect(response.body).toMatchObject({
        error: 'BatchSizeExceeded',
        message: expect.stringContaining('Maximum batch size'),
        limit: 100,
        received: 101,
      })
    })
  })

  describe('Successful Verification', () => {
    it('should verify a single valid address', async () => {
      const response = await request(app)
        .post('/api/bulk/verify')
        .set('X-API-Key', ENTERPRISE_KEY)
        .send({ addresses: [VALID_ADDRESS_1] })

      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty('results')
      expect(response.body).toHaveProperty('errors')
      expect(response.body).toHaveProperty('metadata')

      expect(response.body.results).toHaveLength(1)
      
      const result = response.body.results[0]
      expect(result.address).toBe(VALID_ADDRESS_1)
      expect(result.trustScore).toBeGreaterThanOrEqual(0)
      expect(result.trustScore).toBeLessThanOrEqual(100)
      expect(result.bondStatus).toBeDefined()
      expect(result.bondStatus.bondedAmount).toBeDefined()
      expect(result.bondStatus.active).toBeDefined()
      expect(result.attestationCount).toBeGreaterThanOrEqual(0)
      expect(result.lastUpdated).toBeDefined()

      expect(response.body.metadata).toEqual({
        totalRequested: 1,
        successful: 1,
        failed: 0,
        batchSize: 1,
      })
    })

    it('should verify multiple valid addresses', async () => {
      const addresses = [VALID_ADDRESS_1, VALID_ADDRESS_2, VALID_ADDRESS_3]
      const response = await request(app)
        .post('/api/bulk/verify')
        .set('X-API-Key', ENTERPRISE_KEY)
        .send({ addresses })

      expect(response.status).toBe(200)
      expect(response.body.results).toHaveLength(3)
      expect(response.body.errors).toHaveLength(0)
      expect(response.body.metadata).toEqual({
        totalRequested: 3,
        successful: 3,
        failed: 0,
        batchSize: 3,
      })

      // Verify each result has correct structure
      response.body.results.forEach((result: any) => {
        expect(result).toMatchObject({
          address: expect.any(String),
          trustScore: expect.any(Number),
          bondStatus: expect.any(Object),
          attestationCount: expect.any(Number),
          lastUpdated: expect.any(String),
        })
      })
    })

    it('should handle duplicate addresses', async () => {
      const addresses = [VALID_ADDRESS_1, VALID_ADDRESS_1, VALID_ADDRESS_2]
      const response = await request(app)
        .post('/api/bulk/verify')
        .set('X-API-Key', ENTERPRISE_KEY)
        .send({ addresses })

      expect(response.status).toBe(200)
      expect(response.body.results).toHaveLength(2) // Duplicates removed
      expect(response.body.metadata).toEqual({
        totalRequested: 3,
        successful: 2,
        failed: 0,
        batchSize: 2, // Unique addresses
      })
    })

    it('should verify maximum batch size', async () => {
      const addresses = Array(100)
        .fill(null)
        .map((_, i) => `G${String(i).padStart(55, '0')}`)
      
      const response = await request(app)
        .post('/api/bulk/verify')
        .set('X-API-Key', ENTERPRISE_KEY)
        .send({ addresses })

      expect(response.status).toBe(200)
      expect(response.body.results.length + response.body.errors.length).toBe(100)
      expect(response.body.metadata.batchSize).toBe(100)
    })
  })

  describe('Partial Failure Handling', () => {
    it('should return partial results when some addresses are invalid', async () => {
      const addresses = [VALID_ADDRESS_1, INVALID_ADDRESS, VALID_ADDRESS_2]
      const response = await request(app)
        .post('/api/bulk/verify')
        .set('X-API-Key', ENTERPRISE_KEY)
        .send({ addresses })

      expect(response.status).toBe(200)
      expect(response.body.results).toHaveLength(2)
      expect(response.body.errors).toHaveLength(1)

      expect(response.body.errors[0]).toMatchObject({
        address: INVALID_ADDRESS,
        error: 'VerificationFailed',
        message: expect.any(String),
      })

      expect(response.body.metadata).toEqual({
        totalRequested: 3,
        successful: 2,
        failed: 1,
        batchSize: 3,
      })
    })

    it('should return all errors when all addresses are invalid', async () => {
      const addresses = ['INVALID1', 'INVALID2', 'INVALID3']
      const response = await request(app)
        .post('/api/bulk/verify')
        .set('X-API-Key', ENTERPRISE_KEY)
        .send({ addresses })

      expect(response.status).toBe(200)
      expect(response.body.results).toHaveLength(0)
      expect(response.body.errors).toHaveLength(3)
      expect(response.body.metadata).toEqual({
        totalRequested: 3,
        successful: 0,
        failed: 3,
        batchSize: 3,
      })
    })

    it('should include error details for each failed address', async () => {
      const addresses = [VALID_ADDRESS_1, 'BAD1', 'BAD2']
      const response = await request(app)
        .post('/api/bulk/verify')
        .set('X-API-Key', ENTERPRISE_KEY)
        .send({ addresses })

      expect(response.status).toBe(200)
      expect(response.body.errors).toHaveLength(2)

      response.body.errors.forEach((error: any) => {
        expect(error).toMatchObject({
          address: expect.any(String),
          error: 'VerificationFailed',
          message: expect.any(String),
        })
      })
    })
  })

  describe('Response Structure', () => {
    it('should return correct response structure', async () => {
      const response = await request(app)
        .post('/api/bulk/verify')
        .set('X-API-Key', ENTERPRISE_KEY)
        .send({ addresses: [VALID_ADDRESS_1] })

      expect(response.status).toBe(200)
      expect(response.body).toEqual({
        results: expect.any(Array),
        errors: expect.any(Array),
        metadata: {
          totalRequested: expect.any(Number),
          successful: expect.any(Number),
          failed: expect.any(Number),
          batchSize: expect.any(Number),
        },
      })
    })

    it('should include all required fields in verification result', async () => {
      const response = await request(app)
        .post('/api/bulk/verify')
        .set('X-API-Key', ENTERPRISE_KEY)
        .send({ addresses: [VALID_ADDRESS_1] })

      const result = response.body.results[0]
      expect(result).toHaveProperty('address')
      expect(result).toHaveProperty('trustScore')
      expect(result).toHaveProperty('bondStatus')
      expect(result).toHaveProperty('attestationCount')
      expect(result).toHaveProperty('lastUpdated')

      expect(result.bondStatus).toHaveProperty('bondedAmount')
      expect(result.bondStatus).toHaveProperty('bondStart')
      expect(result.bondStatus).toHaveProperty('bondDuration')
      expect(result.bondStatus).toHaveProperty('active')
    })

    it('should handle internal server errors gracefully', async () => {
      // Send malformed JSON to trigger error handling
      const response = await request(app)
        .post('/api/bulk/verify')
        .set('X-API-Key', ENTERPRISE_KEY)
        .set('Content-Type', 'application/json')
        .send('{"addresses": [')

      expect(response.status).toBe(400)
    })
  })
})
