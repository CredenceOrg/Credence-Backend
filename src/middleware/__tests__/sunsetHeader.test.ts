import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Request, Response, NextFunction } from 'express'
import { DEPRECATED_ENDPOINTS, sunsetHeaderMiddleware } from '../sunsetHeader.js'
import { HEADER_SUNSET } from '../../config/constants.js'

describe('sunsetHeaderMiddleware', () => {
  let req: Partial<Request>
  let res: Partial<Response>
  let next: ReturnType<typeof vi.fn>
  let setHeaderMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setHeaderMock = vi.fn()
    req = { path: '' }
    res = {
      setHeader: setHeaderMock,
    }
    next = vi.fn()
  })

  it('adds_Sunset_header_for_deprecated_endpoint', () => {
    req.path = '/api/admin/refresh-secrets'
    const expectedSunset = DEPRECATED_ENDPOINTS['/api/admin/refresh-secrets']

    sunsetHeaderMiddleware(req as Request, res as Response, next as NextFunction)

    expect(setHeaderMock).toHaveBeenCalledWith(HEADER_SUNSET, expectedSunset)
    expect(next).toHaveBeenCalled()
  })

  it('does_not_add_Sunset_header_for_active_endpoint', () => {
    req.path = '/api/admin/users'

    sunsetHeaderMiddleware(req as Request, res as Response, next as NextFunction)

    expect(setHeaderMock).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalled()
  })

  it('does_not_add_Sunset_header_for_health_endpoints', () => {
    req.path = '/api/health'

    sunsetHeaderMiddleware(req as Request, res as Response, next as NextFunction)

    expect(setHeaderMock).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalled()
  })

  it('handles_unknown_path_gracefully', () => {
    req.path = '/api/nonexistent'

    sunsetHeaderMiddleware(req as Request, res as Response, next as NextFunction)

    expect(setHeaderMock).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalled()
  })

  it('adds_Sunset_header_with_valid_RFC_8594_date_format', () => {
    req.path = '/api/admin/refresh-secrets'
    const expectedSunset = DEPRECATED_ENDPOINTS['/api/admin/refresh-secrets']

    sunsetHeaderMiddleware(req as Request, res as Response, next as NextFunction)

    expect(setHeaderMock).toHaveBeenCalledWith(HEADER_SUNSET, expectedSunset)
    // Verify it's a valid ISO 8601 date
    const parsed = new Date(expectedSunset)
    expect(parsed.getTime()).not.toBeNaN()
  })

  it('DEPRECATED_ENDPOINTS_contains_expected_endpoints', () => {
    expect(DEPRECATED_ENDPOINTS).toHaveProperty('/api/admin/refresh-secrets')
  })

  it('applies_middleware_idempotently', () => {
    req.path = '/api/admin/refresh-secrets'

    // Call middleware twice
    sunsetHeaderMiddleware(req as Request, res as Response, next as NextFunction)
    sunsetHeaderMiddleware(req as Request, res as Response, next as NextFunction)

    // setHeader should be called each time the middleware runs
    expect(setHeaderMock).toHaveBeenCalledTimes(2)
    expect(next).toHaveBeenCalledTimes(2)
  })
})
