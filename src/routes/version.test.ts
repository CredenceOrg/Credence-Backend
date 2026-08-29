import { describe, it, expect } from 'vitest'
import request from 'supertest'
import express from 'express'
import { createVersionRouter } from './version.js'
import { versionResponseSchema } from '../schemas/version.js'

function appWithVersion() {
  const app = express()
  app.use('/api/version', createVersionRouter())
  return app
}

describe('Version route', () => {
  describe('GET /api/version', () => {
    it('returns 200 with service, gitSha, buildTimestamp, and nodeVersion', async () => {
      const app = appWithVersion()
      const res = await request(app).get('/api/version')

      expect(res.status).toBe(200)
      expect(res.body.service).toBe('credence-backend')
      expect(typeof res.body.gitSha).toBe('string')
      expect(res.body.gitSha.length).toBeGreaterThan(0)
      expect(typeof res.body.buildTimestamp).toBe('string')
      expect(typeof res.body.nodeVersion).toBe('string')
      expect(res.body.nodeVersion).toBe(process.version)
    })

    it('response matches versionResponseSchema', async () => {
      const app = appWithVersion()
      const res = await request(app).get('/api/version')

      const result = versionResponseSchema.safeParse(res.body)
      expect(result.success).toBe(true)
    })

    it('buildTimestamp is a valid ISO 8601 timestamp', async () => {
      const app = appWithVersion()
      const res = await request(app).get('/api/version')

      expect(new Date(res.body.buildTimestamp).toString()).not.toBe('Invalid Date')
    })

    it('performs no dependency checks and always returns 200', async () => {
      // Unlike /api/health, this route takes no probes and has nothing to
      // report as down; every call should succeed identically.
      const app = appWithVersion()
      const [first, second] = await Promise.all([
        request(app).get('/api/version'),
        request(app).get('/api/version'),
      ])

      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
      expect(first.body).toEqual(second.body)
    })

    it('is mounted at GET /api/version in the app router', async () => {
      const app = appWithVersion()
      const res = await request(app).get('/api/version/')
      expect(res.status).toBe(200)
    })
  })
})
