import { describe, it, expect } from 'vitest'
import express, { type Request, type Response } from 'express'
import request from 'supertest'
import {
  createMaintenanceModeMiddleware,
  MAINTENANCE_RETRY_AFTER_SECONDS,
} from '../maintenanceMode.js'

// ── Test helpers ──────────────────────────────────────────────────────────────

function buildApp(isEnabled: boolean | (() => boolean)) {
  const app = express()

  app.use(createMaintenanceModeMiddleware(isEnabled))

  // Register a handler for every common HTTP method at /api/resource
  for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const) {
    ;(app as express.Express)[method]('/api/resource', (_req: Request, res: Response) => {
      res.status(200).json({ ok: true })
    })
  }

  return app
}

// ── MAINTENANCE_RETRY_AFTER_SECONDS constant ───────────────────────────────────

describe('MAINTENANCE_RETRY_AFTER_SECONDS', () => {
  it('equals 60', () => {
    expect(MAINTENANCE_RETRY_AFTER_SECONDS).toBe(60)
  })
})

// ── createMaintenanceModeMiddleware ────────────────────────────────────────────

describe('createMaintenanceModeMiddleware — disabled (false)', () => {
  const app = buildApp(false)

  it('passes GET requests through', async () => {
    const res = await request(app).get('/api/resource')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('passes POST requests through', async () => {
    const res = await request(app).post('/api/resource')
    expect(res.status).toBe(200)
  })

  it('passes PUT requests through', async () => {
    const res = await request(app).put('/api/resource')
    expect(res.status).toBe(200)
  })

  it('passes PATCH requests through', async () => {
    const res = await request(app).patch('/api/resource')
    expect(res.status).toBe(200)
  })

  it('passes DELETE requests through', async () => {
    const res = await request(app).delete('/api/resource')
    expect(res.status).toBe(200)
  })
})

describe('createMaintenanceModeMiddleware — enabled (true)', () => {
  const app = buildApp(true)

  // ── Write methods blocked ─────────────────────────────────────────────────

  it.each(['post', 'put', 'patch', 'delete'] as const)(
    'returns 503 for %s requests',
    async (method) => {
      const res = await (request(app) as Record<string, CallableFunction>)[method]('/api/resource')
      expect(res.status).toBe(503)
    },
  )

  it('returns Retry-After: 60 header for write requests', async () => {
    const res = await request(app).post('/api/resource')
    expect(res.headers['retry-after']).toBe('60')
  })

  it('returns the correct JSON error body for write requests', async () => {
    const res = await request(app).post('/api/resource')
    expect(res.body).toEqual({
      error: 'Service Unavailable',
      message: 'The service is currently undergoing maintenance. Please retry later.',
      retryAfter: 60,
    })
  })

  // ── Read methods pass through ─────────────────────────────────────────────

  it('passes GET requests through when in maintenance mode', async () => {
    const res = await request(app).get('/api/resource')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('passes HEAD requests through when in maintenance mode', async () => {
    const res = await request(app).head('/api/resource')
    expect(res.status).toBe(200)
  })

  it('passes OPTIONS requests through when in maintenance mode', async () => {
    const res = await request(app).options('/api/resource')
    expect(res.status).toBe(200)
  })

  // ── retryAfter matches constant ───────────────────────────────────────────

  it('retryAfter in body matches MAINTENANCE_RETRY_AFTER_SECONDS constant', async () => {
    const res = await request(app).post('/api/resource')
    expect(res.body.retryAfter).toBe(MAINTENANCE_RETRY_AFTER_SECONDS)
  })

  it('Retry-After header matches MAINTENANCE_RETRY_AFTER_SECONDS constant', async () => {
    const res = await request(app).post('/api/resource')
    expect(Number(res.headers['retry-after'])).toBe(MAINTENANCE_RETRY_AFTER_SECONDS)
  })
})

// ── Getter function (live flag) ───────────────────────────────────────────────

describe('createMaintenanceModeMiddleware — getter function', () => {
  it('uses the current value of the getter at request time', async () => {
    let flag = false
    const app = buildApp(() => flag)

    // With flag = false, writes should pass through
    let res = await request(app).post('/api/resource')
    expect(res.status).toBe(200)

    // Flip the flag — writes should now be blocked
    flag = true
    res = await request(app).post('/api/resource')
    expect(res.status).toBe(503)

    // Flip back — writes should pass through again
    flag = false
    res = await request(app).post('/api/resource')
    expect(res.status).toBe(200)
  })

  it('does not block reads when getter returns true', async () => {
    const app = buildApp(() => true)
    const res = await request(app).get('/api/resource')
    expect(res.status).toBe(200)
  })
})

// ── Case-insensitivity of method check ────────────────────────────────────────

describe('createMaintenanceModeMiddleware — method case handling', () => {
  it('blocks requests regardless of method case', async () => {
    // Express normalises method to uppercase, but test the middleware's
    // toUpperCase() call explicitly by simulating a lowercase method via
    // a raw request object.
    const middleware = createMaintenanceModeMiddleware(true)

    let statusSet = 0
    let jsonBody: unknown = null

    const fakeReq = { method: 'post' } as Request
    const fakeRes = {
      setHeader: () => undefined,
      status(code: number) { statusSet = code; return this },
      json(body: unknown) { jsonBody = body },
    } as unknown as Response
    const next = () => { statusSet = 999 }

    middleware(fakeReq, fakeRes, next)

    expect(statusSet).toBe(503)
    expect((jsonBody as Record<string, unknown>).retryAfter).toBe(60)
  })
})

// ── Does not set Retry-After on non-blocked requests ─────────────────────────

describe('createMaintenanceModeMiddleware — no Retry-After on allowed requests', () => {
  it('does not set Retry-After header on GET when maintenance mode is enabled', async () => {
    const app = buildApp(true)
    const res = await request(app).get('/api/resource')
    expect(res.headers['retry-after']).toBeUndefined()
  })

  it('does not set Retry-After header on POST when maintenance mode is disabled', async () => {
    const app = buildApp(false)
    const res = await request(app).post('/api/resource')
    expect(res.headers['retry-after']).toBeUndefined()
  })
})
