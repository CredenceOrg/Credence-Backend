import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import cspReportRouter from './cspReport.js'
import { errorHandler } from '../middleware/errorHandler.js'

function setupApp() {
  const app = express()
  app.use(cspReportRouter)
  app.use(errorHandler)
  return app
}

describe('CSP Report Router', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('POST /csp-report', () => {
    it('accepts and logs a valid CSP report payload', async () => {
      const validPayload = {
        'csp-report': {
          'document-uri': 'http://example.com/index.html',
          'referrer': 'http://example.com/referrer',
          'blocked-uri': 'http://evil.com/malicious.js',
          'violated-directive': "script-src 'self'",
          'effective-directive': 'script-src',
          'original-policy': "default-src 'self'; script-src 'self'; report-uri /csp-report",
          'disposition': 'report',
          'status-code': 200,
          'script-sample': 'alert(1)',
        },
      }

      const res = await request(setupApp())
        .post('/csp-report')
        .set('Content-Type', 'application/csp-report')
        .send(JSON.stringify(validPayload))

      expect(res.status).toBe(204)
    })

    it('rejects an invalid payload with a validation error', async () => {
      const invalidPayload = {
        'csp-report': {
          'referrer': 'http://example.com/referrer',
        },
      }

      const res = await request(setupApp())
        .post('/csp-report')
        .set('Content-Type', 'application/json')
        .send(invalidPayload)

      expect(res.status).toBe(400)
      expect(res.body.error_code).toBe('validation_failed')
      expect(res.body.details).toBeDefined()
    })
  })
})
