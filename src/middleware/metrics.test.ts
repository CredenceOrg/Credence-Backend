import { describe, it, expect, beforeEach, vi } from 'vitest'
import express, { Express } from 'express'
import request from 'supertest'
import { metricsMiddleware } from './metrics.js'
import { getMetricsService, resetMetricsService } from '../services/metrics/index.js'

describe('metricsMiddleware', () => {
  let app: Express

  beforeEach(() => {
    resetMetricsService()
    app = express()
    app.use(metricsMiddleware)
  })

  it('should track successful GET request', async () => {
    app.get('/test', (_req, res) => {
      res.status(200).json({ message: 'ok' })
    })

    await request(app).get('/test').expect(200)

    const metricsService = getMetricsService()
    const metrics = await metricsService.getMetrics()

    expect(metrics).toContain('http_requests_total')
    expect(metrics).toContain('method="GET"')
    expect(metrics).toContain('status_code="200"')
  })

  it('should track POST request', async () => {
    app.use(express.json())
    app.post('/test', (_req, res) => {
      res.status(201).json({ created: true })
    })

    await request(app).post('/test').send({ data: 'test' }).expect(201)

    const metricsService = getMetricsService()
    const metrics = await metricsService.getMetrics()

    expect(metrics).toContain('method="POST"')
    expect(metrics).toContain('status_code="201"')
  })

  it('should track 404 errors', async () => {
    await request(app).get('/nonexistent').expect(404)

    const metricsService = getMetricsService()
    const metrics = await metricsService.getMetrics()

    expect(metrics).toContain('status_code="404"')
  })

  it('should track 500 errors', async () => {
    app.get('/error', (_req, _res) => {
      throw new Error('Test error')
    })

    // Add error handler
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err.message })
    })

    await request(app).get('/error').expect(500)

    const metricsService = getMetricsService()
    const metrics = await metricsService.getMetrics()

    expect(metrics).toContain('status_code="500"')
  })

  it('should record request duration', async () => {
    app.get('/slow', async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      res.status(200).json({ message: 'done' })
    })

    await request(app).get('/slow').expect(200)

    const metricsService = getMetricsService()
    const metrics = await metricsService.getMetrics()

    expect(metrics).toContain('http_request_duration_seconds')
  })

  it('should normalize route with address parameter', async () => {
    app.get('/api/trust/:address', (_req, res) => {
      res.status(200).json({ address: 'GABC123' })
    })

    await request(app).get('/api/trust/GABC123').expect(200)

    const metricsService = getMetricsService()
    const metrics = await metricsService.getMetrics()

    expect(metrics).toContain('route="/api/trust/:address"')
  })

  it('should normalize route with bond parameter', async () => {
    app.get('/api/bond/:address', (_req, res) => {
      res.status(200).json({ address: 'GDEF456' })
    })

    await request(app).get('/api/bond/GDEF456').expect(200)

    const metricsService = getMetricsService()
    const metrics = await metricsService.getMetrics()

    expect(metrics).toContain('route="/api/bond/:address"')
  })

  it('should track multiple requests', async () => {
    app.get('/test', (_req, res) => {
      res.status(200).json({ message: 'ok' })
    })

    await request(app).get('/test').expect(200)
    await request(app).get('/test').expect(200)
    await request(app).get('/test').expect(200)

    const metricsService = getMetricsService()
    const metrics = await metricsService.getMetrics()

    // Should have recorded 3 requests
    expect(metrics).toContain('http_requests_total')
  })

  it('should track requests to different routes', async () => {
    app.get('/route1', (_req, res) => {
      res.status(200).json({ route: 1 })
    })
    app.get('/route2', (_req, res) => {
      res.status(200).json({ route: 2 })
    })

    await request(app).get('/route1').expect(200)
    await request(app).get('/route2').expect(200)

    const metricsService = getMetricsService()
    const metrics = await metricsService.getMetrics()

    expect(metrics).toContain('route="/route1"')
    expect(metrics).toContain('route="/route2"')
  })

  it('should not interfere with response body', async () => {
    app.get('/test', (_req, res) => {
      res.status(200).json({ message: 'test', data: [1, 2, 3] })
    })

    const response = await request(app).get('/test').expect(200)

    expect(response.body).toEqual({ message: 'test', data: [1, 2, 3] })
  })

  it('should handle routes without Express route definition', async () => {
    app.use((_req, res) => {
      res.status(200).json({ message: 'catch-all' })
    })

    await request(app).get('/any/path').expect(200)

    const metricsService = getMetricsService()
    const metrics = await metricsService.getMetrics()

    expect(metrics).toContain('http_requests_total')
  })
})
