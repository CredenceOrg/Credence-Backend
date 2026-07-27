import { describe, it, expect } from 'vitest'
import request from 'supertest'
import express from 'express'
import { createFaultInjectionRouter } from '../../src/routes/faultInjection.js'
import { faultInjectionResponseSchema } from '../../src/schemas/faultInjection.js'

function appWithFaultInjection(devMode: boolean) {
  const app = express()
  app.use(express.json())
  app.use('/api/dev/fault-injection', createFaultInjectionRouter({ devMode }))
  return app
}

describe('Fault injection – contract tests', () => {
  it('returns 500 with valid faultInjectionResponseSchema by default', async () => {
    const app = appWithFaultInjection(true)
    const res = await request(app)
      .post('/api/dev/fault-injection')
      .send({})

    expect(res.status).toBe(500)
    const parsed = faultInjectionResponseSchema.safeParse(res.body)
    expect(parsed.success).toBe(true)
  })

  it('returns 503 when requested and matches schema', async () => {
    const app = appWithFaultInjection(true)
    const res = await request(app)
      .post('/api/dev/fault-injection')
      .send({ statusCode: 503, message: 'Service unavailable' })

    expect(res.status).toBe(503)
    expect(res.body.fault).toBe(true)
    expect(res.body.message).toBe('Service unavailable')
    const parsed = faultInjectionResponseSchema.safeParse(res.body)
    expect(parsed.success).toBe(true)
  })

  it('is hidden behind DEV_MODE flag', async () => {
    const app = appWithFaultInjection(false)
    const res = await request(app)
      .post('/api/dev/fault-injection')
      .send({ statusCode: 500 })

    expect(res.status).toBe(404)
  })

  it('rejects invalid status codes', async () => {
    const app = appWithFaultInjection(true)
    const res = await request(app)
      .post('/api/dev/fault-injection')
      .send({ statusCode: 302 })

    expect(res.status).toBe(400)
  })
})
