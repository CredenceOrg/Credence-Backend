import { describe, expect, it } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import { createRateLimitMiddleware, type RateLimitRedis } from '../../src/middleware/rateLimit.js'

/**
 * A small Redis-compatible test double. `eval` executes synchronously to model
 * Redis's single command thread, while the middleware calls it through a
 * Promise just like the real client.
 */
class AtomicRedis implements RateLimitRedis {
  private values = new Map<string, number>()
  private expiries = new Map<string, number>()
  readonly scripts: Array<{ script: string; keys: string[]; args: string[] }> = []
  now = 0
  fail = false

  async incr(key: string): Promise<number> {
    this.removeExpired(key)
    const count = (this.values.get(key) ?? 0) + 1
    this.values.set(key, count)
    return count
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.expiries.set(key, this.now + seconds * 1000)
    return 1
  }

  async ttl(key: string): Promise<number> {
    this.removeExpired(key)
    const expiry = this.expiries.get(key)
    if (expiry === undefined) return -1
    return Math.max(1, Math.ceil((expiry - this.now) / 1000))
  }

  async eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<number[]> {
    if (this.fail) throw new Error('redis unavailable')
    this.scripts.push({ script, keys: options.keys, args: options.arguments })
    const key = options.keys[0]
    const seconds = Number(options.arguments[0])
    this.removeExpired(key)
    const count = (this.values.get(key) ?? 0) + 1
    this.values.set(key, count)
    if (count === 1) this.expiries.set(key, this.now + seconds * 1000)
    return [count, await this.ttl(key)]
  }

  advance(seconds: number) {
    this.now += seconds * 1000
  }

  private removeExpired(key: string) {
    const expiry = this.expiries.get(key)
    if (expiry !== undefined && expiry <= this.now) {
      this.values.delete(key)
      this.expiries.delete(key)
    }
  }
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    windowSec: 60,
    maxFree: 2,
    maxPro: 2,
    maxEnterprise: 2,
    failOpen: false,
    ...overrides,
  }
}

function buildApp(
  redis: RateLimitRedis,
  options: {
    config?: Record<string, unknown>
    getTenantId?: (req: express.Request) => string | undefined
    getTenantOverride?: (tenantId: string) => Promise<{ rateLimit: number; windowSize: number } | null>
    routes?: string[]
  } = {},
): Express {
  const app = express()
  app.use(express.json())
  if (!options.getTenantId) {
    app.use((req, _res, next) => {
      ;(req as any).apiKeyRecord = { id: 'key-1', ownerId: 'tenant-a', tier: 'free' }
      next()
    })
  }
  app.use('/api', createRateLimitMiddleware(config(options.config), {
    namespace: 'ratelimit:distributed-test',
    getRedis: () => redis,
    getTenantId: options.getTenantId,
    getTenantOverride: options.getTenantOverride,
    includeRoute: true,
  }))
  for (const route of options.routes ?? ['/ping']) {
    app.get(`/api${route}`, (_req, res) => res.json({ ok: true, route }))
  }
  app.use((_err: any, _req: any, res: any, _next: any) => {
    res.status(_err.status ?? 500).json({ error: _err.message, code: _err.code })
  })
  return app
}

describe('distributed rate-limit correctness', () => {
  it('uses one atomic Redis script for increment and expiry', async () => {
    const redis = new AtomicRedis()
    const app = buildApp(redis)

    const response = await request(app).get('/api/ping')

    expect(response.status).toBe(200)
    expect(redis.scripts).toHaveLength(2)
    expect(redis.scripts[0].script).toContain("redis.call('INCR'")
    expect(redis.scripts[0].script).toContain("redis.call('EXPIRE'")
    expect(redis.scripts[0].script).toContain("redis.call('TTL'")
    expect(redis.scripts[0].keys).toHaveLength(1)
  })

  it('enforces one shared limit across middleware instances without overshoot', async () => {
    const redis = new AtomicRedis()
    const appA = buildApp(redis, { config: { maxFree: 10, maxPro: 10, maxEnterprise: 10 } })
    const appB = buildApp(redis, { config: { maxFree: 10, maxPro: 10, maxEnterprise: 10 } })

    const responses = await Promise.all(
      Array.from({ length: 40 }, (_, index) => request(index % 2 ? appA : appB).get('/api/ping')),
    )

    expect(responses.filter((response) => response.status === 200)).toHaveLength(10)
    expect(responses.filter((response) => response.status === 429)).toHaveLength(30)
    expect(redis.scripts.length).toBeGreaterThanOrEqual(10)
  })

  it('separates tenant buckets and prevents cross-tenant collisions', async () => {
    const redis = new AtomicRedis()
    const app = buildApp(redis, {
      config: { maxFree: 1, maxPro: 1, maxEnterprise: 1 },
      getTenantId: (req) => String(req.headers['x-tenant-id'] ?? ''),
    })

    expect((await request(app).get('/api/ping').set('x-tenant-id', 'tenant-a')).status).toBe(200)
    expect((await request(app).get('/api/ping').set('x-tenant-id', 'tenant-b')).status).toBe(200)
    expect((await request(app).get('/api/ping').set('x-tenant-id', 'tenant-a')).status).toBe(429)
  })

  it('includes route scope so one route cannot exhaust another route', async () => {
    const redis = new AtomicRedis()
    const app = buildApp(redis, {
      config: { maxFree: 1, maxPro: 1, maxEnterprise: 1 },
      routes: ['/one', '/two'],
    })

    expect((await request(app).get('/api/one')).status).toBe(200)
    expect((await request(app).get('/api/two')).status).toBe(200)
    expect((await request(app).get('/api/one')).status).toBe(429)
  })

  it('applies tenant overrides to the shared atomic window and expiry', async () => {
    const redis = new AtomicRedis()
    const app = buildApp(redis, {
      config: { maxFree: 10, maxPro: 10, maxEnterprise: 10 },
      getTenantOverride: async (tenantId) => tenantId === 'tenant-a'
        ? { rateLimit: 1, windowSize: 30 }
        : null,
    })

    expect((await request(app).get('/api/ping')).status).toBe(200)
    const blocked = await request(app).get('/api/ping')
    expect(blocked.status).toBe(429)
    expect(blocked.headers['retry-after']).toBe('30')
    expect(redis.scripts[0].args).toEqual(['30'])

    redis.advance(30)
    expect((await request(app).get('/api/ping')).status).toBe(200)
  })

  it('uses the socket peer rather than spoofable forwarded headers', async () => {
    const redis = new AtomicRedis()
    const app = buildApp(redis, { config: { maxFree: 1, maxPro: 1, maxEnterprise: 1 } })

    expect((await request(app).get('/api/ping').set('x-forwarded-for', '198.51.100.1')).status).toBe(200)
    expect((await request(app).get('/api/ping').set('x-forwarded-for', '203.0.113.99')).status).toBe(429)
  })

  it('fails closed when the shared dependency is unavailable', async () => {
    const redis = new AtomicRedis()
    redis.fail = true
    const app = buildApp(redis, { config: { failOpen: false } })

    const response = await request(app).get('/api/ping')

    expect(response.status).toBe(503)
    expect(response.body.code).toBe('service_unavailable')
  })

  it('supports explicit fail-open behavior for non-sensitive routes', async () => {
    const redis = new AtomicRedis()
    redis.fail = true
    const app = buildApp(redis, { config: { failOpen: true } })

    const response = await request(app).get('/api/ping')

    expect(response.status).toBe(200)
    expect(response.headers['x-ratelimit-remaining']).toBe('2')
  })
})
