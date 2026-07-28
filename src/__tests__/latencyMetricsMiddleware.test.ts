/**
 * Integration tests for per-endpoint latency metrics with safe tag cardinality.
 *
 * Covers:
 * - Histogram label correctness (method, route, status_class)
 * - Sub-router mount-prefix-aware route extraction (baseUrl + route.path)
 * - Status class bucketing for 2xx / 4xx / 5xx responses
 * - SLO bucket fence-post accuracy for p50 / p95 / p99 queries
 * - Cardinality overflow guard (_overflow sentinel)
 * - High-resolution timer (hrtime) — duration is positive and plausible
 * - Multiple HTTP methods tracked independently
 *
 * @see src/observability/latencyMetrics.ts  — implementation
 * @see src/middleware/metrics.ts            — metricsMiddleware
 * @see docs/sla-metrics.md                 — cardinality policy
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express, { Request, Response, Router } from 'express'
import request from 'supertest'
import client from 'prom-client'

import {
  httpRequestDurationHistogram,
  httpRequestStatusTotal,
  MAX_ROUTE_CARDINALITY,
  OVERFLOW_ROUTE_LABEL,
  _resetSeenRoutes,
} from '../observability/latencyMetrics.js'
import { metricsMiddleware } from '../middleware/metrics.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * prom-client encodes histogram buckets with a string `le` label.
 * The +Inf bucket uses the string "+Inf".
 * We compare against string keys here to match actual label encoding.
 */
async function bucketCount(
  le: number | '+Inf',
  labels: { method: string; route: string; status_class: string },
): Promise<number> {
  const metrics = await httpRequestDurationHistogram.get()
  const leStr = le === '+Inf' ? '+Inf' : String(le)
  const entry = metrics.values.find(
    v =>
      String(v.labels.le) === leStr &&
      v.labels.method === labels.method &&
      v.labels.route === labels.route &&
      v.labels.status_class === labels.status_class,
  )
  return entry?.value ?? 0
}

/**
 * Returns the _count for a histogram label set.
 * prom-client stores _count as a value entry with metricName ending in _count
 * and no `le` label.  We identify it by checking that `le` is absent AND the
 * value is an integer (not a float like _sum).
 */
async function histCount(labels: {
  method: string
  route: string
  status_class: string
}): Promise<number> {
  const metrics = await httpRequestDurationHistogram.get()
  // Filter entries matching label set, no `le`, and value is integer (count not sum)
  const candidates = metrics.values.filter(
    v =>
      v.labels.le === undefined &&
      v.labels.method === labels.method &&
      v.labels.route === labels.route &&
      v.labels.status_class === labels.status_class,
  )
  // Among candidates, _count is always a non-negative integer; _sum may be a float.
  // Pick the integer-valued one.
  const countEntry = candidates.find(v => Number.isInteger(v.value))
  return countEntry?.value ?? 0
}

/** Return the counter value for a given status-total label set. */
async function statusCount(labels: {
  method: string
  route: string
  status_class: string
}): Promise<number> {
  const result = await httpRequestStatusTotal.get()
  const entry = result.values.find(
    v =>
      v.labels.method === labels.method &&
      v.labels.route === labels.route &&
      v.labels.status_class === labels.status_class,
  )
  return entry?.value ?? 0
}

/** Build a minimal Express app with metricsMiddleware pre-wired. */
function buildApp(routerSetup: (router: Router) => void): express.Express {
  const app = express()
  app.use(metricsMiddleware)
  const router = Router()
  routerSetup(router)
  app.use('/api', router)
  return app
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  httpRequestDurationHistogram.reset()
  httpRequestStatusTotal.reset()
  _resetSeenRoutes()
})

// ---------------------------------------------------------------------------
// 1. Label correctness — method, route template, status_class
// ---------------------------------------------------------------------------

