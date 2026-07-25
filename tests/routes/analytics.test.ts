import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import { createAnalyticsRouter } from '../../src/routes/analytics.js'
import { _resetAnalyticsCacheGeneration, bumpAnalyticsCacheGeneration } from '../../src/services/analytics/cacheGeneration.js'

// ---- mock heavy infrastructure ----

vi.mock('../../src/middleware/metrics.js', () => ({
  register: { registerMetric: vi.fn() },
}))

vi.mock('../../src/cache/redis.js', () => ({
  cache: {
    get: vi.fn(),
    set: vi.fn(),
  },
}))

// ---- imports that depend on the mocks above ----

import { cache } from '../../src/cache/redis.js'
import { analyticsCacheHits, analyticsCacheMisses } from '../../src/routes/analytics.js'

// ---- helpers ----

const mockSummary = {
  metrics: {
    activeIdentities: 42,
    totalIdentities: 100,
    avgTotalScore: 0.75,
    latestScoreCalculatedAt: '2026-06-17T00:00:00.000Z',
  },
  staleness: {
    asOf: '2026-06-17T00:00:00.000Z',
    ageSeconds: 10,
    fresh: true,
    refreshStatus: 'ok',
  },
}

function makeService(overrides: Partial<{ getSummary: () => Promise<any> }> = {}) {
  return {
    getSummary: vi.fn().mockResolvedValue(mockSummary),
    refreshConcurrently: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any
}

function createApp(service?: any) {
  const app = express()
  app.use('/api/analytics', createAnalyticsRouter(service))
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode ?? 503).json({ error: err.message })
  })
  return app
}

// ---- tests ----

