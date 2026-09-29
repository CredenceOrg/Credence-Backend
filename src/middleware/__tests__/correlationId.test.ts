import { describe, it, expect, beforeEach } from 'vitest'
import express, { type Express, type Request, type Response, type NextFunction } from 'express'
import request from 'supertest'
import { correlationIdMiddleware } from '../correlationId.js'
import { HEADER_CORRELATION_ID } from '../../config/constants.js'

describe('correlationIdMiddleware', () => {
  let app: Express

  beforeEach(() => {
    app = express()
    app.use(correlationIdMiddleware)
  })

  // ── Happy path ──────────────────────────────────────────────────────

  it('propagates_existing_correlation_id_from_request_header', async () => {
    const cid = 'aaaa-bbbb-cccc-dddd'

    app.get('/test', (_req: Request, res: Response) => {
      res.json({ correlationId: _req['correlationId'] })
    })

    const res = await request(app)
      .get('/test')
      .set(HEADER_CORRELATION_ID, cid)

    expect(res.status).toBe(200)
    expect(res.headers[HEADER_CORRELATION_ID]).toBe(cid)
    expect(res.body.correlationId).toBe(cid)
  })

  it('generates_uuid_v4_when_header_is_missing', async () => {
    app.get('/test', (_req: Request, res: Response) => {
      res.json({ correlationId: _req['correlationId'] })
    })

    const res = await request(app).get('/test')

    expect(res.status).toBe(200)
    const cid = res.headers[HEADER_CORRELATION_ID] as string
    expect(cid).toBeTruthy()
    expect(cid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
    expect(res.body.correlationId).toBe(cid)
  })

  it('generates_uuid_v4_when_header_is_empty_string', async () => {
    app.get('/test', (_req: Request, res: Response) => {
      res.json({ correlationId: _req['correlationId'] })
    })

    const res = await request(app)
      .get('/test')
      .set(HEADER_CORRELATION_ID, '')

    expect(res.status).toBe(200)
    const cid = res.headers[HEADER_CORRELATION_ID] as string
    expect(cid).toBeTruthy()
    expect(cid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
  })

  it('correlation_id_is_consistent_across_middleware_chain', async () => {
    const cid = 'test-corr-id-1234'
    const seen: (string | undefined)[] = []

    app.use((_req: Request, _res: Response, next: NextFunction) => {
      seen.push(_req['correlationId'] as string)
      next()
    })

    app.get('/nested', (req: Request, res: Response) => {
      seen.push(req['correlationId'] as string)
      res.json({ ok: true })
    })

    const res = await request(app)
      .get('/nested')
      .set(HEADER_CORRELATION_ID, cid)

    expect(res.status).toBe(200)
    expect(res.headers[HEADER_CORRELATION_ID]).toBe(cid)
    expect(seen).toHaveLength(2)
    for (const id of seen) {
      expect(id).toBe(cid)
    }
  })

  it('propagates_correlation_id_across_sequential_requests', async () => {
    app.get('/echo', (req: Request, res: Response) => {
      res.json({ correlationId: req['correlationId'] })
    })

    const first = await request(app)
      .get('/echo')
      .set(HEADER_CORRELATION_ID, 'id-one')

    const second = await request(app)
      .get('/echo')
      .set(HEADER_CORRELATION_ID, 'id-two')

    expect(first.body.correlationId).toBe('id-one')
    expect(second.body.correlationId).toBe('id-two')
    expect(first.headers[HEADER_CORRELATION_ID]).toBe('id-one')
    expect(second.headers[HEADER_CORRELATION_ID]).toBe('id-two')
  })

  // ── Sad path / edge cases ──────────────────────────────────────────

  it('does_not_override_correlation_id_when_set_by_earlier_middleware', async () => {
    const cid = 'pre-set-id'

    // Create a fresh app with the pre-set middleware BEFORE correlationIdMiddleware
    app = express()
    // Simulate an earlier middleware setting the value
    app.use((_req: Request, _res: Response, next: NextFunction) => {
      _req['correlationId'] = cid
      next()
    })
    app.use(correlationIdMiddleware)

    app.get('/test', (req: Request, res: Response) => {
      res.json({ correlationId: req['correlationId'] })
    })

    const res = await request(app).get('/test')

    expect(res.status).toBe(200)
    // The middleware should not overwrite a pre-set correlation ID
    expect(res.body.correlationId).toBe(cid)
    expect(res.headers[HEADER_CORRELATION_ID]).toBe(cid)
  })

  it('sets_correlation_id_on_response_even_for_non_success_routes', async () => {
    app.get('/not-found', (_req: Request, res: Response) => {
      res.status(404).json({ error: 'not found' })
    })

    const res = await request(app).get('/not-found')

    expect(res.status).toBe(404)
    expect(res.headers[HEADER_CORRELATION_ID]).toBeTruthy()
  })
})
