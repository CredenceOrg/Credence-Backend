import { describe, it, expect } from 'vitest'
import request from 'supertest'
import express from 'express'
import { createHealthRouter } from './health.js'

function appWithHealth(probes: Parameters<typeof createHealthRouter>[0] = {}) {
  const app = express()
  app.use('/api/health', createHealthRouter(probes))
  return app
}

// ---------------------------------------------------------------------------
// In-memory Redis stub for the worker endpoint tests
// ---------------------------------------------------------------------------
function makeFakeRedis() {
  const store = new Map<string, { value: string; ttlSeconds: number }>()
  return {
    _store: store,
    async get(key: string) {
      const entry = store.get(key)
      return entry ? entry.value : null
    },
    async ttl(key: string) {
      const entry = store.get(key)
      if (!entry) return -2
      return entry.ttlSeconds
    },
    async scan(cursor: number, _opts: { MATCH: string; COUNT: number }) {
      const keys = Array.from(store.keys())
      return { cursor: 0, keys }
    },
  }
}

describe('Health routes', () => {
  describe('GET /api/health (readiness)', () => {
    it('returns 200 and ok when all critical deps are up', async () => {
      const app = appWithHealth({
        db: async () => ({ status: 'up' }),
        cache: async () => ({ status: 'up' }),
        queue: async () => ({ status: 'up' }),
      })
      const res = await request(app).get('/api/health')
      expect(res.status).toBe(200)
      expect(res.body.status).toBe('ok')
      expect(res.body.dependencies.db.status).toBe('up')
      expect(res.body.dependencies.cache.status).toBe('up')
      expect(res.body.dependencies.queue.status).toBe('up')
    })

    it('returns 200 when no deps configured', async () => {
      const app = appWithHealth({})
      const res = await request(app).get('/api/health')
      expect(res.status).toBe(200)
      expect(res.body.status).toBe('ok')
      expect(res.body.dependencies.db.status).toBe('not_configured')
      expect(res.body.dependencies.cache.status).toBe('not_configured')
      expect(res.body.dependencies.queue.status).toBe('not_configured')
    })

    it('returns 503 when db is down', async () => {
      const app = appWithHealth({
        db: async () => ({ status: 'down' }),
        cache: async () => ({ status: 'up' }),
      })
      const res = await request(app).get('/api/health')
      expect(res.status).toBe(503)
      expect(res.body.status).toBe('unhealthy')
    })

    it('returns 503 when cache is down', async () => {
      const app = appWithHealth({
        db: async () => ({ status: 'up' }),
        cache: async () => ({ status: 'down' }),
      })
      const res = await request(app).get('/api/health')
      expect(res.status).toBe(503)
      expect(res.body.status).toBe('unhealthy')
    })

    it('returns 503 when db, cache, and queue are down', async () => {
      const app = appWithHealth({
        db: async () => ({ status: 'down' }),
        cache: async () => ({ status: 'down' }),
        queue: async () => ({ status: 'down' }),
      })
      const res = await request(app).get('/api/health')
      expect(res.status).toBe(503)
    })

    it('returns 200 when only gateway is down (degraded)', async () => {
      const app = appWithHealth({
        db: async () => ({ status: 'up' }),
        cache: async () => ({ status: 'up' }),
        gateway: async () => ({ status: 'down' }),
      })
      const res = await request(app).get('/api/health')
      expect(res.status).toBe(200)
      expect(res.body.status).toBe('degraded')
    })
  })

  describe('GET /api/health/ready', () => {
    it('behaves like GET /api/health', async () => {
      const app = appWithHealth({
        db: async () => ({ status: 'down' }),
        cache: async () => ({ status: 'up' }),
      })
      const res = await request(app).get('/api/health/ready')
      expect(res.status).toBe(503)
      expect(res.body.status).toBe('unhealthy')
    })
  })

  describe('GET /api/health/live (liveness)', () => {
    it('returns 200 always', async () => {
      const app = appWithHealth({
        db: async () => ({ status: 'down' }),
        cache: async () => ({ status: 'down' }),
      })
      const res = await request(app).get('/api/health/live')
      expect(res.status).toBe(200)
      expect(res.body.status).toBe('ok')
      expect(res.body.service).toBe('credence-backend')
    })
  })

  describe('GET /api/health/workers', () => {
    it('returns 404 when no redisClient configured', async () => {
      const app = appWithHealth({})
      const res = await request(app).get('/api/health/workers')
      expect(res.status).toBe(404)
    })

    it('returns worker states when redisClient is provided', async () => {
      const redis = makeFakeRedis()
      redis._store.set('cron:score-snapshot', {
        value: '12345-1700000000000-abc',
        ttlSeconds: 25,
      })

      const app = appWithHealth({ redisClient: redis as any })
      const res = await request(app).get('/api/health/workers')
      expect(res.status).toBe(200)
      expect(res.body.workers).toBeInstanceOf(Array)
      expect(res.body.workers).toHaveLength(1)

      const worker = res.body.workers[0]
      expect(worker).toMatchObject({
        name: 'score-snapshot',
        lockKey: 'cron:score-snapshot',
        held: true,
        pid: 12345,
        acquiredAt: '2023-11-14T22:13:20.000Z',
      })
      // TTL is 25s => 25_000ms; allow a small tolerance for inaccuracies
      expect(worker.ttlMs).toBe(25_000)
    })

    it('reports not-held workers when no keys exist', async () => {
      const redis = makeFakeRedis()

      const app = appWithHealth({ redisClient: redis as any })
      const res = await request(app).get('/api/health/workers')
      expect(res.status).toBe(200)
      expect(res.body.workers).toHaveLength(1)
      expect(res.body.workers[0]).toMatchObject({
        name: 'score-snapshot',
        lockKey: 'cron:score-snapshot',
        held: false,
        pid: null,
        acquiredAt: null,
        ttlMs: -2,
      })
    })

    it('gracefully reports all workers as not-held when Redis is down', async () => {
      const redis = makeFakeRedis()
      redis.scan = async () => {
        throw new Error('Connection refused')
      }

      const app = appWithHealth({ redisClient: redis as any })
      const res = await request(app).get('/api/health/workers')
      // Graceful degradation: 200 with known workers reported as not-held
      expect(res.status).toBe(200)
      expect(res.body.workers).toBeInstanceOf(Array)
      expect(res.body.workers.length).toBeGreaterThanOrEqual(1)
      expect(res.body.workers[0].held).toBe(false)
    })
  })
})
