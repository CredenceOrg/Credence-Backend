import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { sendError, ErrorCode } from './errors.js'
import { getErrorCatalogEntry } from './errorCatalog.js'

const makeApp = (handler: (req: express.Request, res: express.Response) => void) => {
  const app = express()
  app.get('/test', handler)
  return app
}

const withNodeEnv = async <T>(nodeEnv: string, fn: () => Promise<T>): Promise<T> => {
  const original = process.env.NODE_ENV
  process.env.NODE_ENV = nodeEnv
  try {
    return await fn()
  } finally {
    if (original === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = original
    }
  }
}

describe('sendError helper', () => {
  it('returns the standard error envelope with code and error_code', async () => {
    const app = makeApp((_req, res) => {
      sendError(res, ErrorCode.NOT_FOUND, 'Widget not found')
    })

    const res = await request(app).get('/test')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({
      error: 'Widget not found',
      code: 'not_found',
      error_code: 'not_found',
    })
  })

  it('uses the catalog default message in production', async () => {
    await withNodeEnv('production', async () => {
      const app = makeApp((_req, res) => {
        sendError(res, ErrorCode.VALIDATION_FAILED, 'Sensitive detail')
      })

      const res = await request(app).get('/test')
      expect(res.status).toBe(400)
      expect(res.body.error).toBe(getErrorCatalogEntry(ErrorCode.VALIDATION_FAILED).defaultMessage)
      expect(res.body.code).toBe('validation_failed')
      expect(res.body.error_code).toBe('validation_failed')
    })
  })

  it('omits details in production', async () => {
    await withNodeEnv('production', async () => {
      const app = makeApp((_req, res) => {
        sendError(res, ErrorCode.VALIDATION_FAILED, 'fail', [{ path: 'x', message: 'required' }])
      })

      const res = await request(app).get('/test')
      expect(res.body.details).toBeUndefined()
    })
  })

  it('includes details in non-production', async () => {
    const app = makeApp((_req, res) => {
      sendError(res, ErrorCode.VALIDATION_FAILED, 'fail', [{ path: 'x', message: 'required' }])
    })

    const res = await request(app).get('/test')
    expect(res.body.details).toEqual([{ path: 'x', message: 'required' }])
  })

  it('allows overriding the HTTP status', async () => {
    const app = makeApp((_req, res) => {
      sendError(res, ErrorCode.SERVICE_UNAVAILABLE, 'Not implemented', undefined, 501)
    })

    const res = await request(app).get('/test')
    expect(res.status).toBe(501)
    expect(res.body.code).toBe('service_unavailable')
    expect(res.body.error_code).toBe('service_unavailable')
  })

  it('uses catalog status when no override is provided', async () => {
    const app = makeApp((_req, res) => {
      sendError(res, ErrorCode.RATE_LIMIT_EXCEEDED, 'Too many requests')
    })

    const res = await request(app).get('/test')
    expect(res.status).toBe(429)
    expect(res.body.code).toBe('rate_limit_exceeded')
  })

  it('returns correct envelope for each major error category', async () => {
    const testCases: Array<{ code: ErrorCode; expectedStatus: number }> = [
      { code: ErrorCode.VALIDATION_FAILED, expectedStatus: 400 },
      { code: ErrorCode.UNAUTHORIZED, expectedStatus: 401 },
      { code: ErrorCode.FORBIDDEN, expectedStatus: 403 },
      { code: ErrorCode.NOT_FOUND, expectedStatus: 404 },
      { code: ErrorCode.CONFLICT, expectedStatus: 409 },
      { code: ErrorCode.RATE_LIMIT_EXCEEDED, expectedStatus: 429 },
      { code: ErrorCode.INTERNAL_SERVER_ERROR, expectedStatus: 500 },
      { code: ErrorCode.SERVICE_UNAVAILABLE, expectedStatus: 503 },
    ]

    for (const { code, expectedStatus } of testCases) {
      const app = makeApp((_req, res) => {
        sendError(res, code, `Test ${code}`)
      })

      const res = await request(app).get('/test')
      expect(res.status).toBe(expectedStatus)
      expect(typeof res.body.error).toBe('string')
      expect(res.body.code).toBe(getErrorCatalogEntry(code).code)
      expect(res.body.error_code).toBe(getErrorCatalogEntry(code).code)
    }
  })
})
