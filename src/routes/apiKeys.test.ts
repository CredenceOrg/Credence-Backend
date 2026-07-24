import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import apiKeysRouter from './apiKeys.js'
import { generateApiKey, _setUseInMemory, _resetStore, ApiKeyScope } from '../services/apiKeys.js'

describe('API Keys Routes', () => {
  let app: express.Express
  let testApiKey: string

  beforeEach(async () => {
    _resetStore()
    _setUseInMemory(true)

    // Create a test API key with bond:write scope for creating other keys
    const result = await generateApiKey('test-owner', [ApiKeyScope.BOND_WRITE], 'pro')
    testApiKey = result.key

    // Setup Express app
    app = express()
    app.use(express.json())
    app.use('/api/api-keys', apiKeysRouter)
  })

  afterEach(() => {
    _resetStore()
  })

  describe('POST /api/api-keys', () => {
    it('should create a new API key with valid scopes', async () => {
      const response = await request(app)
        .post('/api/api-keys')
        .set('Authorization', `Bearer ${testApiKey}`)
        .send({
          ownerId: 'new-owner',
          scopes: [ApiKeyScope.BOND_READ, ApiKeyScope.TRUST_READ],
          tier: 'free',
        })

      expect(response.status).toBe(201)
      expect(response.body).toHaveProperty('id')
      expect(response.body).toHaveProperty('key')
      expect(response.body).toHaveProperty('prefix')
      expect(response.body.scopes).toEqual([ApiKeyScope.BOND_READ, ApiKeyScope.TRUST_READ])
      expect(response.body.tier).toBe('free')
    })

    it('should create a key with empty scopes (least privilege)', async () => {
      const response = await request(app)
        .post('/api/api-keys')
        .set('Authorization', `Bearer ${testApiKey}`)
        .send({
          ownerId: 'new-owner',
        })

      expect(response.status).toBe(201)
      expect(response.body.scopes).toEqual([])
    })

    it('should reject invalid scopes', async () => {
      const response = await request(app)
        .post('/api/api-keys')
        .set('Authorization', `Bearer ${testApiKey}`)
        .send({
          ownerId: 'new-owner',
          scopes: ['invalid:scope'],
        })

      expect(response.status).toBe(400)
      expect(response.body).toHaveProperty('error')
    })

    it('should require ownerId', async () => {
      const response = await request(app)
        .post('/api/api-keys')
        .set('Authorization', `Bearer ${testApiKey}`)
        .send({
          scopes: [ApiKeyScope.BOND_READ],
        })

      expect(response.status).toBe(400)
      expect(response.body.error).toBe('ownerId is required')
    })

    it('should reject requests without API key', async () => {
      const response = await request(app)
        .post('/api/api-keys')
        .send({
          ownerId: 'new-owner',
          scopes: [ApiKeyScope.BOND_READ],
        })

      expect(response.status).toBe(401)
    })

    it('should reject requests with invalid API key', async () => {
      const response = await request(app)
        .post('/api/api-keys')
        .set('Authorization', 'Bearer invalid-key')
        .send({
          ownerId: 'new-owner',
          scopes: [ApiKeyScope.BOND_READ],
        })

      expect(response.status).toBe(401)
    })
  })

  describe('GET /api/api-keys/:ownerId', () => {
    beforeEach(async () => {
      // Create some test keys
      await generateApiKey('owner1', [ApiKeyScope.BOND_READ])
      await generateApiKey('owner1', [ApiKeyScope.TRUST_READ])
      await generateApiKey('owner2', [ApiKeyScope.BOND_WRITE])
    })

    it('should list all keys for an owner', async () => {
      const response = await request(app)
        .get('/api/api-keys/owner1')
        .set('Authorization', `Bearer ${testApiKey}`)

      expect(response.status).toBe(200)
      expect(Array.isArray(response.body)).toBe(true)
      expect(response.body).toHaveLength(2)
      response.body.forEach((key: any) => {
        expect(key.ownerId).toBe('owner1')
        expect(key).not.toHaveProperty('hashedKey')
      })
    })

    it('should return empty array for owner with no keys', async () => {
      const response = await request(app)
        .get('/api/api-keys/nonexistent')
        .set('Authorization', `Bearer ${testApiKey}`)

      expect(response.status).toBe(200)
      expect(response.body).toEqual([])
    })

    it('should require authentication', async () => {
      const response = await request(app).get('/api/api-keys/owner1')

      expect(response.status).toBe(401)
    })
  })

  describe('DELETE /api/api-keys/:id', () => {
    it('should revoke an existing key', async () => {
      const key = await generateApiKey('owner1', [ApiKeyScope.BOND_READ])
      
      const response = await request(app)
        .delete(`/api/api-keys/${key.id}`)
        .set('Authorization', `Bearer ${testApiKey}`)

      expect(response.status).toBe(204)
    })

    it('should return 404 for non-existent key', async () => {
      const response = await request(app)
        .delete('/api/api-keys/nonexistent-id')
        .set('Authorization', `Bearer ${testApiKey}`)

      expect(response.status).toBe(404)
    })

    it('should require authentication', async () => {
      const response = await request(app).delete('/api/api-keys/some-id')

      expect(response.status).toBe(401)
    })
  })

  describe('POST /api/api-keys/:id/rotate', () => {
    it('should rotate an existing key', async () => {
      const key = await generateApiKey('owner1', [ApiKeyScope.BOND_READ, ApiKeyScope.TRUST_READ])
      
      const response = await request(app)
        .post(`/api/api-keys/${key.id}/rotate`)
        .set('Authorization', `Bearer ${testApiKey}`)

      expect(response.status).toBe(201)
      expect(response.body).toHaveProperty('key')
      expect(response.body).toHaveProperty('id')
      expect(response.body.scopes).toEqual([ApiKeyScope.BOND_READ, ApiKeyScope.TRUST_READ])
      expect(response.body.key).not.toBe(key.key)
    })

    it('should return 404 for non-existent key', async () => {
      const response = await request(app)
        .post('/api/api-keys/nonexistent-id/rotate')
        .set('Authorization', `Bearer ${testApiKey}`)

      expect(response.status).toBe(404)
    })

    it('should require authentication', async () => {
      const response = await request(app).post('/api/api-keys/some-id/rotate')

      expect(response.status).toBe(401)
    })
  })
})
