import { describe, it, expect, beforeEach } from 'vitest'
import express, { type Express, type Request, type Response, type NextFunction } from 'express'
import request from 'supertest'
import { requestIdMiddleware } from '../requestId.js'
import { tracingContext } from '../../utils/logger.js'

/**
 * Trace-id propagation tests using supertest.
 *
 * Assert the x-trace-id header stays consistent through nested calls.
 * Covers:
 *  - Happy path: provided x-trace-id propagates to response and inner handlers.
 *  - Sad path:   missing or empty x-trace-id falls back to auto-generation.
 */
describe('Trace ID propagation', () => {
  let app: Express

  beforeEach(() => {
    app = express()
    app.use(requestIdMiddleware)
  })

  // ── Happy path ──────────────────────────────────────────────────────

  it('returns_same_x_trace_id_when_provided_in_request_header', async () => {
    const traceId = '00000000-0000-0000-0000-000000000001'

    app.get('/test', (_req: Request, res: Response) => {
      res.json({ ok: true })
    })

    const response = await request(app)
      .get('/test')
      .set('x-trace-id', traceId)

    expect(response.status).toBe(200)
    expect(response.headers['x-trace-id']).toBe(traceId)
  })

  it('keeps_trace_id_consistent_through_nested_middleware_chain', async () => {
    const traceId = '00000000-0000-0000-0000-000000000002'
    const capturedTraceIds: (string | undefined)[] = []

    // Middleware layer 1
    app.use((_req: Request, _res: Response, next: NextFunction) => {
      capturedTraceIds.push(tracingContext.getStore()?.get('traceId'))
      next()
    })

    // Route handler (nested call within the app)
    app.get('/nested', (req: Request, res: Response) => {
      capturedTraceIds.push(tracingContext.getStore()?.get('traceId'))
      // Verify the middleware-attached property matches the context
      capturedTraceIds.push(req.traceId)
      res.json({ ok: true })
    })

    const response = await request(app)
      .get('/nested')
      .set('x-trace-id', traceId)

    expect(response.status).toBe(200)
    // Response header must echo back the same trace-id
    expect(response.headers['x-trace-id']).toBe(traceId)
    // Every layer in the chain saw the identical trace-id
    expect(capturedTraceIds).toHaveLength(3)
    for (const captured of capturedTraceIds) {
      expect(captured).toBe(traceId)
    }
  })

  it('propagates_trace_id_across_sequential_requests_on_the_same_app', async () => {
    // Each request may carry a different trace-id; the test verifies that
    // within a single request/response cycle the trace-id is consistent.
    const firstTraceId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    const secondTraceId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

    app.get('/echo', (req: Request, res: Response) => {
      const store = tracingContext.getStore()
      res.json({
        fromContext: store?.get('traceId'),
        fromHeader: req.header('x-trace-id'),
      })
    })

    const first = await request(app)
      .get('/echo')
      .set('x-trace-id', firstTraceId)

    const second = await request(app)
      .get('/echo')
      .set('x-trace-id', secondTraceId)

    expect(first.status).toBe(200)
    expect(first.headers['x-trace-id']).toBe(firstTraceId)
    expect(first.body.fromContext).toBe(firstTraceId)
    expect(first.body.fromHeader).toBe(firstTraceId)

    expect(second.status).toBe(200)
    expect(second.headers['x-trace-id']).toBe(secondTraceId)
    expect(second.body.fromContext).toBe(secondTraceId)
    expect(second.body.fromHeader).toBe(secondTraceId)
  })

  // ── Sad path ────────────────────────────────────────────────────────

  it('generates_new_trace_id_when_header_is_missing', async () => {
    app.get('/test', (_req: Request, res: Response) => {
      res.json({ ok: true })
    })

    const response = await request(app).get('/test')

    expect(response.status).toBe(200)
    expect(response.headers['x-trace-id']).toBeDefined()
    const traceId = response.headers['x-trace-id']
    expect(traceId).toBeTruthy()
    expect(typeof traceId).toBe('string')
    // Must be a valid UUID v4
    expect(traceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
  })

  it('generates_new_trace_id_when_header_is_empty_string', async () => {
    app.get('/test', (_req: Request, res: Response) => {
      res.json({ ok: true })
    })

    const response = await request(app)
      .get('/test')
      .set('x-trace-id', '')

    expect(response.status).toBe(200)
    const traceId = response.headers['x-trace-id']
    expect(traceId).toBeTruthy()
    expect(typeof traceId).toBe('string')
    // An empty string is falsy, so the middleware must generate a new UUID
    expect(traceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
  })

  it('trace_id_is_available_in_tracingContext_for_downstream_handlers', async () => {
    const traceId = 'deadbeef-dead-beef-dead-beefdeadbeef'

    app.get('/context', (_req: Request, res: Response) => {
      const store = tracingContext.getStore()
      res.json({
        traceId: store?.get('traceId'),
        requestId: store?.get('requestId'),
        correlationId: store?.get('correlationId'),
      })
    })

    const response = await request(app)
      .get('/context')
      .set('x-trace-id', traceId)

    expect(response.status).toBe(200)
    expect(response.body.traceId).toBe(traceId)
    // Sanity: other context fields are also populated
    expect(response.body.requestId).toBeTruthy()
    expect(response.body.correlationId).toBeTruthy()
  })
})
