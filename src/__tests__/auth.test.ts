import { Request, Response, NextFunction } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthService } from '../services/auth.js'
import { AuthenticatedRequest, requireJwtAuth } from '../middleware/auth.js'

describe('JWT Auth Middleware', () => {
  let mockRequest: Partial<Request>
  let mockResponse: Partial<Response>
  let nextFunction: NextFunction
  let authService: AuthService

  beforeEach(() => {
    authService = new AuthService({
      issuer: 'credence-test',
      accessTokenSecret: 'access-test-secret',
      refreshTokenSecret: 'refresh-test-secret',
      accessTokenExpiry: '15m',
      refreshTokenExpiry: '7d',
    })

    mockRequest = { headers: {} }
    mockResponse = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    }
    nextFunction = vi.fn()
  })

  it('returns 401 when authorization header is missing', () => {
    const middleware = requireJwtAuth(authService)
    middleware(mockRequest as Request, mockResponse as Response, nextFunction)

    expect(mockResponse.status).toHaveBeenCalledWith(401)
    expect(mockResponse.json).toHaveBeenCalledWith({
      error: 'Unauthorized',
      message: 'Authorization header is required',
    })
    expect(nextFunction).not.toHaveBeenCalled()
  })

  it('returns 401 when authorization header is malformed', () => {
    mockRequest.headers = { authorization: 'invalid-format' }
    const middleware = requireJwtAuth(authService)
    middleware(mockRequest as Request, mockResponse as Response, nextFunction)

    expect(mockResponse.status).toHaveBeenCalledWith(401)
    expect(mockResponse.json).toHaveBeenCalledWith({
      error: 'Unauthorized',
      message: 'Authorization header must be in the format: Bearer <token>',
    })
    expect(nextFunction).not.toHaveBeenCalled()
  })

  it('returns 401 when token is invalid', () => {
    mockRequest.headers = { authorization: 'Bearer not-a-jwt' }
    const middleware = requireJwtAuth(authService)
    middleware(mockRequest as Request, mockResponse as Response, nextFunction)

    expect(mockResponse.status).toHaveBeenCalledWith(401)
    expect(nextFunction).not.toHaveBeenCalled()
  })

  it('accepts a valid access token and attaches claims', () => {
    const tokens = authService.issueTokenPair('user-123')
    mockRequest.headers = { authorization: `Bearer ${tokens.accessToken}` }
    const middleware = requireJwtAuth(authService)

    middleware(mockRequest as Request, mockResponse as Response, nextFunction)

    expect(nextFunction).toHaveBeenCalled()
    const authReq = mockRequest as AuthenticatedRequest
    expect(authReq.auth?.sub).toBe('user-123')
    expect(authReq.auth?.iss).toBe('credence-test')
    expect(authReq.auth?.type).toBe('access')
  })
})
