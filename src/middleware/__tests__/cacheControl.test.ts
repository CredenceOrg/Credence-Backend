import { describe, it, expect, beforeEach } from 'vitest'
import express, { type Express, type Request, type Response, type NextFunction } from 'express'
import request from 'supertest'
import { cacheControlMiddleware } from '../cacheControl.js'

describe('Cache-Control middleware', () => {
  let app: Express

  beforeEach(() => {
    app = express()
    app.use(cacheControlMiddleware)
  })

  describe('privileged requests (identity attached by auth middleware)', () => {
    it('sets Cache-Control: no-store when req.user is present (authenticated session)', async () => {
      app.use((req: Request, _res: Response, next: NextFunction) => {
        ;(req as any).user = { id: 'admin-1', role: 'admin' }
        next()
      })
      app.get('/api/admin/users', (_req, res) => {
        res.json({ success: true, data: [] })
      })

      const response = await request(app).get('/api/admin/users')

      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.headers['pragma']).toBe('no-cache')
    })

    it('sets Cache-Control: no-store when req.apiKey is present (enforced API key)', async () => {
      app.use((req: Request, _res: Response, next: NextFunction) => {
        ;(req as any).apiKey = { key: 'test-payouts-write-key', scopes: ['payouts:write'] }
        next()
      })
      app.get('/api/payouts', (_req, res) => {
        res.json({ success: true, data: [] })
      })

      const response = await request(app).get('/api/payouts')

      expect(response.headers['cache-control']).toBe('no-store')
    })

    it('sets Cache-Control: no-store when req.apiKeyRecord is present', async () => {
      app.use((req: Request, _res: Response, next: NextFunction) => {
        ;(req as any).apiKeyRecord = { key: 'k', scopes: ['write'] }
        next()
      })
      app.get('/api/bond', (_req, res) => {
        res.json({ success: true })
      })

      const response = await request(app).get('/api/bond')

      expect(response.headers['cache-control']).toBe('no-store')
    })

    it('defaults to no-store for known privileged path prefixes even without an identity property', async () => {
      // Defence-in-depth: a route added under /api/admin that forgets to wire
      // up auth should still not leak into shared caches.
      app.get('/api/admin/anything', (_req, res) => {
        res.json({ success: true })
      })

      const response = await request(app).get('/api/admin/anything')

      expect(response.headers['cache-control']).toBe('no-store')
    })

    it('THE NEGATIVE CASE: a privileged, authenticated response is not cacheable', async () => {
      // This is the scenario the fix closes: an admin endpoint returning
      // sensitive data (here standing in for an audit-log export) must never
      // be eligible for storage in a shared HTTP cache or the browser
      // back/forward cache. Before this middleware existed, no Cache-Control
      // header was set at all on this response, so it was heuristically
      // cacheable by intermediaries and the browser's disk cache.
      app.use((req: Request, _res: Response, next: NextFunction) => {
        ;(req as any).user = { id: 'admin-1', role: 'admin', email: 'admin@credence.org' }
        next()
      })
      app.get('/api/admin/audit-logs', (_req, res) => {
        res.json({ success: true, data: { logs: [{ id: 1, actorId: 'admin-1' }] } })
      })

      const response = await request(app).get('/api/admin/audit-logs')

      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.headers['cache-control']).not.toBe('public, max-age=60')
      expect(response.headers['cache-control']).not.toBeUndefined()
    })
  })

  describe('non-privileged requests', () => {
    it('does not set Cache-Control on an unauthenticated, non-privileged route', async () => {
      app.get('/api/health', (_req, res) => {
        res.json({ status: 'ok' })
      })

      const response = await request(app).get('/api/health')

      expect(response.headers['cache-control']).toBeUndefined()
    })
  })

  describe('explicit route overrides', () => {
    it('does not clobber a Cache-Control header the route set explicitly', async () => {
      app.use((req: Request, _res: Response, next: NextFunction) => {
        ;(req as any).apiKey = { key: 'test-trust-read-key', scopes: ['trust:read'] }
        next()
      })
      app.get('/api/trust/:address', (_req, res) => {
        res.set('Cache-Control', 'public, max-age=60')
        res.json({ score: 42 })
      })

      const response = await request(app).get('/api/trust/GABC123')

      expect(response.headers['cache-control']).toBe('public, max-age=60')
    })

    it('leaves a non-default Cache-Control set on a privileged path prefix untouched', async () => {
      app.get('/api/admin/public-config', (_req, res) => {
        res.set('Cache-Control', 'public, max-age=3600')
        res.json({ feature: 'on' })
      })

      const response = await request(app).get('/api/admin/public-config')

      expect(response.headers['cache-control']).toBe('public, max-age=3600')
    })
  })

  describe('res.send / res.end compatibility', () => {
    it('applies no-store when the handler uses res.send instead of res.json', async () => {
      app.use((req: Request, _res: Response, next: NextFunction) => {
        ;(req as any).user = { id: 'admin-1', role: 'admin' }
        next()
      })
      app.get('/api/admin/ping', (_req, res) => {
        res.send('pong')
      })

      const response = await request(app).get('/api/admin/ping')

      expect(response.headers['cache-control']).toBe('no-store')
    })
  })
})
