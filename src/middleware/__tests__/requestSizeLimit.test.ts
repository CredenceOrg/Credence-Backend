import { describe, it, expect, beforeEach } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import {
  jsonBodyParser,
  requestSizeLimitErrorHandler,
  MAX_REQUEST_BODY_BYTES,
} from '../requestSizeLimit.js'
import { errorHandler } from '../errorHandler.js'

describe('Request size-limit middleware', () => {
  let app: Express

  beforeEach(() => {
    process.env.NODE_ENV = 'test'
    app = express()
    app.use(jsonBodyParser)
    app.use(requestSizeLimitErrorHandler)
    app.post('/echo', (req, res) => {
      res.json({ received: req.body })
    })
    app.use(errorHandler)
  })

  it('accepts a JSON body under the 1 MiB limit', async () => {
    const res = await request(app).post('/echo').send({ hello: 'world' })

    expect(res.status).toBe(200)
    expect(res.body.received).toEqual({ hello: 'world' })
  })

  // Negative test: a body over 1 MiB must be rejected with the typed
  // REQUEST_TOO_LARGE error rather than being buffered/parsed. This fails
  // today (default express.json() neither caps at 1 MiB nor emits this code).
  it('rejects a JSON body over the 1 MiB limit with a typed REQUEST_TOO_LARGE error', async () => {
    const oversized = { payload: 'x'.repeat(MAX_REQUEST_BODY_BYTES + 1024) }

    const res = await request(app).post('/echo').send(oversized)

    expect(res.status).toBe(413)
    expect(res.body.code).toBe('request_too_large')
    expect(res.body.error_code).toBe('request_too_large')
  })
})
