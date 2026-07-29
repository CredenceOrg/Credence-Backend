import { describe, it, expect, vi } from 'vitest'
import { requestIdMiddleware } from '../middleware/requestId.js'
import { createRequestIdInterceptor } from '../sdk/grpc/interceptors.js'
import { tracingContext } from '../utils/logger.js'
import { Request, Response } from 'express'

describe('Request ID propagation', () => {
  it('should generate a new request ID if x-request-id is not provided in headers', () => {
    const req = {
      header: vi.fn().mockReturnValue(null),
      originalUrl: '/test',
      path: '/test',
    } as unknown as Request

    const res = {
      setHeader: vi.fn(),
    } as unknown as Response

    const next = vi.fn().mockImplementation(() => {
      const store = tracingContext.getStore()
      expect(store).toBeDefined()
      expect(store?.get('requestId')).toBeDefined()
      expect(typeof store?.get('requestId')).toBe('string')
      expect(store?.get('correlationId')).toBeDefined()
    })

    requestIdMiddleware(req, res, next)
    expect(next).toHaveBeenCalled()
    expect(res.setHeader).toHaveBeenCalledWith('x-request-id', expect.any(String))
  })

  it('should reuse x-request-id from headers if provided', () => {
    const customRequestId = 'test-request-id-12345'
    const req = {
      header: vi.fn((name: string) => {
        if (name === 'x-request-id') return customRequestId
        return null
      }),
      originalUrl: '/test',
      path: '/test',
    } as unknown as Request

    const res = {
      setHeader: vi.fn(),
    } as unknown as Response

    const next = vi.fn().mockImplementation(() => {
      const store = tracingContext.getStore()
      expect(store?.get('requestId')).toBe(customRequestId)
    })

    requestIdMiddleware(req, res, next)
    expect(next).toHaveBeenCalled()
    expect(res.setHeader).toHaveBeenCalledWith('x-request-id', customRequestId)
  })

  it('should propagate x-request-id to gRPC calls via interceptor using context store', () => {
    const customRequestId = 'grpc-test-request-id'
    const context = new Map<string, string>()
    context.set('requestId', customRequestId)

    tracingContext.run(context, () => {
      const interceptor = createRequestIdInterceptor()
      const next = vi.fn((req) => req)
      const req = {
        header: {
          set: vi.fn(),
        },
      } as any

      interceptor(next)(req)
      expect(req.header.set).toHaveBeenCalledWith('x-request-id', customRequestId)
    })
  })

  it('should propagate explicit request ID parameter in gRPC interceptor', () => {
    const customRequestId = 'explicit-grpc-id'
    const interceptor = createRequestIdInterceptor(customRequestId)
    const next = vi.fn((req) => req)
    const req = {
      header: {
        set: vi.fn(),
      },
    } as any

    interceptor(next)(req)
    expect(req.header.set).toHaveBeenCalledWith('x-request-id', customRequestId)
  })
})

// ── Issue #987: route template resolution ────────────────────────────────────

describe('requestIdMiddleware — route template in tracing context', () => {
  it('sets route in context to req.path when no route is matched yet', () => {
    const req = {
      header: vi.fn().mockReturnValue(null),
      originalUrl: '/api/trust/0xabc?foo=1',
      path: '/api/trust/0xabc',
      route: undefined,
    } as unknown as Request

    const res = { setHeader: vi.fn() } as unknown as Response

    const next = vi.fn().mockImplementation(() => {
      const store = tracingContext.getStore()
      // Without a matched route, falls back to req.path (not originalUrl)
      const route = store?.get('route')
      expect(route).toBe('/api/trust/0xabc')
      // Should not include the query string
      expect(route).not.toContain('foo=1')
    })

    requestIdMiddleware(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('resolves route to the Express route template via the proxy', () => {
    const req = {
      header: vi.fn().mockReturnValue(null),
      originalUrl: '/api/trust/0xdeadbeef',
      path: '/api/trust/0xdeadbeef',
      // Simulate Express populating req.route after matching
      route: { path: '/api/trust/:address' },
    } as unknown as Request

    const res = { setHeader: vi.fn() } as unknown as Response

    const next = vi.fn().mockImplementation(() => {
      const store = tracingContext.getStore()
      // The proxy should return the matched route template
      const route = store?.get('route')
      expect(route).toBe('/api/trust/:address')
      expect(route).not.toContain('0xdeadbeef')
    })

    requestIdMiddleware(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('includes tenant and actor from x-tenant-id and x-actor-id headers', () => {
    const req = {
      header: vi.fn((name: string) => {
        if (name === 'x-tenant-id') return 'tenant-abc'
        if (name === 'x-actor-id') return 'actor-xyz'
        return null
      }),
      originalUrl: '/api/resource',
      path: '/api/resource',
    } as unknown as Request

    const res = { setHeader: vi.fn() } as unknown as Response

    const next = vi.fn().mockImplementation(() => {
      const store = tracingContext.getStore()
      expect(store?.get('tenant')).toBe('tenant-abc')
      expect(store?.get('actor')).toBe('actor-xyz')
    })

    requestIdMiddleware(req, res, next)
    expect(next).toHaveBeenCalled()
  })
})
