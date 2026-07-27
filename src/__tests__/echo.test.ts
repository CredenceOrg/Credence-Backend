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
})