describe('label correctness', () => {
  it('records method=GET and the normalised route template', async () => {
    const app = buildApp(r => {
      r.get('/trust/:address', (_req: Request, res: Response) => res.json({ ok: true }))
    })

    await request(app).get('/api/trust/0xDeAdBeEf').expect(200)

    const count = await histCount({ method: 'GET', route: '/api/trust/:address', status_class: '2xx' })
    expect(count).toBe(1)
  })

  it('records method=POST independently of GET', async () => {
    const app = buildApp(r => {
      r.get('/items', (_req: Request, res: Response) => res.json([]))
      r.post('/items', (_req: Request, res: Response) => res.status(201).json({ created: true }))
    })

    await request(app).get('/api/items').expect(200)
    await request(app).post('/api/items').expect(201)

    const getCount = await histCount({ method: 'GET', route: '/api/items', status_class: '2xx' })
    const postCount = await histCount({ method: 'POST', route: '/api/items', status_class: '2xx' })

    expect(getCount).toBe(1)
    expect(postCount).toBe(1)
  })

  it('records all five HTTP verbs under distinct method labels', async () => {
    const app = buildApp(r => {
      r.get('/resource', (_req, res) => res.json({}))
      r.post('/resource', (_req, res) => res.status(201).json({}))
      r.put('/resource', (_req, res) => res.json({}))
      r.patch('/resource', (_req, res) => res.json({}))
      r.delete('/resource', (_req, res) => res.status(204).send())
    })

    await request(app).get('/api/resource')
    await request(app).post('/api/resource')
    await request(app).put('/api/resource')
    await request(app).patch('/api/resource')
    await request(app).delete('/api/resource')

    for (const [method, sc] of [
      ['GET', '2xx'],
      ['POST', '2xx'],
      ['PUT', '2xx'],
      ['PATCH', '2xx'],
      ['DELETE', '2xx'],
    ]) {
      const count = await histCount({ method, route: '/api/resource', status_class: sc })
      expect(count, `method=${method}`).toBe(1)
    }
  })
})

// ---------------------------------------------------------------------------
// 2. Sub-router mount prefix — baseUrl + route.path
// ---------------------------------------------------------------------------

describe('sub-router mount prefix', () => {
  it('includes the /api mount prefix in the route template', async () => {
    const app = buildApp(r => {
      r.get('/trust/:address', (_req, res) => res.json({ ok: true }))
    })

    await request(app).get('/api/trust/0xabcdef').expect(200)

    // Must be /api/trust/:address, NOT /:address or /trust/:address
    const withPrefix = await histCount({ method: 'GET', route: '/api/trust/:address', status_class: '2xx' })
    const withoutPrefix = await histCount({ method: 'GET', route: '/:address', status_class: '2xx' })
    const shortPrefix = await histCount({ method: 'GET', route: '/trust/:address', status_class: '2xx' })

    expect(withPrefix).toBe(1)
    expect(withoutPrefix).toBe(0)
    expect(shortPrefix).toBe(0)
  })

  it('handles nested sub-routers with two levels of mount prefix', async () => {
    const app = express()
    app.use(metricsMiddleware)

    const inner = Router()
    inner.get('/:id', (_req, res) => res.json({ ok: true }))

    const outer = Router()
    outer.use('/jobs', inner)

    app.use('/api/v1', outer)

    await request(app).get('/api/v1/jobs/42').expect(200)

    // With two nested routers Express sets baseUrl="/api/v1/jobs" and route.path="/:id"
    const count = await histCount({ method: 'GET', route: '/api/v1/jobs/:id', status_class: '2xx' })
    expect(count).toBe(1)
  })

  it('produces a single template for many distinct addresses on the same route', async () => {
    const app = buildApp(r => {
      r.get('/bond/:address', (_req, res) => res.json({ ok: true }))
    })

    const addresses = ['0xaaa', '0xbbb', '0xccc', '0xddd', '0xeee']
    for (const addr of addresses) {
      await request(app).get(`/api/bond/${addr}`).expect(200)
    }

    const count = await histCount({ method: 'GET', route: '/api/bond/:address', status_class: '2xx' })
    expect(count).toBe(addresses.length)
  })
})

// ---------------------------------------------------------------------------
// 3. Status class bucketing
// ---------------------------------------------------------------------------

