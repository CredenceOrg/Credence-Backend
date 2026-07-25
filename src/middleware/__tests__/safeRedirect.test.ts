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

  it('allows an absolute URL whose host is on the allowlist', async () => {
    const app = createApp(['admin.credence.io'])
    const res = await request(app).get('/go').query({ to: 'https://admin.credence.io/dashboard' })
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('https://admin.credence.io/dashboard')
  })

  it('passes through the "back" keyword without validation', async () => {
    const app = createApp()
    const res = await request(app).get('/go-back').set('Referer', '/previous-page')
    expect(res.status).toBe(302)
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
})
