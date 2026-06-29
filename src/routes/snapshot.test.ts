import { describe, it, expect } from 'vitest'
import request from 'supertest'
import express from 'express'
import { createSnapshotRouter, type SnapshotRouterOptions } from './snapshot.js'
import type { AnalyticsResponse } from '../services/analytics/service.js'

function appWithSnapshot(options: SnapshotRouterOptions = {}) {
  const app = express()
  app.use('/api/snapshot', createSnapshotRouter(options))
  return app
}

const allUpProbes: SnapshotRouterOptions['healthProbes'] = {
  postgres: async () => ({ status: 'up', latencyMs: 1 }),
  redis: async () => ({ status: 'up', latencyMs: 1 }),
}

const mockAnalyticsResponse: AnalyticsResponse = {
  metrics: {
    activeIdentities: 42,
    totalIdentities: 100,
    avgTotalScore: 75.5,
    latestScoreCalculatedAt: '2024-01-01T00:00:00.000Z',
  },
  staleness: {
    asOf: '2024-01-01T00:00:00.000Z',
    ageSeconds: 10,
    fresh: true,
    refreshStatus: 'ok',
  },
}

describe('GET /api/snapshot', () => {
  it('returns 200 with generatedAt, health, and analytics fields', async () => {
    const analyticsService = { getSummary: async () => mockAnalyticsResponse } as any
    const app = appWithSnapshot({ healthProbes: allUpProbes, analyticsService })

    const res = await request(app).get('/api/snapshot')

    expect(res.status).toBe(200)
    expect(res.body.generatedAt).toBeDefined()
    expect(new Date(res.body.generatedAt).getTime()).not.toBeNaN()
    expect(res.body.health).toBeDefined()
    expect(res.body.analytics).toBeDefined()
  })

  it('reflects health status from probes', async () => {
    const analyticsService = { getSummary: async () => mockAnalyticsResponse } as any
    const app = appWithSnapshot({ healthProbes: allUpProbes, analyticsService })

    const res = await request(app).get('/api/snapshot')

    expect(res.body.health.status).toBe('ok')
  })

  it('maps analytics metrics into the snapshot', async () => {
    const analyticsService = { getSummary: async () => mockAnalyticsResponse } as any
    const app = appWithSnapshot({ healthProbes: allUpProbes, analyticsService })

    const res = await request(app).get('/api/snapshot')

    expect(res.body.analytics).toEqual({
      activeIdentities: 42,
      totalIdentities: 100,
      avgTotalScore: 75.5,
      fresh: true,
    })
  })

  it('returns analytics: null when no analyticsService is provided', async () => {
    const app = appWithSnapshot({ healthProbes: allUpProbes })

    const res = await request(app).get('/api/snapshot')

    expect(res.status).toBe(200)
    expect(res.body.analytics).toBeNull()
  })

  it('returns 200 with unhealthy health status when all probes are down', async () => {
    const downProbes: SnapshotRouterOptions['healthProbes'] = {
      postgres: async () => ({ status: 'down', reason: 'connection_refused' }),
    }
    const app = appWithSnapshot({ healthProbes: downProbes })

    const res = await request(app).get('/api/snapshot')

    expect(res.status).toBe(200)
    expect(res.body.health.status).toBe('unhealthy')
  })

  it('returns analytics: null when analyticsService throws', async () => {
    const analyticsService = { getSummary: async () => { throw new Error('DB unavailable') } } as any
    const app = appWithSnapshot({ healthProbes: allUpProbes, analyticsService })

    const res = await request(app).get('/api/snapshot')

    expect(res.status).toBe(200)
    expect(res.body.analytics).toBeNull()
  })

  it('returns 200 with no options (no probes, no analytics)', async () => {
    const app = appWithSnapshot()
    const res = await request(app).get('/api/snapshot')
    expect(res.status).toBe(200)
    expect(res.body.health.status).toBe('degraded')
    expect(res.body.analytics).toBeNull()
  })
})
