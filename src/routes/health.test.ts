import { describe, it, expect } from 'vitest'
import request from 'supertest'
import express from 'express'
import { createHealthRouter } from './health.js'
import { OUTBOX_MAX_LAG_SECONDS } from '../config/constants.js'

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
const allUp: Parameters<typeof createHealthRouter>[0] = {
  postgres: async () => ({ status: 'up', latencyMs: 2 }),
  redis: async () => ({ status: 'up', latencyMs: 1 }),
  horizonListener: async () => ({ status: 'up', latencyMs: 1 }),
  outboxPublisher: async () => ({ status: 'up', latencyMs: 1 }),
  horizon: async () => ({ status: 'up', latencyMs: 3 }),
}

describe('Health routes', () => {
  describe('GET /api/health (readiness)', () => {
    it('returns 200 and ok when all critical deps are up', async () => {
      const app = appWithHealth(allUp)
      const res = await request(app).get('/api/health')
      expect(res.status).toBe(200)
      expect(res.body.status).toBe('ok')
      expect(res.body.dependencies.postgres.status).toBe('up')
      expect(res.body.dependencies.redis.status).toBe('up')
      expect(res.body.dependencies.horizonListener.status).toBe('up')
      expect(res.body.dependencies.outboxPublisher.status).toBe('up')
      expect(res.body.dependencies.horizon.status).toBe('up')
      expect(res.body.version).toBeDefined()
      expect(typeof res.body.version.gitSha).toBe('string')
      expect(typeof res.body.version.buildTimestamp).toBe('string')
      expect(typeof res.body.version.nodeVersion).toBe('string')
    })

    it('response includes latencyMs per dependency', async () => {
      const app = appWithHealth(allUp)
      const res = await request(app).get('/api/health')
      expect(typeof res.body.dependencies.postgres.latencyMs).toBe('number')
      expect(typeof res.body.dependencies.redis.latencyMs).toBe('number')
      expect(typeof res.body.dependencies.horizon.latencyMs).toBe('number')
    })

    it('returns 200 degraded when no deps configured', async () => {
      const app = appWithHealth({})
      const res = await request(app).get('/api/health')
      expect(res.status).toBe(200)
      expect(res.body.status).toBe('degraded')
      expect(res.body.dependencies.postgres.status).toBe('not_configured')
      expect(res.body.dependencies.redis.status).toBe('not_configured')
      expect(res.body.dependencies.horizonListener.status).toBe('not_configured')
      expect(res.body.dependencies.outboxPublisher.status).toBe('not_configured')
      expect(res.body.dependencies.horizon.status).toBe('not_configured')
    })

    it('returns 503 when postgres is down', async () => {
      const app = appWithHealth({
        ...allUp,
        postgres: async () => ({ status: 'down' }),
      })
      const res = await request(app).get('/api/health')
      expect(res.status).toBe(503)
      expect(res.body.status).toBe('unhealthy')
    })

    it('returns 503 when redis is down', async () => {
      const app = appWithHealth({
        ...allUp,
        redis: async () => ({ status: 'down' }),
      })
      const res = await request(app).get('/api/health')
      expect(res.status).toBe(503)
      expect(res.body.status).toBe('unhealthy')
    })

    it('returns 503 when horizon listener heartbeat is stale', async () => {
      const app = appWithHealth({
        ...allUp,
        horizonListener: async () => ({ status: 'down', reason: 'stale_heartbeat' }),
      })
      const res = await request(app).get('/api/health')
      expect(res.status).toBe(503)
      expect(res.body.dependencies.horizonListener.reason).toBe('stale_heartbeat')
    })

    it('returns 503 when outbox publisher is not running', async () => {
      const app = appWithHealth({
        ...allUp,
        outboxPublisher: async () => ({ status: 'down', reason: 'not_running' }),
      })
      const res = await request(app).get('/api/health')
      expect(res.status).toBe(503)
      expect(res.body.status).toBe('unhealthy')
      expect(res.body.dependencies.outboxPublisher.reason).toBe('not_running')
    })

    it('returns 503 when outbox publisher lag exceeds threshold', async () => {
      const app = appWithHealth({
        ...allUp,
        outboxPublisher: async () => ({ status: 'down', lagSeconds: OUTBOX_MAX_LAG_SECONDS + 1 }),
      })
      const res = await request(app).get('/api/health')
      expect(res.status).toBe(503)
      expect(res.body.status).toBe('unhealthy')
      expect(res.body.dependencies.outboxPublisher.status).toBe('down')
      expect(res.body.dependencies.outboxPublisher.lagSeconds).toBe(OUTBOX_MAX_LAG_SECONDS + 1)
    })

    it('returns 503 when horizon circuit breaker is OPEN', async () => {
      const app = appWithHealth({
        ...allUp,
        horizon: async () => ({ status: 'down', reason: 'circuit_open' }),
      })
      const res = await request(app).get('/api/health')
      expect(res.status).toBe(503)
      expect(res.body.status).toBe('unhealthy')
      expect(res.body.dependencies.horizon.reason).toBe('circuit_open')
    })

    it('returns 200 ok when horizon is HALF_OPEN (not fully open)', async () => {
      const app = appWithHealth({
        ...allUp,
        horizon: async () => ({ status: 'up', details: { circuitState: 'HALF_OPEN' } }),
      })
      const res = await request(app).get('/api/health')
      expect(res.status).toBe(200)
      expect(res.body.dependencies.horizon.details.circuitState).toBe('HALF_OPEN')
    })
  })

  describe('GET /api/health/ready', () => {
    it('behaves like GET /api/health', async () => {
      const app = appWithHealth({
        ...allUp,
        postgres: async () => ({ status: 'down' }),
      })
      const res = await request(app).get('/api/health/ready')
      expect(res.status).toBe(503)
      expect(res.body.status).toBe('unhealthy')
    })

    it('includes horizon dependency in /ready response', async () => {
      const app = appWithHealth(allUp)
      const res = await request(app).get('/api/health/ready')
      expect(res.status).toBe(200)
      expect(res.body.dependencies).toHaveProperty('horizon')
    })
  })

  describe('GET /api/health/dependencies', () => {
    it('returns dependencies object and 200 when up', async () => {
      const app = appWithHealth(allUp)
      const res = await request(app).get('/api/health/dependencies')
      expect(res.status).toBe(200)
      expect(res.body.postgres.status).toBe('up')
      expect(res.body.redis.status).toBe('up')
      expect(res.body).not.toHaveProperty('status', 'ok') // Not the full envelope
    })

    it('returns dependencies object and 503 when down', async () => {
      const app = appWithHealth({
        ...allUp,
        postgres: async () => ({ status: 'down' }),
      })
      const res = await request(app).get('/api/health/dependencies')
      expect(res.status).toBe(503)
      expect(res.body.postgres.status).toBe('down')
    })
  })

  describe('GET /api/health/live (liveness)', () => {
    it('returns 200 always even when all deps are down', async () => {
      const app = appWithHealth({
        postgres: async () => ({ status: 'down' }),
        redis: async () => ({ status: 'down' }),
        horizonListener: async () => ({ status: 'down' }),
        outboxPublisher: async () => ({ status: 'down' }),
        horizon: async () => ({ status: 'down' }),
      })
      const res = await request(app).get('/api/health/live')
      expect(res.status).toBe(200)
      expect(res.body.status).toBe('ok')
      expect(res.body.service).toBe('credence-backend')
      expect(res.body.version).toBeDefined()
      expect(typeof res.body.version.gitSha).toBe('string')
      expect(typeof res.body.version.buildTimestamp).toBe('string')
      expect(typeof res.body.version.nodeVersion).toBe('string')
    })

    it('does not include dependencies in /live response', async () => {
      const app = appWithHealth(allUp)
      const res = await request(app).get('/api/health/live')
      expect(res.body).not.toHaveProperty('dependencies')
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
