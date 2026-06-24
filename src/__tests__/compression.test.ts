import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { compressionMiddleware, compressionMetricsMiddleware } from '../middleware/compression.js'
import { register } from '../middleware/metrics.js'

describe('Compression Middleware', () => {
  let app: express.Express

  beforeEach(async () => {
    register.resetMetrics()
    app = express()
    app.use(compressionMetricsMiddleware)
    app.use(compressionMiddleware)
    
    app.get('/large', (_req, res) => {
      res.json({ data: 'a'.repeat(2000) })
    })

    app.get('/small', (_req, res) => {
      res.json({ data: 'small' })
    })

    app.get('/stream', (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream')
      res.write('data: event\n\n')
      res.end()
    })

    app.get('/no-compress', (_req, res) => {
      res.setHeader('x-no-compression', 'true')
      res.json({ data: 'a'.repeat(2000) })
    })
  })

  it('should compress large payloads', async () => {
    const response = await request(app)
      .get('/large')
      .set('Accept-Encoding', 'gzip')
    
    expect(response.headers['content-encoding']).toBe('gzip')
    
    const metrics = await register.metrics()
    // Check if any metrics were recorded. The exact bucket depends on size.
    expect(metrics).toContain('http_response_size_bytes_bucket')
    expect(metrics).toContain('compressed="true"')
  })

  it('should NOT compress small payloads', async () => {
    const response = await request(app)
      .get('/small')
      .set('Accept-Encoding', 'gzip')
    
    expect(response.headers['content-encoding']).toBeUndefined()
    
    const metrics = await register.metrics()
    expect(metrics).toContain('compressed="false"')
  })

  it('should NOT compress streaming endpoints', async () => {
    const response = await request(app)
      .get('/stream')
      .set('Accept-Encoding', 'gzip')
    
    expect(response.headers['content-encoding']).toBeUndefined()
  })

  it('should respect x-no-compression header', async () => {
    const response = await request(app)
      .get('/no-compress')
      .set('Accept-Encoding', 'gzip')
      .set('x-no-compression', 'true')
    
    expect(response.headers['content-encoding']).toBeUndefined()
  })
})