describe('status class bucketing', () => {
  it('labels 200 responses as 2xx', async () => {
    const app = buildApp(r => {
      r.get('/ok', (_req, res) => res.status(200).json({}))
    })
    await request(app).get('/api/ok').expect(200)

    expect(await statusCount({ method: 'GET', route: '/api/ok', status_class: '2xx' })).toBe(1)
    expect(await statusCount({ method: 'GET', route: '/api/ok', status_class: '4xx' })).toBe(0)
    expect(await statusCount({ method: 'GET', route: '/api/ok', status_class: '5xx' })).toBe(0)
  })

  it('labels 201 responses as 2xx', async () => {
    const app = buildApp(r => {
      r.post('/items', (_req, res) => res.status(201).json({ id: 1 }))
    })
    await request(app).post('/api/items').expect(201)

    expect(await statusCount({ method: 'POST', route: '/api/items', status_class: '2xx' })).toBe(1)
  })

  it('labels 400 responses as 4xx', async () => {
    const app = buildApp(r => {
      r.get('/bad', (_req, res) => res.status(400).json({ error: 'bad request' }))
    })
    await request(app).get('/api/bad').expect(400)

    expect(await statusCount({ method: 'GET', route: '/api/bad', status_class: '4xx' })).toBe(1)
    expect(await statusCount({ method: 'GET', route: '/api/bad', status_class: '2xx' })).toBe(0)
  })

  it('labels 404 responses as 4xx', async () => {
    const app = buildApp(r => {
      r.get('/missing', (_req, res) => res.status(404).json({ error: 'not found' }))
    })
    await request(app).get('/api/missing').expect(404)

    expect(await statusCount({ method: 'GET', route: '/api/missing', status_class: '4xx' })).toBe(1)
  })

  it('labels 500 responses as 5xx', async () => {
    const app = buildApp(r => {
      r.get('/err', (_req, res) => res.status(500).json({ error: 'internal' }))
    })
    await request(app).get('/api/err').expect(500)

    expect(await statusCount({ method: 'GET', route: '/api/err', status_class: '5xx' })).toBe(1)
    expect(await statusCount({ method: 'GET', route: '/api/err', status_class: '2xx' })).toBe(0)
  })

  it('separates 2xx and 4xx counts on the same route', async () => {
    const app = buildApp(r => {
      r.get('/maybe', (req, res) => {
        if (req.query.fail) res.status(400).json({ error: 'bad' })
        else res.json({ ok: true })
      })
    })

    await request(app).get('/api/maybe')
    await request(app).get('/api/maybe')
    await request(app).get('/api/maybe?fail=1')

    expect(await statusCount({ method: 'GET', route: '/api/maybe', status_class: '2xx' })).toBe(2)
    expect(await statusCount({ method: 'GET', route: '/api/maybe', status_class: '4xx' })).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 4. SLO bucket fence-posts — accuracy for p50 / p95 / p99 PromQL queries
// ---------------------------------------------------------------------------

describe('SLO bucket fence-posts', () => {
  it('200 ms observation falls in le=0.2 bucket but not le=0.1', async () => {
    // Observe directly so we control the exact value.
    httpRequestDurationHistogram.observe(
      { method: 'GET', route: '/api/trust/:address', status_class: '2xx' },
      0.200,
    )

    expect(await bucketCount(0.2, { method: 'GET', route: '/api/trust/:address', status_class: '2xx' })).toBe(1)
    expect(await bucketCount(0.1, { method: 'GET', route: '/api/trust/:address', status_class: '2xx' })).toBe(0)
  })

  it('500 ms observation falls in le=0.5 bucket but not le=0.2', async () => {
    httpRequestDurationHistogram.observe(
      { method: 'GET', route: '/api/queue/:id', status_class: '2xx' },
      0.500,
    )

    expect(await bucketCount(0.5, { method: 'GET', route: '/api/queue/:id', status_class: '2xx' })).toBe(1)
    expect(await bucketCount(0.2, { method: 'GET', route: '/api/queue/:id', status_class: '2xx' })).toBe(0)
  })

  it('1000 ms observation falls in le=1 bucket but not le=0.5', async () => {
    httpRequestDurationHistogram.observe(
      { method: 'GET', route: '/api/db/:id', status_class: '2xx' },
      1.000,
    )

    expect(await bucketCount(1, { method: 'GET', route: '/api/db/:id', status_class: '2xx' })).toBe(1)
    expect(await bucketCount(0.5, { method: 'GET', route: '/api/db/:id', status_class: '2xx' })).toBe(0)
  })

  it('sub-millisecond observation falls only in the fine-grained buckets', async () => {
    httpRequestDurationHistogram.observe(
      { method: 'GET', route: '/api/fast', status_class: '2xx' },
      0.003, // 3 ms
    )

    // 3 ms < 5 ms bucket
    expect(await bucketCount(0.005, { method: 'GET', route: '/api/fast', status_class: '2xx' })).toBe(1)
    // 3 ms < 10 ms
    expect(await bucketCount(0.01, { method: 'GET', route: '/api/fast', status_class: '2xx' })).toBe(1)
    // All larger buckets also contain it (cumulative)
    expect(await bucketCount(0.2, { method: 'GET', route: '/api/fast', status_class: '2xx' })).toBe(1)
  })

  it('histogram_quantile PromQL pattern: ten 50 ms observations all land under le=0.05', async () => {
    // Simulates the data shape used by histogram_quantile(0.5, ...) for p50.
    for (let i = 0; i < 10; i++) {
      httpRequestDurationHistogram.observe(
        { method: 'GET', route: '/api/ping', status_class: '2xx' },
        0.05,
      )
    }

    // All 10 in the le=0.05 bucket (50 ms SLO query fence-post)
    expect(await bucketCount(0.05, { method: 'GET', route: '/api/ping', status_class: '2xx' })).toBe(10)
    // _count tracks every observation regardless of bucket
    const count = await histCount({ method: 'GET', route: '/api/ping', status_class: '2xx' })
    expect(count).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// 5. High-resolution timer
// ---------------------------------------------------------------------------

describe('high-resolution timer', () => {
  it('records an observation in the +Inf bucket for each real request', async () => {
    const app = buildApp(r => {
      r.get('/timer', (_req, res) => res.json({ ok: true }))
    })

    await request(app).get('/api/timer').expect(200)

    // Every observation appears in the +Inf bucket regardless of duration.
    // prom-client encodes the +Inf bucket le label as the string "+Inf".
    const infCount = await bucketCount('+Inf', { method: 'GET', route: '/api/timer', status_class: '2xx' })
    expect(infCount).toBe(1)
  })

  it('duration is measured in seconds (value < 10 for a fast handler)', async () => {
    const app = buildApp(r => {
      r.get('/fast-timer', (_req, res) => res.json({}))
    })

    await request(app).get('/api/fast-timer').expect(200)

    // A fast in-process handler should complete well under 10 s.
    // Verify the observation fell in the le=10 bucket (i.e. duration ≤ 10 s).
    expect(
      await bucketCount(10, { method: 'GET', route: '/api/fast-timer', status_class: '2xx' }),
    ).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 6. Cardinality overflow guard
// ---------------------------------------------------------------------------

describe('cardinality overflow guard', () => {
  it(`returns "${OVERFLOW_ROUTE_LABEL}" once ${MAX_ROUTE_CARDINALITY} unique templates are registered`, async () => {
    const { normalizeRoute } = await import('../observability/latencyMetrics.js')

    // Fill the seen-routes set to exactly the cap.
    for (let i = 0; i < MAX_ROUTE_CARDINALITY; i++) {
      normalizeRoute(`/api/route-${i}`, `/api/route-${i}`)
    }

    // The next new template must be bucketed as overflow.
    const result = normalizeRoute('/api/brand-new-unseen-route', '/api/brand-new-unseen-route')
    expect(result).toBe(OVERFLOW_ROUTE_LABEL)
  })

  it('does not add overflow sentinel to the seen-routes set', async () => {
    const { normalizeRoute } = await import('../observability/latencyMetrics.js')

    for (let i = 0; i < MAX_ROUTE_CARDINALITY; i++) {
      normalizeRoute(`/api/r-${i}`, `/api/r-${i}`)
    }

    // Multiple overflow calls should all return the sentinel without growing the set.
    expect(normalizeRoute('/a')).toBe(OVERFLOW_ROUTE_LABEL)
    expect(normalizeRoute('/b')).toBe(OVERFLOW_ROUTE_LABEL)
    expect(normalizeRoute('/c')).toBe(OVERFLOW_ROUTE_LABEL)
  })

  it('existing templates still resolve correctly after the cap is hit', async () => {
    const { normalizeRoute } = await import('../observability/latencyMetrics.js')

    const knownRoutes: string[] = []
    for (let i = 0; i < MAX_ROUTE_CARDINALITY; i++) {
      const r = `/api/known-${i}`
      normalizeRoute(r, r)
      knownRoutes.push(r)
    }

    // Overflow new route.
    normalizeRoute('/api/unknown', '/api/unknown')

    // Previously seen routes must still return their own template.
    for (const r of knownRoutes) {
      expect(normalizeRoute(r, r)).toBe(r)
    }
  })

  it('cardinality is stable when 1000 unique raw paths normalise to one template', async () => {
    const { normalizeRoute } = await import('../observability/latencyMetrics.js')

    // 1000 distinct hex addresses should all collapse to the same template.
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      const raw = `/api/trust/0x${i.toString(16).padStart(8, '0')}`
      seen.add(normalizeRoute(raw))
    }

    expect(seen.size).toBe(1)
    expect([...seen][0]).toBe('/api/trust/:address')
  })

  it('middleware records overflow label for unmatched paths that exceed cardinality cap', async () => {
    // Fill up to the cap with known templates first.
    const { normalizeRoute: nr } = await import('../observability/latencyMetrics.js')
    for (let i = 0; i < MAX_ROUTE_CARDINALITY; i++) {
      nr(`/api/pre-${i}`, `/api/pre-${i}`)
    }

    // Now hit a completely new route — middleware should record _overflow as the route label.
    const app = express()
    app.use(metricsMiddleware)
    app.get('/completely/new/path', (_req, res) => res.json({ ok: true }))

    await request(app).get('/completely/new/path').expect(200)

    const count = await statusCount({
      method: 'GET',
      route: OVERFLOW_ROUTE_LABEL,
      status_class: '2xx',
    })
    expect(count).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 7. Prometheus text output — end-to-end scrape smoke test
// ---------------------------------------------------------------------------

describe('Prometheus text output', () => {
  it('emits http_request_duration_seconds histogram lines in the scrape output', async () => {
    const registry = new client.Registry()

    const { registerLatencyMetrics, httpRequestDurationHistogram: hist } = await import(
      '../observability/latencyMetrics.js'
    )
    registerLatencyMetrics(registry)
    hist.observe({ method: 'GET', route: '/api/health', status_class: '2xx' }, 0.01)

    const output = await registry.metrics()

    expect(output).toContain('# TYPE http_request_duration_seconds histogram')
    expect(output).toContain('http_request_duration_seconds_count{method="GET",route="/api/health",status_class="2xx"} 1')
    expect(output).toMatch(/http_request_duration_seconds_bucket\{[^}]*le="0\.2"[^}]*\}/)
    expect(output).toMatch(/http_request_duration_seconds_bucket\{[^}]*le="0\.5"[^}]*\}/)
    expect(output).toMatch(/http_request_duration_seconds_bucket\{[^}]*le="1"[^}]*\}/)
  })

  it('emits http_requests_status_total counter lines in the scrape output', async () => {
    const registry = new client.Registry()

    const { registerLatencyMetrics, httpRequestStatusTotal: counter } = await import(
      '../observability/latencyMetrics.js'
    )
    registerLatencyMetrics(registry)
    counter.inc({ method: 'POST', route: '/api/verify', status_class: '2xx' })

    const output = await registry.metrics()

    expect(output).toContain('# TYPE http_requests_status_total counter')
    // prom-client v15 does not append _total twice for counters already ending in _total
    expect(output).toContain(
      'http_requests_status_total{method="POST",route="/api/verify",status_class="2xx"} 1',
    )
  })
})
