import { describe, it, expect } from 'vitest'
import request from 'supertest'
import express from 'express'
import { createHealthRouter } from './health.js'

function appWithHealth(probes: Parameters<typeof createHealthRouter>[0] = {}) {
  const app = express()
  app.use('/api/health', createHealthRouter(probes))
  return app
}

describe('Health routes', () => {
  describe('GET /api/health (readiness)', () => {
    it('returns 200 and ok when all critical deps are up', async () => {
      const app = appWithHealth({
        db: async () => ({ status: 'up' }),
        redis: async () => ({ status: 'up' }),
      })
      const res = await request(app).get('/api/health')
      expect(res.status).toBe(200)
      expect(res.body.status).toBe('ok')
      expect(res.body.dependencies.db.status).toBe('up')
      expect(res.body.dependencies.redis.status).toBe('up')
    })

    it('returns 200 when no deps configured', async () => {
      const app = appWithHealth({})
      const res = await request(app).get('/api/health')
      expect(res.status).toBe(200)
      expect(res.body.status).toBe('ok')
      expect(res.body.dependencies.db.status).toBe('not_configured')
      expect(res.body.dependencies.redis.status).toBe('not_configured')
    })

    it('returns 503 when db is down', async () => {
      const app = appWithHealth({
        db: async () => ({ status: 'down' }),
        redis: async () => ({ status: 'up' }),
      })
      const res = await request(app).get('/api/health')
      expect(res.status).toBe(503)
      expect(res.body.status).toBe('unhealthy')
    })

    it('returns 503 when redis is down', async () => {
      const app = appWithHealth({
        db: async () => ({ status: 'up' }),
        redis: async () => ({ status: 'down' }),
      })
      const res = await request(app).get('/api/health')
      expect(res.status).toBe(503)
      expect(res.body.status).toBe('unhealthy')
    })

    it('returns 503 when both db and redis are down', async () => {
      const app = appWithHealth({
        db: async () => ({ status: 'down' }),
        redis: async () => ({ status: 'down' }),
      })
      const res = await request(app).get('/api/health')
      expect(res.status).toBe(503)
    })

    it('returns 200 when only external is down (degraded)', async () => {
      const app = appWithHealth({
        db: async () => ({ status: 'up' }),
        redis: async () => ({ status: 'up' }),
        external: async () => ({ status: 'down' }),
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
        redis: async () => ({ status: 'up' }),
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
        redis: async () => ({ status: 'down' }),
      })
      const res = await request(app).get('/api/health/live')
      expect(res.status).toBe(200)
      expect(res.body.status).toBe('ok')
      expect(res.body.service).toBe('credence-backend')
    })
  })
})
