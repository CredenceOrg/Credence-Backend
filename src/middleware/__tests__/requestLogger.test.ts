import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express, { type Express, type Request, type Response, type NextFunction } from 'express'
import request from 'supertest'
import { requestIdMiddleware } from '../requestId.js'

describe('Request-scoped logger (req.log)', () => {
  let app: Express

  beforeEach(() => {
    app = express()
    app.use(requestIdMiddleware)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('attaches req.log to the request and logs with request metadata', async () => {
    const correlationId = 'test-corr-123'
    const requestId = 'test-req-456'

    app.get('/test-log', (req: Request, res: Response) => {
      expect(req.log).toBeDefined()
      req.log.info('hello from handler')
      res.json({ ok: true })
    })

    const response = await request(app)
      .get('/test-log')
      .set('x-correlation-id', correlationId)
      .set('x-request-id', requestId)

    expect(response.status).toBe(200)
    expect(console.log).toHaveBeenCalledTimes(1)

    const callArgs = JSON.parse((console.log as any).mock.calls[0][0])
    expect(callArgs.level).toBe('INFO')
    expect(callArgs.requestId).toBe(requestId)
    expect(callArgs.correlationId).toBe(correlationId)
    expect(callArgs.message).toBe('hello from handler')
    expect(callArgs.route).toBe('/test-log')
  })

  it('reflects dynamically updated tenant and actor details from headers or req.user', async () => {
    // 1. First test: populated via headers directly
    app.get('/dynamic-headers', (req: Request, res: Response) => {
      req.log.info('headers log')
      res.json({ ok: true })
    })

    // 2. Second test: updated by a downstream middleware setting req.user
    app.get(
      '/dynamic-user',
      (req: Request, _res: Response, next: NextFunction) => {
        // simulate auth middleware setting user
        ;(req as any).user = {
          id: 'user-actor-888',
          tenantId: 'tenant-999',
        }
        next()
      },
      (req: Request, res: Response) => {
        req.log.info('user log')
        res.json({ ok: true })
      }
    )

    // Call /dynamic-headers
    const resHeaders = await request(app)
      .get('/dynamic-headers')
      .set('x-tenant-id', 'tenant-t1')
      .set('x-actor-id', 'actor-a1')
    expect(resHeaders.status).toBe(200)

    const callArgs1 = JSON.parse((console.log as any).mock.calls[0][0])
    expect(callArgs1.tenant).toBe('tenant-t1')
    expect(callArgs1.actor).toBe('actor-a1')

    // Call /dynamic-user
    const resUser = await request(app).get('/dynamic-user')
    expect(resUser.status).toBe(200)

    const callArgs2 = JSON.parse((console.log as any).mock.calls[1][0])
    expect(callArgs2.tenant).toBe('tenant-999')
    expect(callArgs2.actor).toBe('user-actor-888')
  })

  it('retains correct request context even when invoked outside async local storage (e.g. deferred callbacks)', async () => {
    let capturedReq: Request | null = null

    app.get('/defer', (req: Request, res: Response) => {
      capturedReq = req
      res.json({ ok: true })
    })

    await request(app)
      .get('/defer')
      .set('x-request-id', 'deferred-req-id-789')

    expect(capturedReq).toBeDefined()
    
    // We execute the logging check OUTSIDE the request request-lifecycle
    // when AsyncLocalStorage has already finished and is empty
    capturedReq!.log.warn('deferred warning log')

    expect(console.warn).toHaveBeenCalledTimes(1)
    const callArgs = JSON.parse((console.warn as any).mock.calls[0][0])
    expect(callArgs.level).toBe('WARN')
    expect(callArgs.requestId).toBe('deferred-req-id-789')
    expect(callArgs.message).toBe('deferred warning log')
  })
})
