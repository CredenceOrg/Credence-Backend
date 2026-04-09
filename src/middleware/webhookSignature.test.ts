import express from 'express'
import request from 'supertest'
import { describe, it, expect } from 'vitest'
import { createHmac } from 'crypto'

import { verifyWebhookSignature } from './webhookSignature.js'

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

describe('verifyWebhookSignature', () => {
  it('returns 401 when signature header is missing', async () => {
    const app = express()
    app.use(express.text({ type: '*/*' }))
    app.post(
      '/webhook',
      verifyWebhookSignature({
        secret: 'test-secret',
        getBody: (req) => (typeof req.body === 'string' ? req.body : ''),
      }),
      (_req, res) => res.status(200).json({ ok: true }),
    )

    const res = await request(app).post('/webhook').send('{"hello":"world"}')
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 401 when signature header is malformed', async () => {
    const app = express()
    app.use(express.text({ type: '*/*' }))
    app.post(
      '/webhook',
      verifyWebhookSignature({
        secret: 'test-secret',
        getBody: (req) => (typeof req.body === 'string' ? req.body : ''),
      }),
      (_req, res) => res.status(200).json({ ok: true }),
    )

    const res = await request(app)
      .post('/webhook')
      .set('X-Webhook-Signature', 'sha256=not-hex')
      .send('{"hello":"world"}')

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Unauthorized' })
  })

  it('allows request through when signature is valid', async () => {
    const app = express()
    app.use(express.text({ type: '*/*' }))
    app.post(
      '/webhook',
      verifyWebhookSignature({
        secret: 'test-secret',
        getBody: (req) => (typeof req.body === 'string' ? req.body : ''),
      }),
      (_req, res) => res.status(200).json({ ok: true }),
    )

    const body = '{"hello":"world"}'
    const sig = sign(body, 'test-secret')

    const res = await request(app)
      .post('/webhook')
      .set('X-Webhook-Signature', `sha256=${sig}`)
      .send(body)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })
})

