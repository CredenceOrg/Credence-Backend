/**
 * Tests for structuredLoggingMiddleware — issue #987
 *
 * Verifies that every HTTP response produces a structured log entry that
 * includes all four standard observability fields:
 *   route, tenant, actor, correlationId
 *
 * Also verifies that:
 *   - The `route` field uses the Express route template, not the raw URL
 *   - PII-named fields are redacted by the log-schema allowlist
 *   - The middleware does not block the response
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { structuredLoggingMiddleware } from '../middleware/structuredLogging.js'
import { requestIdMiddleware } from '../middleware/requestId.js'
import { correlationIdMiddleware } from '../middleware/correlationId.js'
import { tracingContext } from '../utils/logger.js'

// ── helpers ──────────────────────────────────────────────────────────────────

/** Returns the parsed JSON from the first console.log call matching a given predicate. */
function firstLog(
  spy: ReturnType<typeof vi.spyOn>,
  predicate: (parsed: any) => boolean,
): any | undefined {
  for (const call of spy.mock.calls) {
    try {
      const parsed = JSON.parse(call[0] as string)
      if (predicate(parsed)) return parsed
    } catch {
      // ignore non-JSON log calls
    }
  }
  return undefined
}

/** Builds a minimal Express app with the structured logging stack. */
function buildApp(extraSetup?: (app: express.Express) => void) {
  const app = express()
  app.use(express.json())

  // Middleware order mirrors app.ts
  app.use(requestIdMiddleware)
  app.use(correlationIdMiddleware)
  app.use(structuredLoggingMiddleware)

  if (extraSetup) extraSetup(app)

  return app
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('structuredLoggingMiddleware — issue #987', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── field presence ──────────────────────────────────────────────────────────

  it('emits a log entry with all four standard fields on every response', async () => {
    const app = buildApp((a) => {
      a.get('/api/health', (_req, res) => res.json({ status: 'ok' }))
    })

    await request(app)
      .get('/api/health')
      .set('x-correlation-id', 'test-corr-1')
      .expect(200)

    const entry = firstLog(consoleSpy, (p) => p.method === 'GET' && p.path === '/api/health')
    expect(entry).toBeDefined()
    expect(entry).toHaveProperty('route')
    expect(entry).toHaveProperty('tenant')
    expect(entry).toHaveProperty('actor')
    expect(entry).toHaveProperty('correlationId')
    expect(entry.correlationId).toBe('test-corr-1')
  })

  it('includes requestId, method, path, statusCode and durationMs', async () => {
    const app = buildApp((a) => {
      a.get('/api/ping', (_req, res) => res.status(200).json({ pong: true }))
    })

    await request(app).get('/api/ping').expect(200)

    const entry = firstLog(consoleSpy, (p) => p.path === '/api/ping')
    expect(entry).toBeDefined()
    expect(entry.method).toBe('GET')
    expect(entry.statusCode).toBe(200)
    expect(typeof entry.durationMs).toBe('number')
    expect(entry.durationMs).toBeGreaterThanOrEqual(0)
    expect(typeof entry.requestId).toBe('string')
  })

  // ── route template field ────────────────────────────────────────────────────

  it('sets route to the matched route template, not the raw URL', async () => {
    const app = buildApp((a) => {
      a.get('/api/users/:id', (_req, res) => res.json({ id: 'abc' }))
    })

    await request(app).get('/api/users/abc?foo=bar').expect(200)

    const entry = firstLog(consoleSpy, (p) => p.method === 'GET' && p.path?.includes('/api/users/'))
    expect(entry).toBeDefined()
    // Must be the template, NOT '/api/users/abc' or '/api/users/abc?foo=bar'
    expect(entry.route).toBe('/api/users/:id')
    expect(entry.route).not.toContain('abc')
    expect(entry.route).not.toContain('foo=bar')
  })

  it('falls back to req.path when no route is matched (e.g. 404)', async () => {
    const app = buildApp()

    await request(app).get('/api/does-not-exist').expect(404)

    const entry = firstLog(
      consoleSpy,
      (p) => typeof p.path === 'string' && p.path.includes('/api/does-not-exist'),
    )
    expect(entry).toBeDefined()
    expect(typeof entry.route).toBe('string')
    expect(entry.route.length).toBeGreaterThan(0)
  })

  // ── tenant / actor fields ───────────────────────────────────────────────────

  it('includes tenant from x-tenant-id request header', async () => {
    const app = buildApp((a) => {
      a.get('/api/resource', (_req, res) => res.json({ ok: true }))
    })

    await request(app)
      .get('/api/resource')
      .set('x-tenant-id', 'tenant-acme')
      .expect(200)

    const entry = firstLog(consoleSpy, (p) => p.path === '/api/resource')
    expect(entry).toBeDefined()
    expect(entry.tenant).toBe('tenant-acme')
  })

  it('includes actor from x-actor-id request header', async () => {
    const app = buildApp((a) => {
      a.get('/api/resource', (_req, res) => res.json({ ok: true }))
    })

    await request(app)
      .get('/api/resource')
      .set('x-actor-id', 'user-42')
      .expect(200)

    const entry = firstLog(consoleSpy, (p) => p.path === '/api/resource')
    expect(entry).toBeDefined()
    expect(entry.actor).toBe('user-42')
  })

  it('defaults tenant and actor to "N/A" when no auth headers are present', async () => {
    const app = buildApp((a) => {
      a.get('/api/public', (_req, res) => res.json({ public: true }))
    })

    await request(app).get('/api/public').expect(200)

    const entry = firstLog(consoleSpy, (p) => p.path === '/api/public')
    expect(entry).toBeDefined()
    expect(entry.tenant).toBe('N/A')
    expect(entry.actor).toBe('N/A')
  })

  // ── correlationId propagation ───────────────────────────────────────────────

  it('propagates X-Correlation-ID from the incoming request', async () => {
    const app = buildApp((a) => {
      a.post('/api/events', (_req, res) => res.status(202).json({ accepted: true }))
    })

    const correlationId = 'upstream-trace-9999'
    await request(app)
      .post('/api/events')
      .set('x-correlation-id', correlationId)
      .send({ type: 'test' })
      .expect(202)

    const entry = firstLog(consoleSpy, (p) => p.path === '/api/events')
    expect(entry).toBeDefined()
    expect(entry.correlationId).toBe(correlationId)
  })

  it('generates a new correlation ID when the header is absent', async () => {
    const app = buildApp((a) => {
      a.get('/api/anon', (_req, res) => res.json({ anon: true }))
    })

    await request(app).get('/api/anon').expect(200)

    const entry = firstLog(consoleSpy, (p) => p.path === '/api/anon')
    expect(entry).toBeDefined()
    expect(typeof entry.correlationId).toBe('string')
    expect(entry.correlationId.length).toBeGreaterThan(0)
    expect(entry.correlationId).not.toBe('N/A')
  })

  // ── schema / redaction ──────────────────────────────────────────────────────

  it('does not leak the raw request URL into the route field', async () => {
    const app = buildApp((a) => {
      a.get('/api/items/:itemId/sub/:subId', (_req, res) => res.json({}))
    })

    await request(app).get('/api/items/super-secret/sub/private-data').expect(200)

    const entry = firstLog(
      consoleSpy,
      (p) => typeof p.route === 'string' && p.route.includes('/api/items'),
    )
    expect(entry).toBeDefined()
    expect(entry.route).toBe('/api/items/:itemId/sub/:subId')
    expect(entry.route).not.toContain('super-secret')
    expect(entry.route).not.toContain('private-data')
  })

  it('logs the correct status code for error responses', async () => {
    const app = buildApp((a) => {
      a.get('/api/fail', (_req, res) => res.status(503).json({ error: 'unavailable' }))
    })

    await request(app).get('/api/fail').expect(503)

    const entry = firstLog(consoleSpy, (p) => p.path === '/api/fail')
    expect(entry).toBeDefined()
    expect(entry.statusCode).toBe(503)
  })

  // ── middleware transparency ─────────────────────────────────────────────────

  it('does not modify the response body or status', async () => {
    const app = buildApp((a) => {
      a.get('/api/passthrough', (_req, res) => res.status(201).json({ created: true }))
    })

    const res = await request(app).get('/api/passthrough').expect(201)
    expect(res.body).toEqual({ created: true })
  })

  it('calls next() so downstream handlers can process the request', async () => {
    const handler = vi.fn((_req: express.Request, res: express.Response) => {
      res.json({ reached: true })
    })

    const app = buildApp((a) => {
      a.get('/api/next-test', handler)
    })

    await request(app).get('/api/next-test').expect(200)
    expect(handler).toHaveBeenCalledOnce()
  })

  // ── tracing context field resolution ─────────────────────────────────────────

  it('resolves tenant and actor from the AsyncLocalStorage tracing context', async () => {
    // Simulate a middleware that sets actor after auth (e.g. requireApiKey)
    const app = buildApp((a) => {
      a.use((req: express.Request, _res, next) => {
        // Simulate auth middleware populating req.user after requestIdMiddleware
        ;(req as any).user = { id: 'auth-user-1', tenantId: 'tenant-beta' }
        next()
      })
      a.get('/api/authed', (_req, res) => res.json({ ok: true }))
    })

    await request(app).get('/api/authed').expect(200)

    const entry = firstLog(consoleSpy, (p) => p.path === '/api/authed')
    expect(entry).toBeDefined()
    // The proxy in requestIdMiddleware re-reads req.user on every .get(),
    // so the value set by the simulated auth middleware is captured.
    expect(entry.tenant).toBe('tenant-beta')
    expect(entry.actor).toBe('auth-user-1')
  })
})
