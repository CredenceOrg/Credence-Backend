import { describe, it, expect } from 'vitest'
import request from 'supertest'
import express from 'express'
import { createFaultInjectionRouter } from './faultInjection.js'
import {
  faultInjectionRequestSchema,
  faultInjectionResponseSchema,
} from '../schemas/faultInjection.js'

function appWithFaultInjection(devMode: boolean) {
  const app = express()
  app.use(express.json())
  app.use('/api/dev/fault-injection', createFaultInjectionRouter({ devMode }))
  return app
}

describe('Fault injection route', () => {
  describe('POST /api/dev/fault-injection', () => {
    describe('when DEV_MODE is enabled', () => {
      it('returns 500 by default with fault: true', async () => {
        const app = appWithFaultInjection(true)
        const res = await request(app)
          .post('/api/dev/fault-injection')
          .send({})

        expect(res.status).toBe(500)
        expect(res.body.fault).toBe(true)
        expect(res.body.statusCode).toBe(500)
        expect(typeof res.body.message).toBe('string')
      })

      it('returns the requested status code', async () => {
        const app = appWithFaultInjection(true)
        const res = await request(app)
          .post('/api/dev/fault-injection')
          .send({ statusCode: 503 })

        expect(res.status).toBe(503)
        expect(res.body.fault).toBe(true)
        expect(res.body.statusCode).toBe(503)
      })

      it('includes the custom message when provided', async () => {
        const app = appWithFaultInjection(true)
        const res = await request(app)
          .post('/api/dev/fault-injection')
          .send({ statusCode: 502, message: 'Gateway timeout simulation' })

        expect(res.status).toBe(502)
        expect(res.body.message).toBe('Gateway timeout simulation')
        expect(res.body.fault).toBe(true)
      })

      it('uses a default message when message is omitted', async () => {
        const app = appWithFaultInjection(true)
        const res = await request(app)
          .post('/api/dev/fault-injection')
          .send({ statusCode: 500 })

        expect(res.status).toBe(500)
        expect(res.body.message).toBe('Simulated fault (HTTP 500)')
      })

      it('returns 400 when statusCode is below 400', async () => {
        const app = appWithFaultInjection(true)
        const res = await request(app)
          .post('/api/dev/fault-injection')
          .send({ statusCode: 200 })

        expect(res.status).toBe(400)
        expect(res.body.error).toBe('Invalid request')
      })

      it('returns 400 when statusCode is above 599', async () => {
        const app = appWithFaultInjection(true)
        const res = await request(app)
          .post('/api/dev/fault-injection')
          .send({ statusCode: 600 })

        expect(res.status).toBe(400)
        expect(res.body.error).toBe('Invalid request')
      })

      it('response matches faultInjectionResponseSchema', async () => {
        const app = appWithFaultInjection(true)
        const res = await request(app)
          .post('/api/dev/fault-injection')
          .send({ statusCode: 500 })

        const result = faultInjectionResponseSchema.safeParse(res.body)
        expect(result.success).toBe(true)
      })

      it('accepts any valid 4xx status code', async () => {
        const app = appWithFaultInjection(true)
        for (const code of [400, 401, 403, 404, 429]) {
          const res = await request(app)
            .post('/api/dev/fault-injection')
            .send({ statusCode: code })

          expect(res.status).toBe(code)
          expect(res.body.fault).toBe(true)
        }
      })

      it('truncates messages longer than 512 characters', async () => {
        const app = appWithFaultInjection(true)
        const longMessage = 'a'.repeat(600)
        const res = await request(app)
          .post('/api/dev/fault-injection')
          .send({ statusCode: 500, message: longMessage })

        expect(res.status).toBe(400)
        expect(res.body.error).toBe('Invalid request')
      })
    })

    describe('when DEV_MODE is disabled', () => {
      it('returns 404', async () => {
        const app = appWithFaultInjection(false)
        const res = await request(app)
          .post('/api/dev/fault-injection')
          .send({})

        expect(res.status).toBe(404)
        expect(res.body.error).toBe('Not found')
      })

      it('returns 404 regardless of body content', async () => {
        const app = appWithFaultInjection(false)
        const res = await request(app)
          .post('/api/dev/fault-injection')
          .send({ statusCode: 500, message: 'test' })

        expect(res.status).toBe(404)
      })

      it('includes a stable machine-readable code on the 404 body', async () => {
        const app = appWithFaultInjection(false)
        const res = await request(app)
          .post('/api/dev/fault-injection')
          .send({})

        expect(res.body.code).toBe('not_found')
        expect(res.body.error_code).toBe('not_found')
      })
    })

    describe('when DEV_MODE is enabled', () => {
      it('includes a stable machine-readable code on the 400 validation body', async () => {
        const app = appWithFaultInjection(true)
        const res = await request(app)
          .post('/api/dev/fault-injection')
          .send({ statusCode: 200 })

        expect(res.status).toBe(400)
        expect(res.body.code).toBe('validation_failed')
        expect(res.body.error_code).toBe('validation_failed')
      })
    })
  })
})
