import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { gracefulDegradeMiddleware } from '../gracefulDegrade.js'
import { errorHandler } from '../errorHandler.js'

describe('Graceful Degrade Middleware', () => {
  let app: express.Express

  beforeEach(() => {
    app = express()
    app.use(gracefulDegradeMiddleware)
    
    const handler = (req: express.Request, res: express.Response) => {
      res.json({ ok: true })
    }
    
    app.get('/test', handler)
    app.post('/test', handler)
    app.put('/test', handler)
    app.patch('/test', handler)
    app.delete('/test', handler)
    
    app.use(errorHandler)
  })

  describe('when X-Read-Only header is not present', () => {
    it('allows GET requests', async () => {
      const res = await request(app).get('/test')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true })
    })

    it('allows POST requests', async () => {
      const res = await request(app).post('/test')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true })
    })

    it('allows PUT requests', async () => {
      const res = await request(app).put('/test')
      expect(res.status).toBe(200)
    })

    it('allows PATCH requests', async () => {
      const res = await request(app).patch('/test')
      expect(res.status).toBe(200)
    })

    it('allows DELETE requests', async () => {
      const res = await request(app).delete('/test')
      expect(res.status).toBe(200)
    })
  })

  describe('when X-Read-Only header is "true"', () => {
    it('allows GET requests', async () => {
      const res = await request(app)
        .get('/test')
        .set('x-read-only', 'true')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true })
    })

    it('blocks POST requests with 503 and service_unavailable code', async () => {
      const res = await request(app)
        .post('/test')
        .set('x-read-only', 'true')
      expect(res.status).toBe(503)
      expect(res.body.code).toBe('service_unavailable')
      expect(res.body.error_code).toBe('service_unavailable')
    })

    it('blocks PUT requests with 503 and service_unavailable code', async () => {
      const res = await request(app)
        .put('/test')
        .set('x-read-only', 'true')
      expect(res.status).toBe(503)
      expect(res.body.code).toBe('service_unavailable')
    })

    it('blocks PATCH requests with 503 and service_unavailable code', async () => {
      const res = await request(app)
        .patch('/test')
        .set('x-read-only', 'true')
      expect(res.status).toBe(503)
      expect(res.body.code).toBe('service_unavailable')
    })

    it('blocks DELETE requests with 503 and service_unavailable code', async () => {
      const res = await request(app)
        .delete('/test')
        .set('x-read-only', 'true')
      expect(res.status).toBe(503)
      expect(res.body.code).toBe('service_unavailable')
    })
  })

  describe('when X-Read-Only header is "1"', () => {
    it('allows GET requests', async () => {
      const res = await request(app)
        .get('/test')
        .set('x-read-only', '1')
      expect(res.status).toBe(200)
    })

    it('blocks POST requests with 503 and service_unavailable code', async () => {
      const res = await request(app)
        .post('/test')
        .set('x-read-only', '1')
      expect(res.status).toBe(503)
      expect(res.body.code).toBe('service_unavailable')
    })
  })

  describe('when X-Read-Only header is "false" or other values', () => {
    it('allows POST requests when X-Read-Only is "false"', async () => {
      const res = await request(app)
        .post('/test')
        .set('x-read-only', 'false')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true })
    })

    it('allows POST requests when X-Read-Only is some other string', async () => {
      const res = await request(app)
        .post('/test')
        .set('x-read-only', 'arbitrary')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true })
    })
  })
})
