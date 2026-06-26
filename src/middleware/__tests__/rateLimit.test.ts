import { describe, it, expect, beforeEach } from 'vitest'
import express, { Request, Response, NextFunction } from 'express'
import request from 'supertest'
import { createRateLimitMiddleware } from '../rateLimit.js'
import { register } from '../metrics.js'

function createApp(getRedis: any, config: any) {
  const app = express()
  app.use(createRateLimitMiddleware(config, { getRedis }))
  app.get('/ok', (_req, res) => res.status(200).json({ ok: true }))
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message, code: err.code })
  })
  return app
}

beforeEach(() => {
  register.resetMetrics()
})

describe('rate limit middleware', () => {
  it('increments tenant-level hit metrics when tenant quota is exceeded', async () => {
    const config = {
      enabled: true,
      windowSec: 60,
      maxFree: 1,
      maxPro: 100,
      maxEnterprise: 1000,
      failOpen: false,
    }

    const requests: Record<string, number> = {}
    const getRedis = () => ({
      incr: async (key: string) => {
        requests[key] = (requests[key] ?? 0) + 1
        return requests[key]
      },
      expire: async () => 60,
      ttl: async () => 60,
    })

    const app = createApp(getRedis, config)

    // First request should pass
    await request(app)
      .get('/ok')
      .set('X-API-Key', 'ak-123')
      .set('Authorization', 'Bearer token-1')

    const secondResponse = await request(app)
      .get('/ok')
      .set('X-API-Key', 'ak-123')
      .set('Authorization', 'Bearer token-1')

    expect(secondResponse.status).toBe(429)
    expect(secondResponse.body.code).toBe('rate_limit_exceeded')

    const metrics = await register.metrics()
    expect(metrics).toContain('rate_limit_hits_total')
    expect(metrics).toContain('tenant="ak:')
    expect(metrics).toContain('tier="free"')
  })

  it('uses unknown tenant label when tenant cannot be resolved', async () => {
    const config = {
      enabled: true,
      windowSec: 60,
      maxFree: 1,
      maxPro: 100,
      maxEnterprise: 1000,
      failOpen: false,
    }

    const state: Record<string, number> = {}
    const getRedis = () => ({
      incr: async (key: string) => {
        state[key] = (state[key] ?? 0) + 1
        return state[key]
      },
      expire: async () => 60,
      ttl: async () => 60,
    })

    const app = express()
    app.use(createRateLimitMiddleware(config, { getRedis }))
    app.get('/ok', (_req, res) => res.status(200).json({ ok: true }))
    app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
      res.status(err.status ?? 500).json({ error: err.message, code: err.code })
    })

    const firstResponse = await request(app).get('/ok')
    expect(firstResponse.status).toBe(200)

    const secondResponse = await request(app).get('/ok')

    expect(secondResponse.status).toBe(429)
    const metrics = await register.metrics()
    expect(metrics).toContain('rate_limit_hits_total')
    expect(metrics).toContain('tenant="unknown"')
    expect(metrics).toContain('tier="free"')
  })
})
