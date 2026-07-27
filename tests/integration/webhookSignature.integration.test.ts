import express from 'express'
import request from 'supertest'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'

import { verifyWebhookSignature } from '../../src/middleware/webhookSignature.js'
import { verifySignature, safeCompareHex } from '../../src/lib/webhookVerifier.js'

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

describe('webhook signature hardening — integration', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-06-25T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns 401 when signature header is empty string', async () => {
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

    const body = JSON.stringify({ event: 'test', timestamp: '2026-06-25T12:00:00.000Z' })
    const res = await request(app)
      .post('/webhook')
      .set('X-Webhook-Signature', '')
      .send(body)

    expect(res.status).toBe(401)
  })

  it('returns 401 when signature header is whitespace-only', async () => {
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

    const body = JSON.stringify({ event: 'test', timestamp: '2026-06-25T12:00:00.000Z' })
    const res = await request(app)
      .post('/webhook')
      .set('X-Webhook-Signature', '   ')
      .send(body)

    expect(res.status).toBe(401)
  })

  it('returns 401 when body is null', async () => {
    const app = express()
    app.use(express.json({ type: '*/*' }))
    app.post(
      '/webhook',
      verifyWebhookSignature({
        secret: 'test-secret',
        getBody: () => 'null',
      }),
      (_req, res) => res.status(200).json({ ok: true }),
    )

    const sig = sign('null', 'test-secret')
    const res = await request(app)
      .post('/webhook')
      .set('X-Webhook-Signature', `sha256=${sig}`)
      .send(null)

    expect(res.status).toBe(401)
  })

  it('returns 401 when secret function returns null', async () => {
    const app = express()
    app.use(express.text({ type: '*/*' }))
    app.post(
      '/webhook',
      verifyWebhookSignature({
        secret: () => null,
        getBody: (req) => (typeof req.body === 'string' ? req.body : ''),
      }),
      (_req, res) => res.status(200).json({ ok: true }),
    )

    const body = JSON.stringify({ event: 'test', timestamp: '2026-06-25T12:00:00.000Z' })
    const sig = sign(body, 'test-secret')
    const res = await request(app)
      .post('/webhook')
      .set('X-Webhook-Signature', `sha256=${sig}`)
      .send(body)

    expect(res.status).toBe(401)
  })

  it('returns 401 when secret function returns undefined', async () => {
    const app = express()
    app.use(express.text({ type: '*/*' }))
    app.post(
      '/webhook',
      verifyWebhookSignature({
        secret: () => undefined,
        getBody: (req) => (typeof req.body === 'string' ? req.body : ''),
      }),
      (_req, res) => res.status(200).json({ ok: true }),
    )

    const body = JSON.stringify({ event: 'test', timestamp: '2026-06-25T12:00:00.000Z' })
    const sig = sign(body, 'test-secret')
    const res = await request(app)
      .post('/webhook')
      .set('X-Webhook-Signature', `sha256=${sig}`)
      .send(body)

    expect(res.status).toBe(401)
  })

  it('rejects a mutated signature with constant-time behaviour', async () => {
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

    const body = JSON.stringify({ event: 'test', timestamp: '2026-06-25T12:00:00.000Z' })
    const sig = sign(body, 'test-secret')

    // flip one hex char — must fail
    const mutated = (parseInt(sig[0], 16) ^ 0xf).toString(16) + sig.slice(1)

    const res = await request(app)
      .post('/webhook')
      .set('X-Webhook-Signature', `sha256=${mutated}`)
      .send(body)

    expect(res.status).toBe(401)
  })

  it('accepts valid request through the full pipeline', async () => {
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

    const body = JSON.stringify({ event: 'test', timestamp: '2026-06-25T12:00:00.000Z' })
    const sig = sign(body, 'test-secret')

    const res = await request(app)
      .post('/webhook')
      .set('X-Webhook-Signature', `sha256=${sig}`)
      .send(body)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('safeCompareHex handles edge cases without throwing', () => {
    expect(safeCompareHex('a'.repeat(64), 'b'.repeat(64))).toBe(false)
    expect(safeCompareHex(null as unknown as string, 'abc')).toBe(false)
    expect(safeCompareHex('abc', undefined as unknown as string)).toBe(false)
    expect(safeCompareHex('', '')).toBe(false)
  })

  it('returns 401 when multiple signature headers are sent as array', async () => {
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

    const body = JSON.stringify({ event: 'test', timestamp: '2026-06-25T12:00:00.000Z' })
    const res = await request(app)
      .post('/webhook')
      .set('X-Webhook-Signature', ['sig1', 'sig2'])
      .send(body)

    expect(res.status).toBe(401)
  })

  it('return 401 when previous secret is used (no current secret match)', async () => {
    const app = express()
    app.use(express.text({ type: '*/*' }))
    app.post(
      '/webhook',
      verifyWebhookSignature({
        secret: 'current-secret',
        getBody: (req) => (typeof req.body === 'string' ? req.body : ''),
      }),
      (_req, res) => res.status(200).json({ ok: true }),
    )

    const body = JSON.stringify({ event: 'test', timestamp: '2026-06-25T12:00:00.000Z' })
    const sig = sign(body, 'previous-secret')

    const res = await request(app)
      .post('/webhook')
      .set('X-Webhook-Signature', `sha256=${sig}`)
      .send(body)

    expect(res.status).toBe(401) // middleware only uses current secret
  })

  it('verifySignature with both secrets returns ok:true when previous secret matches', () => {
    const body = JSON.stringify({ event: 'test', timestamp: '2026-06-25T12:00:00.000Z' })
    const sig = sign(body, 'previous-secret')
    const result = verifySignature(`sha256=${sig}`, body, 'current-secret', 'previous-secret')
    expect(result).toEqual({ ok: true })
  })
})
