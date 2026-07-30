import { Request, Response, NextFunction } from 'express'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { requireApiKey, ApiScope, AuthenticatedRequest } from '../middleware/auth.js'
import { _resetStore, generateApiKey, revokeApiKey } from '../services/apiKeys.js'
import { userRepo } from '../repositories/userRepository.js'

describe('Auth Middleware', () => {
  let mockRequest: Partial<Request>
  let mockResponse: Partial<Response>
  let nextFunction: NextFunction

  beforeEach(() => {
    _resetStore()
    userRepo._reset()
    // Seed users for owner resolution
    userRepo.upsert({ id: 'u-admin', role: 'super-admin', email: 'a@x.com', tenantId: 't-admin' })
    userRepo.upsert({ id: 'u-verifier', role: 'verifier', email: 'v@x.com', tenantId: 't-ver' })
    mockRequest = {
      headers: {},
    }
    mockResponse = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    }
    nextFunction = vi.fn()
  })

  describe('requireApiKey', () => {
    describe('Missing API Key', () => {
      it('should return 401 when API key header is missing', async () => {
        const middleware = requireApiKey(ApiScope.PUBLIC)
        await middleware(mockRequest as Request, mockResponse as Response, nextFunction)

        expect(mockResponse.status).toHaveBeenCalledWith(401)
        expect(mockResponse.json).toHaveBeenCalledWith({
          error: 'Unauthorized',
          message: 'API key is required',
        })
        expect(nextFunction).not.toHaveBeenCalled()
      })

      it('should return 401 when API key header is empty string', async () => {
        mockRequest.headers = { 'x-api-key': '' }
        const middleware = requireApiKey(ApiScope.PUBLIC)
        await middleware(mockRequest as Request, mockResponse as Response, nextFunction)

        expect(mockResponse.status).toHaveBeenCalledWith(401)
        expect(mockResponse.json).toHaveBeenCalledWith({
          error: 'Unauthorized',
          message: 'API key is required',
        })
        expect(nextFunction).not.toHaveBeenCalled()
      })
    })

    describe('Invalid API Key', () => {
      it('should return 401 when API key is invalid', async () => {
        mockRequest.headers = { 'x-api-key': 'invalid-key-12345' }
        const middleware = requireApiKey(ApiScope.PUBLIC)
        await middleware(mockRequest as Request, mockResponse as Response, nextFunction)

        expect(mockResponse.status).toHaveBeenCalledWith(401)
        expect(mockResponse.json).toHaveBeenCalledWith({
          error: 'Unauthorized',
          message: 'Invalid API key',
        })
        expect(nextFunction).not.toHaveBeenCalled()
      })

      it('should return 401 for random string', async () => {
        mockRequest.headers = { 'x-api-key': 'random-string' }
        const middleware = requireApiKey(ApiScope.PUBLIC)
        await middleware(mockRequest as Request, mockResponse as Response, nextFunction)

        expect(mockResponse.status).toHaveBeenCalledWith(401)
        expect(nextFunction).not.toHaveBeenCalled()
      })

      it('should return 401 for a well-formed but non-existent key', async () => {
        const random = 'cr_' + 'a'.repeat(64)
        mockRequest.headers = { 'x-api-key': random }
        const middleware = requireApiKey(ApiScope.PUBLIC)
        await middleware(mockRequest as Request, mockResponse as Response, nextFunction)

        expect(mockResponse.status).toHaveBeenCalledWith(401)
        expect(nextFunction).not.toHaveBeenCalled()
      })
    })

    describe('Insufficient Scope', () => {
      it('should return 403 when public key is used for enterprise endpoint', async () => {
        const pub = generateApiKey('u-verifier', 'read')
        mockRequest.headers = { 'x-api-key': pub.key }
        const middleware = requireApiKey(ApiScope.ENTERPRISE)
        await middleware(mockRequest as Request, mockResponse as Response, nextFunction)

        expect(mockResponse.status).toHaveBeenCalledWith(403)
        expect(mockResponse.json).toHaveBeenCalledWith({
          error: 'Forbidden',
          message: 'Enterprise API key required',
        })
        expect(nextFunction).not.toHaveBeenCalled()
      })

      it('should return 403 when trust:read key is used for payouts:write endpoint', async () => {
        const key = generateApiKey('u-verifier', ['trust:read'])
        mockRequest.headers = { 'x-api-key': key.key }
        const middleware = requireApiKey(ApiScope.PAYOUTS_WRITE)
        await middleware(mockRequest as Request, mockResponse as Response, nextFunction)

        expect(mockResponse.status).toHaveBeenCalledWith(403)
        expect(nextFunction).not.toHaveBeenCalled()
      })
    })

    describe('Valid API Keys', () => {
      it('should accept valid public API key for public endpoint', async () => {
        const pub = generateApiKey('u-verifier', 'read')
        mockRequest.headers = { 'x-api-key': pub.key }
        const middleware = requireApiKey(ApiScope.PUBLIC)
        await middleware(mockRequest as Request, mockResponse as Response, nextFunction)

        expect(nextFunction).toHaveBeenCalled()
        expect(mockResponse.status).not.toHaveBeenCalled()
        expect(mockResponse.json).not.toHaveBeenCalled()
      })

      it('should accept valid enterprise API key for public endpoint', async () => {
        const ent = generateApiKey('u-admin', 'full')
        mockRequest.headers = { 'x-api-key': ent.key }
        const middleware = requireApiKey(ApiScope.PUBLIC)
        await middleware(mockRequest as Request, mockResponse as Response, nextFunction)

        expect(nextFunction).toHaveBeenCalled()
        expect(mockResponse.status).not.toHaveBeenCalled()
      })

      it('should accept valid enterprise API key for enterprise endpoint', async () => {
        const ent = generateApiKey('u-admin', 'full')
        mockRequest.headers = { 'x-api-key': ent.key }
        const middleware = requireApiKey(ApiScope.ENTERPRISE)
        await middleware(mockRequest as Request, mockResponse as Response, nextFunction)

        expect(nextFunction).toHaveBeenCalled()
        expect(mockResponse.status).not.toHaveBeenCalled()
      })

      it('should attach API key metadata to request', async () => {
        const ent = generateApiKey('u-admin', 'full')
        mockRequest.headers = { 'x-api-key': ent.key }
        const middleware = requireApiKey(ApiScope.ENTERPRISE)
        await middleware(mockRequest as Request, mockResponse as Response, nextFunction)

        const authReq = mockRequest as AuthenticatedRequest
        expect(authReq.apiKey).toBeDefined()
        expect(authReq.apiKey?.id).toBeTruthy()
        expect(authReq.apiKey?.scope).toBe('full')
      })

      it('should attach correct scope for public key', async () => {
        const pub = generateApiKey('u-verifier', 'read')
        mockRequest.headers = { 'x-api-key': pub.key }
        const middleware = requireApiKey(ApiScope.PUBLIC)
        await middleware(mockRequest as Request, mockResponse as Response, nextFunction)

        const authReq = mockRequest as AuthenticatedRequest
        expect(authReq.apiKey?.scope).toBe('read')
      })
    })

    describe('Revoked Key', () => {
      it('should return 401 for a revoked key', async () => {
        const key = generateApiKey('u-admin', 'full')
        // Manually revoke by finding and deactivating
        revokeApiKey(key.id)

        mockRequest.headers = { 'x-api-key': key.key }
        const middleware = requireApiKey(ApiScope.ENTERPRISE)
        await middleware(mockRequest as Request, mockResponse as Response, nextFunction)

        expect(mockResponse.status).toHaveBeenCalledWith(401)
        expect(nextFunction).not.toHaveBeenCalled()
      })
    })

    describe('Authorization: Bearer header', () => {
      it('should accept key from Authorization: Bearer header', async () => {
        const key = generateApiKey('u-admin', 'full')
        mockRequest.headers = { authorization: `Bearer ${key.key}` }
        const middleware = requireApiKey(ApiScope.ENTERPRISE)
        await middleware(mockRequest as Request, mockResponse as Response, nextFunction)

        expect(nextFunction).toHaveBeenCalled()
      })

      it('should prefer X-API-Key over Authorization header', async () => {
        const goodKey = generateApiKey('u-admin', 'full')
        const badKey = 'cr_' + 'b'.repeat(64)
        mockRequest.headers = {
          'x-api-key': goodKey.key,
          authorization: `Bearer ${badKey}`,
        }
        const middleware = requireApiKey(ApiScope.ENTERPRISE)
        await middleware(mockRequest as Request, mockResponse as Response, nextFunction)

        expect(nextFunction).toHaveBeenCalled()
      })
    })

    describe('Case Sensitivity', () => {
      it('should handle header name case-insensitively', async () => {
        const ent = generateApiKey('u-admin', 'full')
        mockRequest.headers = { 'x-api-key': ent.key }
        const middleware = requireApiKey(ApiScope.ENTERPRISE)
        await middleware(mockRequest as Request, mockResponse as Response, nextFunction)

        expect(nextFunction).toHaveBeenCalled()
      })
    })
  })

  describe('ApiScope Enum', () => {
    it('should have PUBLIC scope', () => {
      expect(ApiScope.PUBLIC).toBe('public')
    })

    it('should have ENTERPRISE scope', () => {
      expect(ApiScope.ENTERPRISE).toBe('enterprise')
    })
  })
})
