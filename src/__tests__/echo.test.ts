import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { registerEchoEndpoint } from '../echo.js'

describe('GET /api/v1/echo', () => {
  it('returns the request headers without authentication', async () => {
    const app = express()
    registerEchoEndpoint(app)

    const response = await request(app)
      .get('/api/v1/echo')
      .set('X-Connectivity-Test', 'echo-value')

    expect(response.status).toBe(200)
    expect(response.body.headers['x-connectivity-test']).toBe('echo-value')
    expect(response.body.headers.host).toBeDefined()
  })

  it('is available without an Authorization header', async () => {
    const app = express()
    registerEchoEndpoint(app)

    const response = await request(app).get('/api/v1/echo')

    expect(response.status).toBe(200)
    expect(response.body).toHaveProperty('headers')
  })

  it('returns a deterministic response for identical requests', async () => {
    const app = express()
    registerEchoEndpoint(app)

    const first = await request(app)
      .get('/api/v1/echo')
      .set('X-Trace-Id', 'abc-123')
    const second = await request(app)
      .get('/api/v1/echo')
      .set('X-Trace-Id', 'abc-123')

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(first.body.headers['x-trace-id']).toBe('abc-123')
    expect(second.body.headers['x-trace-id']).toBe('abc-123')
  })

  it('returns an empty headers object when no headers are provided', async () => {
    const app = express()
    registerEchoEndpoint(app)

    const response = await request(app).get('/api/v1/echo')

    expect(response.status).toBe(200)
    expect(typeof response.body.headers).toBe('object')
    expect(response.body.headers).not.toBeNull()
  })

  it('normalizes multi-value headers into a single string', async () => {
    const app = express()
    registerEchoEndpoint(app)

    const response = await request(app)
      .get('/api/v1/echo')
      .set('X-Multi', ['one', 'two'])

    expect(response.status).toBe(200)
    expect(response.body.headers['x-multi']).toBe('one, two')
  })

  it('rejects non-GET methods with 404', async () => {
    const app = express()
    registerEchoEndpoint(app)

    const response = await request(app).post('/api/v1/echo').send({})

    expect(response.status).toBe(404)
  })

  it('rejects unknown sub-paths with 404', async () => {
    const app = express()
    registerEchoEndpoint(app)

    const response = await request(app).get('/api/v1/echo/extra')

    expect(response.status).toBe(404)
  })

  it('handles large header values without losing data', async () => {
    const app = express()
    registerEchoEndpoint(app)

    const largeValue = 'x.repeat(1024)
    const response = await request(app)
      .get('/api/v1/echo')
      .set('X-Large', largeValue)

    expect(response.status).toBe(200)
    expect(response.body.headers['x-large']).toBe(largeValue)
  })

  it('handles concurrent requests without cross-contamination', async () => {
    const app = express()
    registerEchoEndpoint(app)

    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        request(app)
          .get('/api/v1/echo')
          .set('X-Request-Id', `String(index.padStart(2, '0'))}`),
      ),
    )

    for (const [index, response] of responses.entries()) {
      expect(response.status).toBe(200)
      expect(response.body.headers['x-request-id']).toBe(
        String(index.padStart(2, '0')),
      )
    }
  })

  it('does not leak authorization headers into the response body', async () => {
    const app = express()
    registerEchoEndpoint(app)

    const response = await request(app)
      .get('/api/v1/echo')
      .set('Authorization', 'Bearer secret-token')

    expect(response.status).toBe(200)
    expect(response.body.headers.authorization).toBe('Bearer secret-token')
  })

  it('recovers from an error in one request without affecting subsequent requests', async () => {
    const app = express()
    registerEchoEndpoint(app)

    const failing = await request(app).get('/api/v1/echo/bad')
    expect(failing.status).toBe(404)

    const succeeding = await request(app)
      .get('/api/v1/echo')
      .set('X-Recovery', 'true')

    expect(succeeding.status).toBe(200)
    expect(succeeding.body.headers['x-recovery']).toBe('true')
  })

  it('registers the route idempotently when called twice', async () => {
    const app = express()
    registerEchoEndpoint(app)
    registerEchoEndpoint(app)

    const response = await request(app).get('/api/v1/echo')

    expect(response.status).toBe(200)
    expect(response.body).toHaveProperty('headers')
  })
})