describe('GET /api/analytics/summary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetAnalyticsCacheGeneration()
    vi.mocked(cache.get).mockResolvedValue(null)
    vi.mocked(cache.set).mockResolvedValue(true)
  })

  it('returns 503 when no analytics service is configured', async () => {
    const res = await request(createApp()).get('/api/analytics/summary')
    expect(res.status).toBe(503)
  })

  it('fetches from service on cache miss and caches the result', async () => {
    const service = makeService()
    const res = await request(createApp(service)).get('/api/analytics/summary')

    expect(res.status).toBe(200)
    expect(res.body.metrics.activeIdentities).toBe(42)
    expect(service.getSummary).toHaveBeenCalledOnce()
    expect(cache.set).toHaveBeenCalledOnce()
  })

  it('returns cached result on second request without calling the service', async () => {
    const service = makeService()
    const app = createApp(service)

    // First request — miss
    vi.mocked(cache.get).mockResolvedValueOnce(null)
    await request(app).get('/api/analytics/summary')

    // Second request — hit
    vi.mocked(cache.get).mockResolvedValueOnce(mockSummary)
    const res = await request(app).get('/api/analytics/summary')

    expect(res.status).toBe(200)
    expect(service.getSummary).toHaveBeenCalledOnce() // not called again
  })

  it('increments hit counter on cache hit', async () => {
    const before = (await analyticsCacheHits.get()).values[0]?.value ?? 0
    vi.mocked(cache.get).mockResolvedValue(mockSummary)

    await request(createApp(makeService())).get('/api/analytics/summary')

    const after = (await analyticsCacheHits.get()).values[0]?.value ?? 0
    expect(after).toBe(before + 1)
  })

  it('increments miss counter on cache miss', async () => {
    const before = (await analyticsCacheMisses.get()).values[0]?.value ?? 0
    vi.mocked(cache.get).mockResolvedValue(null)

    await request(createApp(makeService())).get('/api/analytics/summary')

    const after = (await analyticsCacheMisses.get()).values[0]?.value ?? 0
    expect(after).toBe(before + 1)
  })

  it('serves fresh data after generation bump (refresh invalidation)', async () => {
    const freshSummary = { ...mockSummary, metrics: { ...mockSummary.metrics, activeIdentities: 99 } }
    const service = makeService({
      getSummary: vi.fn()
        .mockResolvedValueOnce(mockSummary)
        .mockResolvedValueOnce(freshSummary),
    })
    const app = createApp(service)

    // Gen 0 — miss, populate cache
    vi.mocked(cache.get).mockResolvedValueOnce(null)
    const res1 = await request(app).get('/api/analytics/summary')
    expect(res1.body.metrics.activeIdentities).toBe(42)

    // Simulate refresh worker bumping the generation
    bumpAnalyticsCacheGeneration()

    // Gen 1 — the old key no longer matches; cache returns null for new key
    vi.mocked(cache.get).mockResolvedValueOnce(null)
    const res2 = await request(app).get('/api/analytics/summary')

    expect(res2.status).toBe(200)
    expect(res2.body.metrics.activeIdentities).toBe(99)
    expect(service.getSummary).toHaveBeenCalledTimes(2)
  })

  it('isolates cache entries per tenant', async () => {
    const tenantAData = { ...mockSummary, metrics: { ...mockSummary.metrics, activeIdentities: 10 } }
    const tenantBData = { ...mockSummary, metrics: { ...mockSummary.metrics, activeIdentities: 20 } }
    const service = makeService({
      getSummary: vi.fn()
        .mockResolvedValueOnce(tenantAData)
        .mockResolvedValueOnce(tenantBData),
    })
    const app = createApp(service)

    // Both tenants miss cache
    vi.mocked(cache.get).mockResolvedValue(null)

    const resA = await request(app)
      .get('/api/analytics/summary')
      .set('x-tenant-id', 'tenant-a')

    const resB = await request(app)
      .get('/api/analytics/summary')
      .set('x-tenant-id', 'tenant-b')

    // Each tenant triggered its own service call with its own cache key
    expect(service.getSummary).toHaveBeenCalledTimes(2)

    // The cache.set calls used different keys
    const setCalls = vi.mocked(cache.set).mock.calls
    expect(setCalls[0][1]).toContain('tenant-a')
    expect(setCalls[1][1]).toContain('tenant-b')
    expect(setCalls[0][1]).not.toBe(setCalls[1][1])

    expect(resA.body.metrics.activeIdentities).toBe(10)
    expect(resB.body.metrics.activeIdentities).toBe(20)
  })

  it('returns 503 when the service throws', async () => {
    vi.mocked(cache.get).mockResolvedValue(null)
    const service = makeService({ getSummary: vi.fn().mockRejectedValue(new Error('DB down')) })

    const res = await request(createApp(service)).get('/api/analytics/summary')
    expect(res.status).toBe(503)
    expect(res.body.error).toContain('DB down')
  })

  it('normalizes query parameters in the cache key', async () => {
    const service = makeService()
    const app = createApp(service)

    vi.mocked(cache.get).mockResolvedValue(null)

    // First request with param ordering A
    await request(app).get('/api/analytics/summary?b=2&a=1')

    // Second request with different param ordering B (which normalizes to same key)
    vi.mocked(cache.get).mockResolvedValueOnce(mockSummary)
    const res = await request(app).get('/api/analytics/summary?a=1&b=2')

    expect(res.status).toBe(200)
    // service should only be called once because the second one hit the cache
    expect(service.getSummary).toHaveBeenCalledOnce()

    // check that cache.set was called with normalized query key
    const setCalls = vi.mocked(cache.set).mock.calls
    expect(setCalls[0][1]).toContain('a=1&b=2')
  })

  it('normalizes array and object query parameters', async () => {
    const service = makeService()
    const app = createApp(service)

    vi.mocked(cache.get).mockResolvedValue(null)

    await request(app).get('/api/analytics/summary?arr=y&arr=x&obj={"k":"v"}')

    const setCalls = vi.mocked(cache.set).mock.calls
    expect(setCalls[0][1]).toContain('arr=x&arr=y')
  })

  it('coalesces concurrent requests to prevent cache stampede', async () => {
    let resolvePromise: (val: any) => void = () => {}
    const slowPromise = new Promise((resolve) => {
      resolvePromise = resolve
    })

    const service = makeService({
      getSummary: vi.fn().mockReturnValue(slowPromise),
    })
    const app = createApp(service)

    vi.mocked(cache.get).mockResolvedValue(null)

    const p1 = request(app).get('/api/analytics/summary')
    const p2 = request(app).get('/api/analytics/summary')
    const p3 = request(app).get('/api/analytics/summary')

    const run1 = p1.then(r => r)
    const run2 = p2.then(r => r)
    const run3 = p3.then(r => r)

    await new Promise((resolve) => setTimeout(resolve, 100))

    resolvePromise(mockSummary)

    const [res1, res2, res3] = await Promise.all([run1, run2, run3])

    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)
    expect(res3.status).toBe(200)

    expect(service.getSummary).toHaveBeenCalledOnce()
  })

  it('removes pending request from coalesce map if it rejects', async () => {
    const service = makeService({
      getSummary: vi.fn()
        .mockRejectedValueOnce(new Error('DB failure'))
        .mockResolvedValueOnce(mockSummary),
    })
    const app = createApp(service)

    vi.mocked(cache.get).mockResolvedValue(null)

    const res1 = await request(app).get('/api/analytics/summary')
    expect(res1.status).toBe(503)

    const res2 = await request(app).get('/api/analytics/summary')
    expect(res2.status).toBe(200)
    expect(service.getSummary).toHaveBeenCalledTimes(2)
  })
})
