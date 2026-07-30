import { describe, it, expect } from 'vitest'
import express, { type Request, type Response, type NextFunction } from 'express'
import request from 'supertest'
import { createSafeRedirectMiddleware } from '../safeRedirect.js'
import { AppError } from '../../lib/errors.js'

function createApp(allowedHosts: string[] = []) {
  const app = express()
  app.use(createSafeRedirectMiddleware({ allowedHosts }))

  app.get('/go', (req: Request, res: Response) => {
    const target = req.query.to as string
    res.redirect(target)
  })

  app.get('/go-with-status', (req: Request, res: Response) => {
    const target = req.query.to as string
    res.redirect(301, target)
  })

  app.get('/go-back', (_req: Request, res: Response) => {
    res.redirect('back')
  })

  // Mirrors the app's real errorHandler: AppError -> its catalog status/body.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.status).json(err.toJSON())
      return
    }
    res.status(500).json({ error: 'unexpected' })
  })

  return app
}

describe('createSafeRedirectMiddleware', () => {
  it('allows a safe relative redirect target', async () => {
    const app = createApp()
    const res = await request(app).get('/go').query({ to: '/dashboard' })
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('/dashboard')
  })

  it('allows a redirect with an explicit status code', async () => {
    const app = createApp()
    const res = await request(app).get('/go-with-status').query({ to: '/dashboard' })
    expect(res.status).toBe(301)
    expect(res.headers.location).toBe('/dashboard')
  })

  it('allows an absolute https URL whose host is on the allowlist', async () => {
    const app = createApp(['admin.credence.io'])
    const res = await request(app).get('/go').query({ to: 'https://admin.credence.io/dashboard' })
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('https://admin.credence.io/dashboard')
  })

  it('allows an absolute http URL whose host is on the allowlist', async () => {
    const app = createApp(['admin.credence.io'])
    const res = await request(app).get('/go').query({ to: 'http://admin.credence.io/dashboard' })
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('http://admin.credence.io/dashboard')
  })

  it('passes through the "back" keyword without validation', async () => {
    const app = createApp()
    const res = await request(app).get('/go-back').set('Referer', '/previous-page')
    expect(res.status).toBe(302)
  })

  it('allows an absolute URL with host on a multi-entry allowlist', async () => {
    const app = createApp(['first.com', 'admin.credence.io', 'last.com'])
    const res = await request(app).get('/go').query({ to: 'https://admin.credence.io/path' })
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('https://admin.credence.io/path')
  })

  it('allows an absolute URL matching a host:port entry in the allowlist', async () => {
    const app = createApp(['admin.credence.io:8443'])
    const res = await request(app).get('/go').query({ to: 'https://admin.credence.io:8443/callback' })
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('https://admin.credence.io:8443/callback')
  })

  it('allows a case-insensitive host match', async () => {
    const app = createApp(['ADMIN.CREDENCE.IO'])
    const res = await request(app).get('/go').query({ to: 'https://admin.credence.io/dashboard' })
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('https://admin.credence.io/dashboard')
  })

  // Negative test: this is the check that must fail before the fix (an
  // attacker-supplied `to` param would have been redirected to unmodified)
  // and pass after it (rejected with a typed 400 before any Location header
  // is sent).
  it('blocks an attacker-supplied protocol-relative redirect target', async () => {
    const app = createApp()
    const res = await request(app).get('/go').query({ to: '//evil.com' })
    expect(res.status).toBe(400)
    expect(res.headers.location).toBeUndefined()
    expect(res.body.code).toBe('unsafe_redirect_target')
  })

  it('blocks an absolute URL whose host is not on the allowlist', async () => {
    const app = createApp(['admin.credence.io'])
    const res = await request(app).get('/go').query({ to: 'https://evil.com/phish' })
    expect(res.status).toBe(400)
    expect(res.headers.location).toBeUndefined()
    expect(res.body.code).toBe('unsafe_redirect_target')
  })

  it('blocks an http URL whose host is not on the allowlist', async () => {
    const app = createApp(['admin.credence.io'])
    const res = await request(app).get('/go').query({ to: 'http://evil.com/phish' })
    expect(res.status).toBe(400)
    expect(res.headers.location).toBeUndefined()
    expect(res.body.code).toBe('unsafe_redirect_target')
  })

  it('blocks a backslash-trick redirect target', async () => {
    const app = createApp()
    const res = await request(app).get('/go').query({ to: '/\\evil.com' })
    expect(res.status).toBe(400)
    expect(res.headers.location).toBeUndefined()
  })

  it('blocks a javascript: URI', async () => {
    const app = createApp()
    const res = await request(app).get('/go').query({ to: 'javascript:alert(1)' })
    expect(res.status).toBe(400)
    expect(res.headers.location).toBeUndefined()
  })

  it('blocks an absolute URL with port mismatch', async () => {
    const app = createApp(['admin.credence.io'])
    const res = await request(app).get('/go').query({ to: 'https://admin.credence.io:8443/path' })
    expect(res.status).toBe(400)
    expect(res.headers.location).toBeUndefined()
  })

  it('blocks a subdomain when allowlist has the parent domain', async () => {
    const app = createApp(['credence.io'])
    const res = await request(app).get('/go').query({ to: 'https://sub.credence.io/path' })
    expect(res.status).toBe(400)
    expect(res.headers.location).toBeUndefined()
  })

  it('blocks an absolute URL when the allowlist is empty', async () => {
    const app = createApp()
    const res = await request(app).get('/go').query({ to: 'https://admin.credence.io/dashboard' })
    expect(res.status).toBe(400)
    expect(res.headers.location).toBeUndefined()
  })

  it('blocks a data: URI', async () => {
    const app = createApp()
    const res = await request(app).get('/go').query({ to: 'data:text/html,<script>alert(1)</script>' })
    expect(res.status).toBe(400)
    expect(res.headers.location).toBeUndefined()
  })
})
