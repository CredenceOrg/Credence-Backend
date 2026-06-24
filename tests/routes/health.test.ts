import { describe, it, expect } from 'vitest'
import request from 'supertest'
import express from 'express'
import { createHealthRouter } from '../../src/routes/health.js'

function appWithHealth(probes: Parameters<typeof createHealthRouter>[0] = {}) {
  const app = express()
  app.use('/api/health', createHealthRouter(probes))
  return app
}

describe('Health route – dependency-aware checks with degradation reasons', () => {
  it('includes reason when postgres is down', async () => {
    const app = appWithHealth({
      postgres: async () => ({ status: 'down', reason: 'connection_refused' }),
      redis: async () => ({ status: 'up' }),
      horizonListener: async () => ({ status: 'up' }),
      outboxPublisher: async () => ({ status: 'up' }),
    })
    const res = await request(app).get('/api/health')
    expect(res.status).toBe(503)
    expect(res.body.status).toBe('unhealthy')
    expect(res.body.dependencies.postgres.status).toBe('down')
    expect(res.body.dependencies.postgres.reason).toBe('connection_refused')
  })

  it('includes reason when redis is down', async () => {
    const app = appWithHealth({
      postgres: async () => ({ status: 'up' }),
      redis: async () => ({ status: 'down', reason: 'timeout' }),
      horizonListener: async () => ({ status: 'up' }),
      outboxPublisher: async () => ({ status: 'up' }),
    })
    const res = await request(app).get('/api/health')
    expect(res.status).toBe(503)
    expect(res.body.dependencies.redis.reason).toBe('timeout')
  })

  it('includes reason when horizon listener heartbeat is stale', async () => {
    const app = appWithHealth({
      postgres: async () => ({ status: 'up' }),
      redis: async () => ({ status: 'up' }),
      horizonListener: async () => ({ status: 'down', reason: 'stale_heartbeat' }),
      outboxPublisher: async () => ({ status: 'up' }),
    })
    const res = await request(app).get('/api/health')
    expect(res.status).toBe(503)
    expect(res.body.dependencies.horizonListener.reason).toBe('stale_heartbeat')
  })

  it('includes reason when outbox publisher is down', async () => {
    const app = appWithHealth({
      postgres: async () => ({ status: 'up' }),
      redis: async () => ({ status: 'up' }),
      horizonListener: async () => ({ status: 'up' }),
      outboxPublisher: async () => ({ status: 'down', reason: 'not_running' }),
    })
    const res = await request(app).get('/api/health')
    expect(res.status).toBe(503)
    expect(res.body.status).toBe('unhealthy')
    expect(res.body.dependencies.outboxPublisher.reason).toBe('not_running')
  })

  it('omits reason when dependency is up', async () => {
    const app = appWithHealth({
      postgres: async () => ({ status: 'up' }),
      redis: async () => ({ status: 'up' }),
      horizonListener: async () => ({ status: 'up' }),
      outboxPublisher: async () => ({ status: 'up' }),
    })
    const res = await request(app).get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body.dependencies.postgres.reason).toBeUndefined()
    expect(res.body.dependencies.redis.reason).toBeUndefined()
  })

  it('schema is stable: always has status, service, dependencies keys', async () => {
    const app = appWithHealth({})
    const res = await request(app).get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('status')
    expect(res.body).toHaveProperty('service', 'credence-backend')
    expect(res.body).toHaveProperty('dependencies')
    expect(res.body.dependencies).toHaveProperty('postgres')
    expect(res.body.dependencies).toHaveProperty('redis')
    expect(res.body.dependencies).toHaveProperty('horizonListener')
    expect(res.body.dependencies).toHaveProperty('outboxPublisher')
  })

  it('/ready also propagates reason', async () => {
    const app = appWithHealth({
      postgres: async () => ({ status: 'down', reason: 'timeout' }),
      redis: async () => ({ status: 'up' }),
      horizonListener: async () => ({ status: 'up' }),
      outboxPublisher: async () => ({ status: 'up' }),
    })
    const res = await request(app).get('/api/health/ready')
    expect(res.status).toBe(503)
    expect(res.body.dependencies.postgres.reason).toBe('timeout')
  })

  it('/live never includes dependency details', async () => {
    const app = appWithHealth({
      postgres: async () => ({ status: 'down', reason: 'connection_refused' }),
      redis: async () => ({ status: 'down', reason: 'timeout' }),
      horizonListener: async () => ({ status: 'down', reason: 'stale_heartbeat' }),
      outboxPublisher: async () => ({ status: 'down', reason: 'not_running' }),
    })
    const res = await request(app).get('/api/health/live')
    expect(res.status).toBe(200)
    expect(res.body).not.toHaveProperty('dependencies')
  })
})
