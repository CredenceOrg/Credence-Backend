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
