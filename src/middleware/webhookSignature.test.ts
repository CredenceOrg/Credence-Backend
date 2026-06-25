import express from 'express'
import request from 'supertest'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'crypto'

import { verifyWebhookSignature } from './webhookSignature.js'

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

describe('verifyWebhookSignature', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-06-25T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

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

    const body = JSON.stringify({
      hello: 'world',
      timestamp: '2026-06-25T12:00:00.000Z'
    })
    const sig = sign(body, 'test-secret')

    const res = await request(app)
      .post('/webhook')
      .set('X-Webhook-Signature', `sha256=${sig}`)
      .send(body)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  describe('replay protection with fake timers', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-06-25T12:00:00.000Z'))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('returns 401 when timestamp is missing', async () => {
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

      expect(res.status).toBe(401)
    })

    it('returns 401 when timestamp is expired', async () => {
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

      const expiredBody = JSON.stringify({
        event: 'bond.created',
        timestamp: '2026-06-25T11:50:00.000Z', // 10 mins ago
        data: {}
      })
      const sig = sign(expiredBody, 'test-secret')

      const res = await request(app)
        .post('/webhook')
        .set('X-Webhook-Signature', `sha256=${sig}`)
        .send(expiredBody)

      expect(res.status).toBe(401)
    })

    it('allows request with valid signature and within custom tolerance', async () => {
      const app = express()
      app.use(express.text({ type: '*/*' }))
      app.post(
        '/webhook',
        verifyWebhookSignature({
          secret: 'test-secret',
          tolerance: 60000, // 1 min tolerance
          getBody: (req) => (typeof req.body === 'string' ? req.body : ''),
        }),
        (_req, res) => res.status(200).json({ ok: true }),
      )

      const body = JSON.stringify({
        event: 'bond.created',
        timestamp: '2026-06-25T11:59:30.000Z', // 30s ago
        data: {}
      })
      const sig = sign(body, 'test-secret')

      const res = await request(app)
        .post('/webhook')
        .set('X-Webhook-Signature', `sha256=${sig}`)
        .send(body)

      expect(res.status).toBe(200)
    })
  })
})

