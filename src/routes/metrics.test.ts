import { describe, it, expect, beforeEach } from 'vitest'
import express, { Express } from 'express'
import request from 'supertest'
import metricsRouter from './metrics.js'
import { getMetricsService, resetMetricsService, MetricEvent } from '../services/metrics/index.js'

describe('GET /metrics', () => {
  let app: Express

  beforeEach(() => {
    resetMetricsService()
    app = express()
    app.use('/metrics', metricsRouter)
  })

  it('should return 200 OK', async () => {
    await request(app).get('/metrics').expect(200)
  })

  it('should return Prometheus text format', async () => {
    const response = await request(app).get('/metrics').expect(200)

    expect(response.headers['content-type']).toContain('text/plain')
    expect(response.headers['content-type']).toContain('version=0.0.4')
    expect(response.headers['content-type']).toContain('charset=utf-8')
  })

  it('should include HTTP metrics', async () => {
    const metricsService = getMetricsService()
    metricsService.recordHttpRequest({
      method: 'GET',
      route: '/api/test',
      statusCode: 200,
      durationMs: 45,
    })

    const response = await request(app).get('/metrics').expect(200)

    expect(response.text).toContain('http_request_duration_seconds')
    expect(response.text).toContain('http_requests_total')
  })

  it('should include business metrics', async () => {
    const metricsService = getMetricsService()
    metricsService.recordBusinessEvent(MetricEvent.BOND_CREATED, {
      address: 'GABC123',
    })
    metricsService.recordBusinessEvent(MetricEvent.BOND_SLASHED, {
      reason: 'fraud',
    })

    const response = await request(app).get('/metrics').expect(200)

    expect(response.text).toContain('bond_events_total')
    expect(response.text).toContain('slash_events_total')
  })

  it('should include gauge metrics', async () => {
    const metricsService = getMetricsService()
    metricsService.setActiveBonds(150)
    metricsService.setTotalBondedAmount(1000000)

    const response = await request(app).get('/metrics').expect(200)

    expect(response.text).toContain('active_bonds_count')
    expect(response.text).toContain('total_bonded_amount')
  })

  it('should include default Node.js metrics', async () => {
    const response = await request(app).get('/metrics').expect(200)

    expect(response.text).toContain('process_cpu_')
    expect(response.text).toContain('nodejs_')
  })

  it('should include HELP and TYPE comments', async () => {
    const response = await request(app).get('/metrics').expect(200)

    expect(response.text).toContain('# HELP')
    expect(response.text).toContain('# TYPE')
  })

  it('should return valid Prometheus format with labels', async () => {
    const metricsService = getMetricsService()
    metricsService.recordHttpRequest({
      method: 'POST',
      route: '/api/bulk/verify',
      statusCode: 200,
      durationMs: 120,
    })

    const response = await request(app).get('/metrics').expect(200)

    // Check for proper label formatting
    expect(response.text).toMatch(/method="POST"/)
    expect(response.text).toMatch(/route="\/api\/bulk\/verify"/)
    expect(response.text).toMatch(/status_code="200"/)
  })

  it('should handle empty metrics', async () => {
    const response = await request(app).get('/metrics').expect(200)

    // Should still return default metrics
    expect(response.text).toBeDefined()
    expect(response.text.length).toBeGreaterThan(0)
  })

  it('should return metrics for multiple events', async () => {
    const metricsService = getMetricsService()
    
    // Record various events
    metricsService.recordHttpRequest({
      method: 'GET',
      route: '/api/trust/:address',
      statusCode: 200,
      durationMs: 30,
    })
    metricsService.recordBusinessEvent(MetricEvent.SCORE_CALCULATED, {
      address: 'GABC123',
    })
    metricsService.recordBusinessEvent(MetricEvent.IDENTITY_VERIFIED, {
      status: 'success',
    })
    metricsService.setActiveBonds(75)

    const response = await request(app).get('/metrics').expect(200)

    expect(response.text).toContain('http_requests_total')
    expect(response.text).toContain('score_calculations_total')
    expect(response.text).toContain('identity_verifications_total')
    expect(response.text).toContain('active_bonds_count')
  })

  it('should be idempotent - multiple calls return consistent data', async () => {
    const metricsService = getMetricsService()
    metricsService.recordHttpRequest({
      method: 'GET',
      route: '/api/test',
      statusCode: 200,
      durationMs: 10,
    })

    const response1 = await request(app).get('/metrics').expect(200)
    const response2 = await request(app).get('/metrics').expect(200)

    // Both responses should contain the same recorded metric
    expect(response1.text).toContain('http_requests_total')
    expect(response2.text).toContain('http_requests_total')
  })
})
