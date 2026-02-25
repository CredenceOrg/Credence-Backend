import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import express, { Express } from 'express'
import { metricsMiddleware } from '../middleware/metrics.js'
import metricsRouter from '../routes/metrics.js'
import { resetMetricsService } from '../services/metrics/index.js'

describe('Metrics Integration', () => {
  let app: Express

  beforeEach(() => {
    resetMetricsService()
    app = express()
    app.use(express.json())
    
    // Apply metrics middleware
    app.use(metricsMiddleware)

    // Add test routes
    app.get('/api/test', (_req, res) => {
      res.status(200).json({ message: 'ok' })
    })

    app.post('/api/test', (_req, res) => {
      res.status(201).json({ created: true })
    })

    app.get('/api/error', (_req, _res) => {
      throw new Error('Test error')
    })

    // Error handler
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err.message })
    })

    // Metrics endpoint
    app.use('/metrics', metricsRouter)
  })

  it('should track GET request and expose in metrics', async () => {
    // Make a request
    await request(app).get('/api/test').expect(200)

    // Check metrics
    const metricsResponse = await request(app).get('/metrics').expect(200)

    expect(metricsResponse.text).toContain('http_requests_total')
    expect(metricsResponse.text).toContain('method="GET"')
    expect(metricsResponse.text).toContain('route="/api/test"')
    expect(metricsResponse.text).toContain('status_code="200"')
  })

  it('should track POST request and expose in metrics', async () => {
    // Make a request
    await request(app).post('/api/test').send({ data: 'test' }).expect(201)

    // Check metrics
    const metricsResponse = await request(app).get('/metrics').expect(200)

    expect(metricsResponse.text).toContain('method="POST"')
    expect(metricsResponse.text).toContain('status_code="201"')
  })

  it('should track error responses', async () => {
    // Make a request that errors
    await request(app).get('/api/error').expect(500)

    // Check metrics
    const metricsResponse = await request(app).get('/metrics').expect(200)

    expect(metricsResponse.text).toContain('status_code="500"')
  })

  it('should track multiple requests', async () => {
    // Make multiple requests
    await request(app).get('/api/test').expect(200)
    await request(app).get('/api/test').expect(200)
    await request(app).post('/api/test').send({}).expect(201)

    // Check metrics
    const metricsResponse = await request(app).get('/metrics').expect(200)

    // Should contain both GET and POST metrics
    expect(metricsResponse.text).toContain('method="GET"')
    expect(metricsResponse.text).toContain('method="POST"')
  })

  it('should track request duration', async () => {
    // Make a request
    await request(app).get('/api/test').expect(200)

    // Check metrics
    const metricsResponse = await request(app).get('/metrics').expect(200)

    expect(metricsResponse.text).toContain('http_request_duration_seconds')
  })

  it('should track metrics endpoint requests', async () => {
    // Get metrics
    await request(app).get('/metrics').expect(200)
    
    // Get metrics again
    const metricsResponse = await request(app).get('/metrics').expect(200)

    // The metrics endpoint calls should be tracked
    expect(metricsResponse.text).toContain('route="/"')
    expect(metricsResponse.text).toContain('method="GET"')
  })

  it('should provide Prometheus-compatible format', async () => {
    // Make some requests
    await request(app).get('/api/test').expect(200)

    // Get metrics
    const metricsResponse = await request(app).get('/metrics').expect(200)

    // Check Prometheus format
    expect(metricsResponse.headers['content-type']).toContain('text/plain')
    expect(metricsResponse.text).toContain('# HELP')
    expect(metricsResponse.text).toContain('# TYPE')
    expect(metricsResponse.text).toMatch(/\w+{.*}/)
  })

  it('should include default Node.js metrics', async () => {
    const metricsResponse = await request(app).get('/metrics').expect(200)

    // Check for Node.js metrics
    expect(metricsResponse.text).toContain('process_cpu_')
    expect(metricsResponse.text).toContain('nodejs_')
    expect(metricsResponse.text).toContain('nodejs_heap_size_')
  })

  it('should handle concurrent requests', async () => {
    // Make concurrent requests
    await Promise.all([
      request(app).get('/api/test'),
      request(app).get('/api/test'),
      request(app).post('/api/test').send({}),
      request(app).get('/api/test'),
    ])

    // Check metrics
    const metricsResponse = await request(app).get('/metrics').expect(200)

    expect(metricsResponse.text).toContain('http_requests_total')
  })
})
